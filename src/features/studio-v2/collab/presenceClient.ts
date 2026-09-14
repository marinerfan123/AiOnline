// ── W5-pre — presence client (thin read + heartbeat + leave) ──────────────────
//
// Thin client over the LIVE server presence contract. Contract is pinned to the
// server routes that actually exist (read from source, not runtime — see the
// "契约结论" notes below and presenceApi.cjs / presenceBus.cjs / collabContract.cjs):
//
//   POST /api/v2/presence/heartbeat         body { canvasId, state }
//        state ∈ online | away | editing | offline  (busy is a legacy alias the
//        SERVER normalizes to editing — the client never sends busy).
//        userId is derived from the session server-side; the client does NOT
//        send userId (the server ignores a spoofed body.userId).
//        → 200 { ok: true, presence: { userId, canvasId, state, lastSeenMs } | null }
//   GET  /api/v2/presence/peers/:canvasId
//        → 200 { ok: true, canvasId, peers: [{ userId, state, lastSeenMs }] }
//
// ── 契约结论 (authoritative, read from server source) ─────────────────────────
// 1. presence is addressed by **canvasId only** — there is NO projectId on the
//    wire (collabContract.cjs documents presence as (actorId, projectId) but the
//    implemented bus/store/api all key by canvasId). getPresence therefore takes
//    { canvasId }.
// 2. the peer read surface is exactly { userId, state, lastSeenMs }. There are
//    NO cursor / selection fields on the wire. "最后活跃" maps to lastSeenMs
//    (epoch ms, or null when the server omits it). If the server later adds
//    cursor/selection, the tolerant parsers below ignore unknown fields rather
//    than crash.
// 3. there is NO dedicated leave endpoint — leave is heartbeat(state='offline'),
//    which removes the (canvas, user) record server-side and echoes presence:null.
// 4. heartbeat carries NO cursor — the request body is { canvasId, state }.
//    Sending userId/cursor would be ignored (userId) or dropped (unknown field).
//
// TTL semantics (collabContract.presenceTtlMs = 30_000, HEARTBEAT_INTERVAL_MS =
// 15_000): the caller is responsible for throttling heartbeats to ~15s; this
// client is intentionally thin and does NOT self-throttle or auto-schedule.
// TTL = 2×interval so one missed beat is tolerated before a peer goes stale.

import { api } from '@/shared/api/client';
import { telemetry } from '@/shared/telemetry/logger';

// ── presence states (single source: collabContract.cjs PRESENCE_STATES) ──────
export const PRESENCE_STATES = ['online', 'away', 'editing', 'offline'] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

/** Server-side record TTL (ms) — mirrors collabContract.presenceTtlMs. */
export const PRESENCE_TTL_MS = 30_000;
/** Recommended client heartbeat interval (ms) = TTL / 2 — caller throttles. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** One online peer as exposed by the server read surface. */
export interface PresencePeer {
  userId: string;
  state: PresenceState;
  /** 最后活跃 (epoch ms). null when the server omits it. */
  lastSeenMs: number | null;
}

export interface GetPresenceInput {
  canvasId: string;
}

export interface HeartbeatInput {
  canvasId: string;
  /** Defaults to 'online'. busy is NOT sent — use 'editing'. */
  state?: PresenceState;
}

export interface LeaveInput {
  canvasId: string;
}

const HEARTBEAT_PATH = '/api/v2/presence/heartbeat';
const peersPath = (canvasId: string) =>
  `/api/v2/presence/peers/${encodeURIComponent(canvasId)}`;

export class PresenceClientError extends Error {
  status?: number;
  body: unknown;
  constructor(message: string, opts: { status?: number; body?: unknown } = {}) {
    super(message);
    this.name = 'PresenceClientError';
    this.status = opts.status;
    this.body = opts.body;
  }
}

async function call<T>(fn: () => Promise<T>, op: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { status?: number; message?: string; body?: unknown; details?: unknown };
    if (typeof err.status === 'number') {
      throw new PresenceClientError(err.message || op, {
        status: err.status,
        body: err.body ?? err.details ?? err,
      });
    }
    telemetry.warn(`presence.${op}`, (e as Error).message);
    throw e;
  }
}

// ── tolerant wire parsers (missing fields never throw) ───────────────────────

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Unknown/missing state falls back to 'online' (present-but-unspecified). */
function parseState(v: unknown): PresenceState {
  return typeof v === 'string' && (PRESENCE_STATES as readonly string[]).includes(v)
    ? (v as PresenceState)
    : 'online';
}

/** A peer entry with no usable userId is skipped (unusable → not a crash). */
function parsePeer(raw: unknown): PresencePeer | null {
  const r = asRecord(raw);
  if (typeof r.userId !== 'string' || r.userId.length === 0) return null;
  const lastSeenMs =
    typeof r.lastSeenMs === 'number' && Number.isFinite(r.lastSeenMs) ? r.lastSeenMs : null;
  return { userId: r.userId, state: parseState(r.state), lastSeenMs };
}

/** GET peers response → PresencePeer[] (peers missing/not-array → []). */
function parsePeers(raw: unknown): PresencePeer[] {
  const r = asRecord(raw);
  if (!Array.isArray(r.peers)) return [];
  const out: PresencePeer[] = [];
  for (const item of r.peers) {
    const peer = parsePeer(item);
    if (peer) out.push(peer);
  }
  return out;
}

/** POST heartbeat response presence field → PresencePeer | null. */
function parsePresence(raw: unknown): PresencePeer | null {
  const r = asRecord(raw);
  return parsePeer(r.presence);
}

// ── client ───────────────────────────────────────────────────────────────────

export const presenceClient = {
  /**
   * 在场用户列表（在线 peer：userId / state / lastSeenMs）。读面以 server 现响应为准。
   * 契约注：无 projectId、无 cursor/selection 字段（见文件头「契约结论」）。
   */
  async getPresence(input: GetPresenceInput): Promise<PresencePeer[]> {
    const raw = await call(() => api.get<unknown>(peersPath(input.canvasId)), 'getPresence');
    return parsePeers(raw);
  },

  /**
   * 续活心跳（TTL 30s；调用方按 HEARTBEAT_INTERVAL_MS=15s 节流）。userId 由会话
   * 决定（客户端不传）；无 cursor 字段（契约未定义）。
   */
  async heartbeat(input: HeartbeatInput): Promise<PresencePeer | null> {
    const state: PresenceState = input.state ?? 'online';
    const raw = await call(
      () => api.post<unknown>(HEARTBEAT_PATH, { canvasId: input.canvasId, state }, { retry: false }),
      'heartbeat',
    );
    return parsePresence(raw);
  },

  /**
   * 离开画布 —— 即 heartbeat(state='offline')，服务端摘除 (canvas, user) 记录。
   * 契约注：无专用 leave 端点。
   */
  async leave(input: LeaveInput): Promise<void> {
    await call(
      () => api.post<unknown>(HEARTBEAT_PATH, { canvasId: input.canvasId, state: 'offline' }, { retry: false }),
      'leave',
    );
  },
};
