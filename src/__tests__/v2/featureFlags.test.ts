// @vitest-environment jsdom
/**
 * V2 M00 — feature flag behavior.
 * Covers: prod default OFF, dev default ON for V2_APP_SHELL, env override,
 * localStorage override dev-only, and the prod no-bypass rule.
 *
 * Logic is tested through the PURE resolvers (resolveFlag/setOverride) with
 * injected env/storage — vitest gives every module its own import.meta, so
 * mutating import.meta.env in one module cannot affect another.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FF, resolveFlag, setOverride, isFeatureEnabled, setFeatureFlag, getFeatureFlags } from '@/shared/config/featureFlags';

type Env = Parameters<typeof resolveFlag>[1];

function envLike(over: Partial<Record<string, unknown>> = {}): Env {
  return { PROD: false, ...over };
}

// jsdom shares one localStorage per file — reset between tests.
beforeEach(() => {
  localStorage.clear();
});

describe('feature flags (M00) — pure resolution', () => {
  it('production build: all V2 flags default OFF', () => {
    const env: Env = envLike({ PROD: true });
    expect(resolveFlag(FF.V2_APP_SHELL, env, localStorage)).toBe(false);
    expect(resolveFlag(FF.V2_AI_CONTROL, env, localStorage)).toBe(false);
    expect(resolveFlag(FF.V2_ASSETS, env, localStorage)).toBe(false);
    expect(resolveFlag(FF.V2_STUDIO, env, localStorage)).toBe(false);
  });

  it('dev build: V2_APP_SHELL default ON (preview), others OFF', () => {
    const env: Env = envLike({});
    expect(resolveFlag(FF.V2_APP_SHELL, env, localStorage)).toBe(true);
    expect(resolveFlag(FF.V2_AI_CONTROL, env, localStorage)).toBe(false);
    expect(resolveFlag(FF.V2_ASSETS, env, localStorage)).toBe(false);
    expect(resolveFlag(FF.V2_STUDIO, env, localStorage)).toBe(false);
  });

  it('env override wins (both directions)', () => {
    const on: Env = envLike({ VITE_FF_V2_STUDIO: '1' });
    expect(resolveFlag(FF.V2_STUDIO, on, localStorage)).toBe(true);
    const off: Env = envLike({ VITE_FF_V2_APP_SHELL: '0' });
    expect(resolveFlag(FF.V2_APP_SHELL, off, localStorage)).toBe(false);
  });

  it('localStorage override works in dev', () => {
    const env: Env = envLike({});
    expect(resolveFlag(FF.V2_STUDIO, env, localStorage)).toBe(false);
    setOverride(FF.V2_STUDIO, true, env, localStorage);
    expect(resolveFlag(FF.V2_STUDIO, env, localStorage)).toBe(true);
    setOverride(FF.V2_STUDIO, false, env, localStorage);
    expect(resolveFlag(FF.V2_STUDIO, env, localStorage)).toBe(false);
  });

  it('PRODUCTION: localStorage override is hard-disabled (no self-enable)', () => {
    const env: Env = envLike({ PROD: true });
    // A malicious/buggy console injection:
    localStorage.setItem('ml2-ff-V2_APP_SHELL', '1');
    localStorage.setItem('ml2-ff-V2_STUDIO', '1');
    expect(resolveFlag(FF.V2_APP_SHELL, env, localStorage)).toBe(false);
    expect(resolveFlag(FF.V2_STUDIO, env, localStorage)).toBe(false);
  });

  it('setOverride is a no-op in production', () => {
    const env: Env = envLike({ PROD: true });
    setOverride(FF.V2_STUDIO, true, env, localStorage);
    expect(localStorage.getItem('ml2-ff-V2_STUDIO')).toBeNull();
  });

  it('resolution order: env > localStorage > default', () => {
    const env: Env = envLike({ PROD: true, VITE_FF_V2_APP_SHELL: '1' });
    // env beats the prod-OFF default (explicit opt-in for staging/preview deploys)
    expect(resolveFlag(FF.V2_APP_SHELL, env, localStorage)).toBe(true);
    const env2: Env = envLike({ VITE_FF_V2_STUDIO: '0' });
    localStorage.setItem('ml2-ff-V2_STUDIO', '1');
    // env beats localStorage
    expect(resolveFlag(FF.V2_STUDIO, env2, localStorage)).toBe(false);
  });
});

describe('feature flags (M00) — real module bindings (dev runtime)', () => {
  it('getFeatureFlags returns all four and matches dev defaults', () => {
    const all = getFeatureFlags();
    expect(Object.keys(all).sort()).toEqual(
      ['V2_AI_CONTROL', 'V2_APP_SHELL', 'V2_ASSETS', 'V2_STUDIO'].sort(),
    );
    // vitest runs with PROD=false by default
    expect(isFeatureEnabled(FF.V2_APP_SHELL)).toBe(true);
    expect(isFeatureEnabled(FF.V2_STUDIO)).toBe(false);
  });

  it('setFeatureFlag round-trips through localStorage in dev', () => {
    setFeatureFlag(FF.V2_STUDIO, true);
    expect(isFeatureEnabled(FF.V2_STUDIO)).toBe(true);
    setFeatureFlag(FF.V2_STUDIO, false);
    expect(isFeatureEnabled(FF.V2_STUDIO)).toBe(false);
    localStorage.clear();
  });
});
