// @vitest-environment jsdom
/**
 * G06 — Asset Library drag→canvas drop wiring.
 * Renders the REAL StudioCanvas (store + CanvasCore onDrop handler all real);
 * only the third-party layout engine @xyflow/react is stubbed into a passive
 * prop-recorder (same pattern as studioInteractionGaps.test.tsx). Covers:
 *   - IMAGE/VIDEO/AUDIO/OTHER asset payloads → image/video/audio/reference
 *     ASSET nodes (never a generation node)
 *   - drop position maps through screenToFlowPosition → world coords
 *   - data.assetId + parameters.assetId carry the durable M04-S assetId
 *   - malformed/empty payloads never create a node
 * Actual pan/zoom layout math stays browser/E2E scope.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, configure } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StudioCanvas, assetTypeToNodeKind, parseAssetDragPayload, ASSET_DRAG_MIME } from '@/features/studio-v2/StudioCanvas';
import { useStudioStore } from '@/features/studio-v2/store';

configure({ testIdAttribute: 'data-test' });

// ── @xyflow/react → prop-recorder stubs (layout engine only; logic stays real) ──
const rf = vi.hoisted(() => ({
  onDrop: null as null | ((e: unknown) => void),
  fitView: vi.fn(),
}));

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const React = (actual as any).React ?? (await import('react')).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = (type: any, props: Record<string, unknown> | null, ...children: unknown[]) =>
    React.createElement(type, props, ...children);
  const StubRF = (props: Record<string, unknown> & { children?: unknown }) => {
    rf.onDrop = (props.onDrop as (e: unknown) => void) ?? null;
    return el('div', { 'data-testid': 'rf-stub' }, props.children);
  };
  return {
    ...actual,
    ReactFlow: StubRF,
    ReactFlowProvider: (props: { children?: unknown }) => props.children,
    Background: () => null,
    MiniMap: () => null,
    Controls: () => null,
    useReactFlow: () => ({
      screenToFlowPosition: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }),
      fitView: rf.fitView,
      setViewport: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      zoomTo: vi.fn(),
      setCenter: vi.fn(),
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      deleteElements: vi.fn(),
    }),
  };
});

function reset() {
  useStudioStore.setState({
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    undoStack: [], redoStack: [], clipboard: null, invalidConnection: null,
    dragSnapshot: null, editSnapshot: null,
  });
}

/** Fake drop event carrying an asset payload under the G06 drag MIME type. */
function assetDrop(
  assetId: string,
  assetType: string,
  opts: { url?: string; thumbnail?: string; x?: number; y?: number } = {},
) {
  const data = { assetId, assetType, url: opts.url ?? '', thumbnail: opts.thumbnail ?? '' };
  const dataTransfer = {
    getData: (mime: string) => (mime === ASSET_DRAG_MIME ? JSON.stringify(data) : ''),
    files: [] as unknown as FileList,
    dropEffect: 'move',
    effectAllowed: 'copy',
    setData: vi.fn(),
  };
  return {
    dataTransfer,
    clientX: opts.x ?? 400,
    clientY: opts.y ?? 300,
    preventDefault: vi.fn(),
  };
}

function fireDrop(e: unknown) {
  if (!rf.onDrop) throw new Error('ReactFlow stub did not capture onDrop — was StudioCanvas rendered?');
  act(() => {
    rf.onDrop!(e);
  });
}

beforeEach(() => {
  reset();
  rf.onDrop = null;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <StudioCanvas />
    </QueryClientProvider>,
  );
});
afterEach(() => cleanup());

describe('G06 asset drop → ASSET node creation', () => {
  it('IMAGE asset → image node at the drop point, assetId landed on data + parameters', () => {
    fireDrop(assetDrop('m-1', 'IMAGE', { url: 'https://cdn/a.png', thumbnail: 'https://cdn/a.jpg' }));

    const st = useStudioStore.getState();
    expect(st.nodes).toHaveLength(1);
    const n = st.nodes[0];
    expect(n.data.nodeKind).toBe('image');
    expect(n.position).toEqual({ x: 400 - 120, y: 300 - 60 }); // screenToFlowPosition → world − half node
    expect(n.data.assetId).toBe('m-1');
    expect(n.data.parameters.assetId).toBe('m-1');
  });

  it('VIDEO asset → video node; AUDIO asset → audio node; OTHER asset → reference node', () => {
    fireDrop(assetDrop('m-v', 'VIDEO'));
    expect(useStudioStore.getState().nodes[0].data.nodeKind).toBe('video');

    reset();
    fireDrop(assetDrop('m-a', 'AUDIO'));
    expect(useStudioStore.getState().nodes[0].data.nodeKind).toBe('audio');

    reset();
    fireDrop(assetDrop('m-o', 'OTHER'));
    expect(useStudioStore.getState().nodes[0].data.nodeKind).toBe('reference');
  });

  it('asset nodes are ASSET (not GENERATION) — registry executionKind stays out of the DAG execution path', () => {
    fireDrop(assetDrop('m-1', 'IMAGE'));
    const n = useStudioStore.getState().nodes[0];
    // The created node must be one of the ASSET kinds, never a generation kind.
    expect(['image', 'video', 'audio', 'reference']).toContain(n.data.nodeKind);
    expect(['image-generation', 'text-to-video', 'image-to-video']).not.toContain(n.data.nodeKind);
  });

  it('a malformed / empty asset payload never creates a node', () => {
    // Empty payload (no asset MIME data) falls through to node-kind/file handling
    // which also have nothing to act on → no node.
    fireDrop({ dataTransfer: { getData: () => '', files: [] as unknown as FileList }, clientX: 400, clientY: 300, preventDefault: vi.fn() });
    expect(useStudioStore.getState().nodes).toHaveLength(0);
  });

  it('drop position maps through screenToFlowPosition for arbitrary client coords', () => {
    fireDrop(assetDrop('m-2', 'IMAGE', { x: 1000, y: 640 }));
    const n = useStudioStore.getState().nodes[0];
    expect(n.position).toEqual({ x: 1000 - 120, y: 640 - 60 });
  });
});

describe('assetTypeToNodeKind / parseAssetDragPayload — pure mapping', () => {
  it('maps M04-S assetTypes to Blueprint ASSET kinds (never GENERATION)', () => {
    expect(assetTypeToNodeKind('IMAGE')).toBe('image');
    expect(assetTypeToNodeKind('VIDEO')).toBe('video');
    expect(assetTypeToNodeKind('AUDIO')).toBe('audio');
    expect(assetTypeToNodeKind('OTHER')).toBe('reference');
  });

  it('parseAssetDragPayload accepts valid JSON and coerces unknown assetType to OTHER', () => {
    expect(parseAssetDragPayload(JSON.stringify({ assetId: 'm-1', assetType: 'IMAGE', url: 'u', thumbnail: 't' }))).toEqual({
      assetId: 'm-1', assetType: 'IMAGE', url: 'u', thumbnail: 't',
    });
    expect(parseAssetDragPayload(JSON.stringify({ assetId: 'm-1', assetType: 'NOPE' }))?.assetType).toBe('OTHER');
    expect(parseAssetDragPayload('')).toBeNull();
    expect(parseAssetDragPayload('{ not json')).toBeNull();
    expect(parseAssetDragPayload(JSON.stringify({ assetType: 'IMAGE' }))).toBeNull(); // missing assetId
  });
});
