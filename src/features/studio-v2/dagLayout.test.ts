import { describe, it, expect } from 'vitest';
import { computeAutoLayout } from './dagLayout';

const N = (id: string, kind = 'text', width = 260, height = 140) => ({ id, kind, width, height });
const E = (source: string, target: string) => ({ source, target });

describe('computeAutoLayout', () => {
  it('linear chain layers left→right, increasing x', () => {
    const pos = computeAutoLayout([N('a'), N('b'), N('c')], [E('a', 'b'), E('b', 'c')]);
    expect(pos.size).toBe(3);
    expect(pos.get('a')!.x).toBeLessThan(pos.get('b')!.x);
    expect(pos.get('b')!.x).toBeLessThan(pos.get('c')!.x);
  });

  it('fork: children share a layer but get distinct y', () => {
    const pos = computeAutoLayout([N('a'), N('b'), N('c')], [E('a', 'b'), E('a', 'c')]);
    expect(pos.get('b')!.x).toBe(pos.get('c')!.x); // same layer
    expect(pos.get('b')!.y).not.toBe(pos.get('c')!.y);
    expect(pos.get('a')!.x).toBeLessThan(pos.get('b')!.x);
  });

  it('disconnected nodes stack in the source layer without overlapping', () => {
    const pos = computeAutoLayout([N('a'), N('b'), N('c')], []);
    const ys = [...pos.values()].map((p) => p.y);
    expect(new Set(ys).size).toBe(3); // all distinct
  });

  it('skips container kinds (frame) entirely', () => {
    const pos = computeAutoLayout(
      [N('frame1', 'frame'), N('a'), N('b')],
      [E('a', 'b')],
      { skipKinds: new Set(['frame']) },
    );
    expect(pos.has('frame1')).toBe(false);
    expect(pos.has('a')).toBe(true);
    expect(pos.has('b')).toBe(true);
  });

  it('cycle does not crash; every node gets a position', () => {
    const pos = computeAutoLayout([N('a'), N('b'), N('c')], [E('a', 'b'), E('b', 'c'), E('c', 'a')]);
    expect(pos.size).toBe(3);
    for (const p of pos.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('is deterministic for identical inputs', () => {
    const a = computeAutoLayout([N('a'), N('b'), N('c'), N('d')], [E('a', 'b'), E('b', 'd'), E('a', 'c')]);
    const b = computeAutoLayout([N('a'), N('b'), N('c'), N('d')], [E('a', 'b'), E('b', 'd'), E('a', 'c')]);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });
});
