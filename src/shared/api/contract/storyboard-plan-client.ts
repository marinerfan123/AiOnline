// ── G13 — Storyboard plan view API contract (分镜计划 rows 数据源) ───────────
// Contract-first client for the storyboard PLAN view that StoryboardRowsPanel
// consumes. Mirrors server/modules/script/scriptApi.cjs exactly — this file
// does NOT touch the backend. GET …/storyboard is read-only and any project
// member (viewer included) may read it; projectId always rides in the query
// string (server.js puts every query param into req.params).
//
//   GET /api/v2/script/:scriptId/storyboard?projectId=…
//       200 → { ok:true, plan:{ beats:[…], totalShots }, dirty, planFingerprint }
//       400 → { ok:false, error:'计划需至少 1 行脚本行（该项目暂无 script_rows）' }
//             (zero script_rows in this project → caller treats as empty)
//
// The plan view is the deterministic beats/shots projection of the project's
// script_rows — the server recomputes it on every GET (plan = projection, and
// GET …/storyboard is never a stored copy the client could drift from).
// `dirty` (0054) = the PERSISTED plan generation is behind script_rows.
//
// ⚠ 已实测端点结论: per-row 0052 `locked` (project_shots_rows) is NOT part of
// this view today — locks live on the persisted rows table and only the
// write-side POST …/storyboard/shots/lock (0052) exists server-side. A rows
// list that shows per-row lock state from live data therefore needs a
// persisted-rows GET (or a lock list added to the plan view); until that
// lands the FE list renders rows as unlocked and shows lock badges purely from
// locally-known row state (props / future endpoint).

import { api } from '../client';
import { telemetry } from '@/shared/telemetry/logger';

/** A planned shot row (server buildStoryboardPlan shape). */
export interface StoryboardPlanShot {
  shotId: string;
  beatId: string;
  shotIndex: number;
  intent: 'dialogue' | 'reaction' | 'action' | string;
  subjectRefs?: unknown[];
  camera?: { shotSize?: string; movement?: string; angle?: string } | null;
  durationMs?: number | null;
}

/** A beat (row group) of the plan — carries the 文本片段 source (`summary`). */
export interface StoryboardPlanBeat {
  beatId: string;
  sceneIndex: number;
  beatIndex: number;
  scriptRowIds: string[];
  summary: string;
  shots: StoryboardPlanShot[];
}

/** 200 body of the GET plan view. */
export interface StoryboardPlanViewResponse {
  ok: true;
  plan: { beats: StoryboardPlanBeat[]; totalShots: number };
  dirty: boolean;
  planFingerprint: string | null;
}

async function call<T>(fn: () => Promise<T>, op: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { status?: number };
    // ApiError already carries status + details (raw body) → rethrow as-is so
    // callers can parse 409 bodies / distinguish the empty-rows 400.
    if (typeof err.status === 'number') throw e;
    telemetry.warn(`v2script.storyboard.${op}`, (e as Error).message);
    throw e;
  }
}

function planPath(projectId: string, scriptId: string, suffix = '') {
  return `/api/v2/script/${encodeURIComponent(scriptId)}/storyboard${suffix}?projectId=${encodeURIComponent(projectId)}`;
}

export const storyboardPlanClient = {
  /**
   * GET /api/v2/script/:scriptId/storyboard — plan view (rows → beats/shots
   * projection + 0054 staleness). Rejects with ApiError on 400/401/403/5xx;
   * the 400 "暂无 script_rows" body is the server's only "empty project"
   * signal and is surfaced through the error so the panel can show an empty
   * state instead of a failure.
   */
  getPlanView(projectId: string, scriptId: string): Promise<StoryboardPlanViewResponse> {
    return call(() => api.get<StoryboardPlanViewResponse>(planPath(projectId, scriptId)), 'getPlanView');
  },
};
