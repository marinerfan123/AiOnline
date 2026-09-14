// M1 — Infinite-viewport core (pure, DOM-free, unit-testable).
//
// Coordinate convention is IDENTICAL to React Flow (@xyflow/react v12) so the
// pure math is interchangeable with `screenToFlowPosition` / `flowToScreenPosition`:
//
//   screen = world * zoom + offset          (offset = viewport.{x,y})
//   world  = (screen - offset) / zoom
//
// where `viewport.{x,y}` is the world/flow position of the viewport's top-left
// corner and `viewport.zoom` is the scale. Verified against @xyflow/system
// `rendererPointToPoint` / `pointToRendererPoint` (transform [x, y, zoom]).

export const GRID_SIZE = 20; // world units per grid cell (snap + grid lines)
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Clamp a zoom level into [min, max] (defaults 0.1..4). Non-finite → min. */
export function clampZoom(zoom: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  if (!Number.isFinite(zoom)) return min;
  return Math.min(max, Math.max(min, zoom));
}

/** World/flow position → screen position. */
export function worldToScreen(p: Point, vp: Viewport): Point {
  return { x: p.x * vp.zoom + vp.x, y: p.y * vp.zoom + vp.y };
}

/** Screen position → world/flow position. */
export function screenToWorld(p: Point, vp: Viewport): Point {
  return { x: (p.x - vp.x) / vp.zoom, y: (p.y - vp.y) / vp.zoom };
}

/**
 * Zoom by `factor` while keeping the SCREEN-space `anchor` point stationary
 * (the cursor-under-the-wheel invariant). The world point that sits under the
 * anchor before the zoom maps back to the exact same screen point after.
 */
export function zoomAt(anchor: Point, factor: number, vp: Viewport): Viewport {
  const zoom = clampZoom(vp.zoom * factor);
  const wx = (anchor.x - vp.x) / vp.zoom;
  const wy = (anchor.y - vp.y) / vp.zoom;
  // Solve anchor.x = wx * zoom + x  =>  x = anchor.x - wx * zoom
  return { x: anchor.x - wx * zoom, y: anchor.y - wy * zoom, zoom };
}

/** Translate the viewport by a SCREEN-space delta (pixels). Zoom is unchanged. */
export function panBy(dx: number, dy: number, vp: Viewport): Viewport {
  return { x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom };
}

/**
 * Camera clamp: keep the viewport's world-space top-left corner inside a
 * world-space `bounds` box. Prevents the canvas origin flying off-screen after
 * repeated pans. `bounds` is a hint, not a hard crop — when zoomed out the
 * visible extent may still exceed it.
 */
export function clampPan(vp: Viewport, bounds: Bounds): Viewport {
  return {
    ...vp,
    x: Math.min(Math.max(vp.x, bounds.x), bounds.x + bounds.width),
    y: Math.min(Math.max(vp.y, bounds.y), bounds.y + bounds.height),
  };
}

export interface FitViewOptions {
  /** world-space padding added to every side of the content bounds (default 0). */
  padding?: number;
  minZoom?: number;
  maxZoom?: number;
}

/**
 * Compute the viewport that fits world-space `bounds` into a screen viewport of
 * `size` pixels, centred, with zoom clamped to [minZoom, maxZoom]. Null/empty
 * bounds or a degenerate size returns the identity viewport.
 */
export function fitView(bounds: Bounds | null, size: Size, opts: FitViewOptions = {}): Viewport {
  const { padding = 0, minZoom = MIN_ZOOM, maxZoom = MAX_ZOOM } = opts;
  if (
    !bounds ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    size.width <= 0 ||
    size.height <= 0
  ) {
    return { x: 0, y: 0, zoom: 1 };
  }
  const padded: Bounds = {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
  const zoom = clampZoom(
    Math.min(size.width / padded.width, size.height / padded.height),
    minZoom,
    maxZoom,
  );
  // Centre: the bounds centre maps to the screen centre.
  const x = size.width / 2 - (padded.x + padded.width / 2) * zoom;
  const y = size.height / 2 - (padded.y + padded.height / 2) * zoom;
  return { x, y, zoom };
}

/** Snap a world position to the nearest grid intersection (round-half semantics). */
export function snapToGrid(p: Point, gridSize = GRID_SIZE): Point {
  // `+ 0` normalises the JS -0 that Math.round(-x/grid) produces, so snapping
  // -10 on a 20-grid yields +0 (canonical), not -0.
  return {
    x: gridSize * Math.round(p.x / gridSize) + 0,
    y: gridSize * Math.round(p.y / gridSize) + 0,
  };
}

/**
 * World-space grid line positions intersecting the given world rect. Used to
 * draw ONLY the visible grid — infinite feel without unbounded work.
 */
export function gridLines(range: Bounds, gridSize = GRID_SIZE): { x: number[]; y: number[] } {
  const xs: number[] = [];
  const ys: number[] = [];
  const startX = Math.floor(range.x / gridSize) * gridSize;
  for (let x = startX; x <= range.x + range.width; x += gridSize) xs.push(x);
  const startY = Math.floor(range.y / gridSize) * gridSize;
  for (let y = startY; y <= range.y + range.height; y += gridSize) ys.push(y);
  return { x: xs, y: ys };
}

/** World-space rect currently visible for a screen viewport of `size` pixels. */
export function visibleWorldRect(vp: Viewport, size: Size): Bounds {
  const topLeft = screenToWorld({ x: 0, y: 0 }, vp);
  const bottomRight = screenToWorld({ x: size.width, y: size.height }, vp);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
}
