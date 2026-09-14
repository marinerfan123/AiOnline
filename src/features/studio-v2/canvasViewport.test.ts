// M1 — pure viewport math tests (no DOM, no React Flow).
import { describe, it, expect } from 'vitest';
import {
  GRID_SIZE,
  MIN_ZOOM,
  MAX_ZOOM,
  clampZoom,
  worldToScreen,
  screenToWorld,
  zoomAt,
  panBy,
  clampPan,
  fitView,
  snapToGrid,
  gridLines,
  visibleWorldRect,
  type Viewport,
} from './canvasViewport';

const V = (x: number, y: number, zoom: number): Viewport => ({ x, y, zoom });

describe('worldToScreen / screenToWorld — coordinate round-trip', () => {
  const viewports: Viewport[] = [
    V(0, 0, 1),
    V(100, -50, 2),
    V(-320, 480, 0.25),
    V(1234.5, -987.6, 3.7),
  ];

  it('matches the React Flow convention (screen = world*zoom + offset)', () => {
    expect(worldToScreen({ x: 10, y: 20 }, V(100, 50, 2))).toEqual({ x: 120, y: 90 });
    expect(screenToWorld({ x: 120, y: 90 }, V(100, 50, 2))).toEqual({ x: 10, y: 20 });
  });

  it('round-trips world → screen → world for arbitrary viewports', () => {
    const points = [{ x: 0, y: 0 }, { x: -17.3, y: 42.9 }, { x: 1234.5, y: -987.6 }];
    for (const vp of viewports) {
      for (const p of points) {
        const back = screenToWorld(worldToScreen(p, vp), vp);
        expect(back.x).toBeCloseTo(p.x, 10);
        expect(back.y).toBeCloseTo(p.y, 10);
      }
    }
  });

  it('round-trips screen → world → screen for arbitrary viewports', () => {
    const screens = [{ x: 0, y: 0 }, { x: 640, y: 360 }, { x: -55, y: 1280 }];
    for (const vp of viewports) {
      for (const s of screens) {
        const back = worldToScreen(screenToWorld(s, vp), vp);
        expect(back.x).toBeCloseTo(s.x, 10);
        expect(back.y).toBeCloseTo(s.y, 10);
      }
    }
  });
});

describe('zoomAt — anchor invariant + clamp', () => {
  it('keeps the world point under the screen anchor stationary', () => {
    const vp = V(200, 100, 1.5);
    const anchor = { x: 400, y: 300 };
    for (const factor of [0.5, 1.25, 2, 3, 0.8]) {
      const next = zoomAt(anchor, factor, vp);
      // world point under anchor BEFORE zoom:
      const worldBefore = screenToWorld(anchor, vp);
      // that same world point's screen position AFTER zoom must equal the anchor:
      const screenAfter = worldToScreen(worldBefore, next);
      expect(screenAfter.x).toBeCloseTo(anchor.x, 10);
      expect(screenAfter.y).toBeCloseTo(anchor.y, 10);
    }
  });

  it('applies the factor to zoom', () => {
    const next = zoomAt({ x: 0, y: 0 }, 2, V(10, 10, 1));
    expect(next.zoom).toBeCloseTo(2, 10);
  });

  it('clamps zoom to [MIN_ZOOM, MAX_ZOOM]', () => {
    expect(zoomAt({ x: 0, y: 0 }, 100, V(0, 0, 1)).zoom).toBe(MAX_ZOOM);
    expect(zoomAt({ x: 0, y: 0 }, 0.000001, V(0, 0, 1)).zoom).toBe(MIN_ZOOM);
  });

  it('zoom-at-top-left-anchor reduces offset toward zero as it zooms out', () => {
    // Zooming out with the anchor at the viewport origin: the world point under
    // (0,0) stays at (0,0), so x/y remain 0.
    const next = zoomAt({ x: 0, y: 0 }, 0.5, V(0, 0, 2));
    expect(next).toEqual(V(0, 0, 1));
  });
});

describe('panBy — screen-space translation', () => {
  it('translates x/y and preserves zoom', () => {
    expect(panBy(30, -15, V(5, 6, 2))).toEqual(V(35, -9, 2));
  });

  it('is identity for a zero delta', () => {
    const vp = V(123, -456, 1.75);
    expect(panBy(0, 0, vp)).toEqual(vp);
  });

  it('handles negative deltas (pan boundary cases)', () => {
    expect(panBy(-100, -200, V(50, 50, 1))).toEqual(V(-50, -150, 1));
    expect(panBy(-1e6, 1e6, V(0, 0, 1))).toEqual(V(-1e6, 1e6, 1));
  });
});

describe('clampPan — camera boundary clamp', () => {
  const bounds = { x: 0, y: 0, width: 1000, height: 800 };

  it('leaves a viewport already inside the bounds untouched', () => {
    expect(clampPan(V(200, 300, 1), bounds)).toEqual(V(200, 300, 1));
  });

  it('clamps a viewport that flew outside the bounds', () => {
    expect(clampPan(V(5000, -2000, 1), bounds)).toEqual(V(1000, 0, 1));
  });

  it('clamps the low edge too', () => {
    expect(clampPan(V(-500, -500, 1), bounds)).toEqual(V(0, 0, 1));
  });
});

