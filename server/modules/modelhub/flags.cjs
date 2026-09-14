'use strict';
/**
 * L7 — Feature Flag 脚手架（规范 §138 渐进上线）。
 *
 * 8 个 VIDEO_* 灰度开关，读取优先级（高 → 低）：
 *   1. env        `FF_<NAME>`（如 FF_VIDEO_NEW_ROUTER=1）
 *   2. settings   DB 注入覆盖（L7 阶段 DB: 无，暂不接线；预留 setFlagSettingsSource）
 *   3. default    Phase 1 一律 OFF（fail-closed，未接线的 VIDEO_* 面默认关闭）
 *
 * Pure module（require 时无 I/O）：resolveFlag 为纯函数（env/settings 注入），
 * isFlagEnabled / listFlags 读真实 process.env 与（若已接线）settings 源。
 * 未知 flag 名一律 throw（拒绝），避免拼写错误悄悄关掉灰度面。
 */

const FLAG_NAMES = Object.freeze([
  'VIDEO_OPERATION_REGISTRY',
  'VIDEO_SCHEMA_RUNTIME',
  'VIDEO_NEW_DRIVER_RUNTIME',
  'VIDEO_DURABLE_EVENTS',
  'VIDEO_NEW_ROUTER',
  'VIDEO_SCHEMA_UI',
  'VIDEO_CANVAS_RUNTIME',
  'VIDEO_WORKFLOW_RUNTIME',
]);

// Phase 1：默认全部 OFF（§138 渐进上线，先关后开）。
const FLAG_DEFAULTS = Object.freeze(
  Object.fromEntries(FLAG_NAMES.map((name) => [name, false])),
);

const ENV_PREFIX = 'FF_';
const KNOWN = new Set(FLAG_NAMES);

/** Parse a truthy/falsy literal. Returns null when the value is not a boolean literal. */
function parseBool(raw) {
  if (raw === true) return true;
  if (raw === false) return false;
  if (typeof raw === 'number' && (raw === 1 || raw === 0)) return raw === 1;
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'on' || s === 'yes') return true;
    if (s === '0' || s === 'false' || s === 'off' || s === 'no') return false;
  }
  return null;
}

/** Reject unknown flag names (typo-safe; never silently OFF an intended rollout). */
function assertKnown(name) {
  if (!KNOWN.has(name)) {
    throw new Error(`Unknown feature flag: "${name}". Known: ${FLAG_NAMES.join(', ')}`);
  }
}

/**
 * Pure resolution: env > settings > default (off).
 * @param {string} name
 * @param {{env?: Record<string, string|undefined>, settings?: Record<string, unknown>|null}} [opts]
 * @returns {boolean}
 */
function resolveFlag(name, { env = process.env, settings = null } = {}) {
  assertKnown(name);

  // 1) env (highest precedence)
  const fromEnv = parseBool(env[`${ENV_PREFIX}${name}`]);
  if (fromEnv !== null) return fromEnv;

  // 2) settings (DB-backed override, injected — not read here, module stays pure)
  if (settings && typeof settings === 'object') {
    const fromSettings = parseBool(settings[name]);
    if (fromSettings !== null) return fromSettings;
  }

  // 3) default OFF (Phase 1)
  return FLAG_DEFAULTS[name];
}

// Optional settings source. L7 wires no DB (DB: 无 per plan). A later phase may
// attach a loader (e.g. cached `SELECT value FROM settings WHERE key='flags'`)
// without changing call sites: setFlagSettingsSource(fn) → isFlagEnabled/listFlags.
let settingsSource = null;
function setFlagSettingsSource(source) {
  settingsSource = typeof source === 'function' ? source : null;
}

/** @returns {boolean} current value for a known flag; throws on unknown name. */
function isFlagEnabled(name) {
  const settings = settingsSource ? settingsSource() : null;
  return resolveFlag(name, { env: process.env, settings });
}

/** @returns {Record<string, boolean>} all 8 flags → resolved current value. */
function listFlags() {
  const settings = settingsSource ? settingsSource() : null;
  return Object.fromEntries(
    FLAG_NAMES.map((name) => [name, resolveFlag(name, { env: process.env, settings })]),
  );
}

module.exports = {
  FLAG_NAMES,
  FLAG_DEFAULTS,
  ENV_PREFIX,
  resolveFlag,
  isFlagEnabled,
  listFlags,
  setFlagSettingsSource,
  parseBool,
};
