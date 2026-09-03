// ── Feature flags (M00) ──────────────────────────────────────────────────────
// Lightweight, local feature-flag architecture. No remote vendor in M00.
// Resolution order (first wins):
//   1. build-time env (import.meta.env.VITE_FF_*)
//   2. localStorage override (dev/UAT toggling, key 'ml2-ff-<name>')
//   3. flag default
//
// Legacy routes always remain available; flags only gate NEW V2 routes/modules.
//
// Testability: all decision logic lives in the PURE functions resolveFlag /
// setOverride (env + storage injected), so tests never need to mutate
// import.meta (vite gives each module its own import.meta instance).

export const FF = {
  V2_APP_SHELL: 'V2_APP_SHELL',
  V2_AI_CONTROL: 'V2_AI_CONTROL',
  V2_ASSETS: 'V2_ASSETS',
  V2_STUDIO: 'V2_STUDIO',
  /** S1 Scope Firewall (1.0 Product Lock): Shop/Marketplace (M6) is out of 1.0
   * public scope. Default OFF — code is preserved but not publicly reachable.
   * Re-enable with build env VITE_FF_SHOP_ENABLED=1 (dev/UAT only). */
  SHOP_ENABLED: 'SHOP_ENABLED',
} as const;

export type FeatureFlagName = (typeof FF)[keyof typeof FF];

export interface FlagEnvLike {
  PROD: boolean;
  [key: string]: unknown;
}

export interface FlagStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function parseBool(raw: unknown): boolean | null {
  if (raw === true) return true;
  if (raw === false) return false;
  if (typeof raw === 'string') {
    if (raw === '1' || raw.toLowerCase() === 'true') return true;
    if (raw === '0' || raw.toLowerCase() === 'false') return false;
  }
  return null;
}

/**
 * Pure flag resolution. Defaults are env-aware: in a production build every
 * V2 flag is OFF (prod users are never switched to V2). In dev, V2_APP_SHELL
 * is ON so the /__v2 preview shell is reachable without env setup.
 *
 * In production builds the localStorage layer is hard-disabled: a
 * console-injected override must not be able to flip flags. Flags are not a
 * security boundary, but /__v2 must stay an internal preview in prod builds.
 */
export function resolveFlag(
  name: FeatureFlagName,
  env: FlagEnvLike,
  storage: FlagStorageLike | null = null,
): boolean {
  const fromEnv = parseBool(env[`VITE_FF_${name}`]);
  if (fromEnv !== null) return fromEnv;

  if (storage && !env.PROD) {
    let fromLocal: unknown = null;
    try {
      fromLocal = storage.getItem(`ml2-ff-${name}`);
    } catch {
      fromLocal = null;
    }
    const parsed = parseBool(fromLocal);
    if (parsed !== null) return parsed;
  }

  switch (name) {
    case FF.V2_APP_SHELL:
      return !env.PROD; // dev-only preview by default
    case FF.SHOP_ENABLED:
      return false; // S1 scope firewall: always OFF — 1.0 is video production OS
    default:
      return false;
  }
}

/** Pure override write. No-op in production builds. */
export function setOverride(
  name: FeatureFlagName,
  value: boolean,
  env: FlagEnvLike,
  storage: FlagStorageLike,
): void {
  if (env.PROD) return;
  try {
    storage.setItem(`ml2-ff-${name}`, value ? '1' : '0');
  } catch {
    /* ignore (storage full / unavailable) */
  }
}

function realEnv(): FlagEnvLike {
  return (import.meta as unknown as { env: FlagEnvLike }).env;
}

function realStorage(): FlagStorageLike | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

export function isFeatureEnabled(name: FeatureFlagName): boolean {
  return resolveFlag(name, realEnv(), realStorage());
}

/** Dev-only override (UAT). No-op in production build. */
export function setFeatureFlag(name: FeatureFlagName, value: boolean) {
  const storage = realStorage();
  if (!storage) return;
  setOverride(name, value, realEnv(), storage);
}

export function getFeatureFlags(): Record<FeatureFlagName, boolean> {
  const env = realEnv();
  const storage = realStorage();
  return {
    [FF.V2_APP_SHELL]: resolveFlag(FF.V2_APP_SHELL, env, storage),
    [FF.V2_AI_CONTROL]: resolveFlag(FF.V2_AI_CONTROL, env, storage),
    [FF.V2_ASSETS]: resolveFlag(FF.V2_ASSETS, env, storage),
    [FF.V2_STUDIO]: resolveFlag(FF.V2_STUDIO, env, storage),
    [FF.SHOP_ENABLED]: resolveFlag(FF.SHOP_ENABLED, env, storage),
  };
}