describe('fitView — fits world bounds into a screen viewport', () => {
  it('centres a square bounds into a matching square viewport at zoom 1', () => {
    const vp = fitView({ x: 100, y: 200, width: 400, height: 400 }, { width: 400, height: 400 });
    expect(vp.zoom).toBeCloseTo(1, 10);
    // bounds centre (300, 400) maps to screen centre (200, 200):
    expect(worldToScreen({ x: 300, y: 400 }, vp)).toEqual({ x: 200, y: 200 });
  });

  it('picks the tighter axis and clamps zoom', () => {
    const vp = fitView({ x: 0, y: 0, width: 1000, height: 100 }, { width: 500, height: 500 });
    // width ratio 0.5, height ratio 5 → zoom 0.5 (width-limited)
    expect(vp.zoom).toBeCloseTo(0.5, 10);
  });

  it('applies padding (shrinks zoom, keeps centre)', () => {
    const padded = fitView({ x: 0, y: 0, width: 400, height: 400 }, { width: 400, height: 400 }, { padding: 100 });
    // padded bounds = 600×600 in a 400×400 viewport → zoom 400/600
    expect(padded.zoom).toBeCloseTo(400 / 600, 10);
    expect(worldToScreen({ x: 200, y: 200 }, padded)).toEqual({ x: 200, y: 200 });
  });

  it('clamps zoom into [minZoom, maxZoom]', () => {
    expect(fitView({ x: 0, y: 0, width: 10, height: 10 }, { width: 1000, height: 1000 }).zoom).toBe(MAX_ZOOM);
    expect(fitView({ x: 0, y: 0, width: 1e9, height: 1e9 }, { width: 100, height: 100 }).zoom).toBe(MIN_ZOOM);
  });

  it('returns identity for null/empty bounds or degenerate sizes', () => {
    expect(fitView(null, { width: 100, height: 100 })).toEqual(V(0, 0, 1));
    expect(fitView({ x: 0, y: 0, width: 0, height: 0 }, { width: 100, height: 100 })).toEqual(V(0, 0, 1));
    expect(fitView({ x: 0, y: 0, width: 100, height: 100 }, { width: 0, height: 0 })).toEqual(V(0, 0, 1));
  });
});

describe('snapToGrid — grid coordinate conversion (world GRID_SIZE=20)', () => {
  it('snaps to the nearest multiple of the grid size', () => {
    expect(snapToGrid({ x: 13, y: 34 })).toEqual({ x: 20, y: 40 });
    expect(snapToGrid({ x: 7, y: 3 })).toEqual({ x: 0, y: 0 });
  });

  it('leaves exact multiples untouched', () => {
    expect(snapToGrid({ x: 40, y: -60 })).toEqual({ x: 40, y: -60 });
    expect(snapToGrid({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it('matches React Flow snapPosition (grid * Math.round(pos / grid))', () => {
    // 10 is exactly halfway between 0 and 20 → Math.round(0.5) = 1 → 20.
    expect(snapToGrid({ x: 10, y: 10 })).toEqual({ x: 20, y: 20 });
    // -10 halfway between -20 and 0 → Math.round(-0.5) = -0 → 0.
    expect(snapToGrid({ x: -10, y: -10 })).toEqual({ x: 0, y: 0 });
  });

  it('accepts a custom grid size', () => {
    expect(snapToGrid({ x: 6, y: 7 }, 5)).toEqual({ x: 5, y: 5 });
  });

  it('exposes GRID_SIZE = 20 world units', () => {
    expect(GRID_SIZE).toBe(20);
  });
});

describe('gridLines — visible-only grid line computation', () => {
  it('returns world-space lines at multiples of gridSize covering the rect', () => {
    const { x, y } = gridLines({ x: 5, y: 5, width: 60, height: 40 }, 20);
    expect(x).toEqual([0, 20, 40, 60]);
    expect(y).toEqual([0, 20, 40]);
  });

  it('handles negative rect origins', () => {
    const { x } = gridLines({ x: -45, y: 0, width: 60, height: 20 }, 20);
    expect(x).toEqual([-60, -40, -20, 0]);
  });
});

describe('visibleWorldRect — inverse of the viewport mapping', () => {
  it('computes the visible world rect for a screen size', () => {
    const rect = visibleWorldRect(V(100, 50, 2), { width: 200, height: 100 });
    expect(rect).toEqual({ x: -50, y: -25, width: 100, height: 50 });
  });
});

describe('clampZoom', () => {
  it('clamps and handles non-finite input', () => {
    expect(clampZoom(2)).toBe(2);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(-1)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
    expect(clampZoom(Infinity)).toBe(MIN_ZOOM);
  });

  it('honours custom bounds', () => {
    expect(clampZoom(10, 1, 8)).toBe(8);
    expect(clampZoom(0.5, 1, 8)).toBe(1);
  });
});
