// @vitest-environment jsdom
/**
 * G02/G03/G05 interaction-parity GAP tests — jsdom half of the Canvas Input
 * Contract (Blueprint 02 §3, 05 spec G02/G03/G05). Renders the REAL
 * StudioCanvas (store + CanvasCore keyboard/pane/context-menu handlers all
 * real); only the third-party layout engine @xyflow/react is stubbed into
 * passive prop-recorder components. No repo component is mocked.
 *
 * Covers the previously test-less wiring:
 *   - RF interaction props (zoomOnDoubleClick=false, Space pan activation,
 *     MMB panOnDrag, deleteKeyCode=null, selectionOnDrag, zoom caps)
 *   - zoomOnDoubleClick=false ↔ pane double-click create-menu coexistence
 *   - F = fit-selected / Shift+F = fit-all clamp arguments, Ctrl+F ignored
 *   - Delete/Backspace input-guard (never fires inside text fields)
 *   - undo/redo keyboard params (Ctrl/Cmd+Z, Ctrl+Shift+Z, Ctrl+Y) + field guard
 *   - Ctrl+A / Ctrl+D / Ctrl+G wiring
 * Actual pan/zoom gestures and RF layout math stay browser/E2E scope (05 §5,
 * §6) — marked in the parity matrix, not claimed here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, configure } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StudioCanvas } from '@/features/studio-v2/StudioCanvas';
import { useStudioStore, selectCanUndo, type StudioNode } from '@/features/studio-v2/store';
import { getNodeDef } from '@/features/studio-v2/registry';
import type { StudioNodeKind } from '@/features/studio-v2/types';
import * as RF from '@xyflow/react';

// Canvas internals tag nodes with data-test (not data-testid); RTL default
// getByTestId only matches data-testid.
configure({ testIdAttribute: 'data-test' });

// ── @xyflow/react → prop-recorder stubs (layout engine only; logic stays real) ──
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  const state = {
    fitView: vi.fn(),
    lastProps: null as Record<string, unknown> | null,
    screenToFlowPosition: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const React = (actual as any).React ?? (await import('react')).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const el = (type: any, props: Record<string, unknown> | null, ...children: unknown[]) =>
    React.createElement(type, props, ...children);
  const passthrough = (props: { children?: unknown }) => props.children as never;
  const StubRF = (props: Record<string, unknown> & { children?: unknown }) => {
    state.lastProps = props;
    return el('div', { 'data-testid': 'rf-stub' }, props.children);
  };
  return {
    ...actual,
    ReactFlow: StubRF,
    ReactFlowProvider: passthrough,
    Background: () => null,
    MiniMap: () => null,
    Controls: () => null,
    useReactFlow: () => ({
      fitView: state.fitView,
      screenToFlowPosition: state.screenToFlowPosition,
      setViewport: vi.fn(),
      zoomIn: vi.fn(), zoomOut: vi.fn(), zoomTo: vi.fn(),
      setCenter: vi.fn(),
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      deleteElements: vi.fn(),
    }),
    __rfState: state,
  };
});

const rfState = (RF as unknown as { __rfState: { fitView: ReturnType<typeof vi.fn>; lastProps: Record<string, unknown> | null; screenToFlowPosition: (p: { x: number; y: number }) => { x: number; y: number } } }).__rfState;

function node(kind: StudioNodeKind, id: string, opts: { selected?: boolean } = {}): StudioNode {
  const def = getNodeDef(kind)!;
  return {
    id,
    type: 'studio',
    position: { x: 0, y: 0 },
    width: def.width,
    data: { ...def.defaultData },
    ...(opts.selected ? { selected: true } : {}),
  } as StudioNode;
}

function reset() {
  useStudioStore.setState({
    nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
    undoStack: [], redoStack: [], clipboard: null, invalidConnection: null,
    dragSnapshot: null, editSnapshot: null,
  });
  rfState.fitView = vi.fn();
  rfState.lastProps = null;
}

/** latest ReactFlow props captured by the stub (after the last CanvasCore render). */
function rfProps(): Record<string, unknown> {
  const p = rfState.lastProps;
  if (!p) throw new Error('ReactFlow stub did not capture props — was StudioCanvas rendered?');
  return p;
}

beforeEach(() => {
  reset();
  // W2: NodePreviewModal (always mounted inside CanvasCore) calls useQueryClient
  // unconditionally, so CanvasCore needs react-query context or it throws and the
  // StudioErrorBoundary swallows the whole canvas (silencing every keyboard
  // handler). Same provider wiring as the sibling v2 canvas test files.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <StudioCanvas />
    </QueryClientProvider>,
  );
});
afterEach(() => { cleanup(); });

describe('G02 RF interaction props — 02 §3 wiring at jsdom level', () => {
  it('zoomOnDoubleClick=false, Space pan activation, MMB pan, no RF Delete, box-select, zoom caps', () => {
    const p = rfProps();
    expect(p.zoomOnDoubleClick).toBe(false);       // double-click reserved for create menu
    expect(p.panActivationKeyCode).toBe('Space');  // Space + LMB pan
    expect(p.panOnDrag).toEqual([1]);              // MMB pan
    expect(p.deleteKeyCode).toBeNull();            // canvas owns Delete (input-guarded)
    expect(p.selectionOnDrag).toBe(true);          // LMB blank drag = box select
    expect(p.zoomOnScroll).toBe(true);
    expect(p.minZoom).toBe(0.05);
    expect(p.maxZoom).toBe(2);
    expect(p.onPaneContextMenu).toEqual(expect.any(Function));
    expect(p.onDoubleClick).toEqual(expect.any(Function));
    expect(p.onConnectEnd).toEqual(expect.any(Function));
    expect(p.onDrop).toEqual(expect.any(Function));
    expect(p.fitView).toBe(true);
  });
});

describe('G05 double-click create ↔ zoomOnDoubleClick=false coexistence', () => {
  it('pane double-click opens the create menu; picking Text adds a node at the pointer flow position', () => {
    const dbl = rfProps().onDoubleClick as (e: unknown) => void;
    const pane = document.createElement('div');
    pane.className = 'react-flow__pane';
    expect(rfProps().zoomOnDoubleClick).toBe(false); // RF must not zoom — menu owns the gesture

    act(() => dbl({ target: pane, clientX: 400, clientY: 300, nativeEvent: { offsetX: 120, offsetY: 60 } }));
    const menu = screen.getByTestId('canvas-context-menu');
    expect(menu).toBeTruthy();

    act(() => { fireEvent.click(screen.getByTestId('context-menu-text')); });
    const st = useStudioStore.getState();
    expect(st.nodes).toHaveLength(1);
    const created = st.nodes[0];
    expect(created.data.nodeKind).toBe('text');
    expect(created.position).toEqual({ x: 400 - 120, y: 300 - 60 }); // menu.fx/fy - half node
    expect(created.selected).toBe(true);
    expect(screen.queryByTestId('canvas-context-menu')).toBeNull(); // menu closed after pick
  });

  it('double-click on a node (non-pane) does NOT open the create menu', () => {
    const dbl = rfProps().onDoubleClick as (e: unknown) => void;
    const nodeEl = document.createElement('div');
    nodeEl.classList.add('react-flow__node');
    act(() => dbl({ target: nodeEl, clientX: 100, clientY: 100, nativeEvent: { offsetX: 10, offsetY: 10 } }));
    expect(screen.queryByTestId('canvas-context-menu')).toBeNull();
  });

  it('Esc closes an open create menu', () => {
    const dbl = rfProps().onDoubleClick as (e: unknown) => void;
    const pane = document.createElement('div');
    pane.className = 'react-flow__pane';
    act(() => dbl({ target: pane, clientX: 200, clientY: 150, nativeEvent: { offsetX: 10, offsetY: 10 } }));
    expect(screen.getByTestId('canvas-context-menu')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByTestId('canvas-context-menu')).toBeNull();
  });
});

describe('G02/G03 Delete & Backspace guard — removeSelection wiring', () => {
  it('Delete on the canvas deletes the selection and is undoable via Ctrl+Z', () => {
    useStudioStore.setState({ nodes: [node('prompt', 'a', { selected: true }), node('prompt', 'b')] });
    fireEvent.keyDown(document.body, { key: 'Delete' });
    expect(useStudioStore.getState().nodes.map((n) => n.id)).toEqual(['b']);

    // Backspace path
    useStudioStore.setState({ nodes: [node('prompt', 'a', { selected: true }), node('prompt', 'b')] });
    fireEvent.keyDown(document.body, { key: 'Backspace' });
    expect(useStudioStore.getState().nodes.map((n) => n.id)).toEqual(['b']);
  });

  it('Delete/Backspace inside a textarea or input is guarded (native editing preserved)', () => {
    useStudioStore.setState({ nodes: [node('prompt', 'a', { selected: true }), node('prompt', 'b')] });
    const ui = render(<textarea data-test="tx" defaultValue="hello" />);
    fireEvent.keyDown(ui.getByTestId('tx'), { key: 'Delete' });
    fireEvent.keyDown(ui.getByTestId('tx'), { key: 'Backspace' });
    expect(useStudioStore.getState().nodes).toHaveLength(2); // untouched

    const inp = render(<input data-test="inp" defaultValue="hello" />);
    fireEvent.keyDown(inp.getByTestId('inp'), { key: 'Delete' });
    expect(useStudioStore.getState().nodes).toHaveLength(2); // untouched
    cleanup();
  });
});

describe('G02 F / Shift+F — fit clamp arguments', () => {
  it('F = fit selected (maxZoom clamp 1.5); Shift+F = fit all; Ctrl+F ignored', () => {
    useStudioStore.setState({
      nodes: [node('prompt', 'sel', { selected: true }), node('prompt', 'other')],
    });

    fireEvent.keyDown(window, { key: 'f' });
    expect(rfState.fitView).toHaveBeenCalledWith({ nodes: [{ id: 'sel' }], padding: 0.3, maxZoom: 1.5, duration: 250 });
    expect(rfState.fitView).not.toHaveBeenCalledWith({ nodes: [{ id: 'other' }], padding: 0.3, maxZoom: 1.5, duration: 250 });

    rfState.fitView.mockClear();
    fireEvent.keyDown(window, { key: 'F', shiftKey: true });
    expect(rfState.fitView).toHaveBeenCalledWith({ padding: 0.15, duration: 250 });

    rfState.fitView.mockClear();
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
    expect(rfState.fitView).not.toHaveBeenCalled(); // Ctrl+F is not the fit contract
  });

  it('F with no selection degrades to fit-all (padding 0.15, no node scoping)', () => {
    useStudioStore.setState({ nodes: [node('prompt', 'a'), node('prompt', 'b')] }); // none selected
    fireEvent.keyDown(window, { key: 'f' });
    expect(rfState.fitView).toHaveBeenCalledWith({ padding: 0.15, duration: 250 });
  });
});

describe('undo/redo keyboard params (G02 §3 rows) + field guard', () => {
  it('Ctrl/Cmd+Z undo, Ctrl+Shift+Z and Ctrl+Y redo, and preventDefault so RF/native never double-handles', () => {
    const { addNode } = useStudioStore.getState();
    act(() => { addNode('prompt', { x: 0, y: 0 }); addNode('prompt', { x: 300, y: 0 }); });
    expect(useStudioStore.getState().nodes).toHaveLength(2);
    expect(selectCanUndo(useStudioStore.getState())).toBe(true); // both adds pushed undo
    expect(useStudioStore.getState().undoStack).toHaveLength(2);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(useStudioStore.getState().nodes).toHaveLength(1); // Ctrl+Z undo

    fireEvent.keyDown(window, { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(useStudioStore.getState().nodes).toHaveLength(2); // Ctrl+Shift+Z redo

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(useStudioStore.getState().nodes).toHaveLength(1); // undo again

    fireEvent.keyDown(window, { key: 'y', ctrlKey: true });
    expect(useStudioStore.getState().nodes).toHaveLength(2); // Ctrl+Y = redo (02 §3 row)

    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(useStudioStore.getState().nodes).toHaveLength(1); // macOS Cmd+Z undo

    const ev = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true); // handler took ownership of the combo
  });

  it('Ctrl+Z typed inside a text field is NOT hijacked (native undo preserved)', () => {
    useStudioStore.setState({ nodes: [node('prompt', 'a')] });
    const ui = render(<textarea data-test="tx2" defaultValue="hello" />);
    fireEvent.keyDown(ui.getByTestId('tx2'), { key: 'z', ctrlKey: true });
    expect(useStudioStore.getState().nodes).toHaveLength(1); // untouched
    cleanup();
  });
});

describe('G05 selection-shortcut wiring — select all / duplicate / group', () => {
  it('Ctrl+A selects all; Ctrl+D duplicates the selection; Ctrl+G wraps it in a frame', () => {
    useStudioStore.setState({ nodes: [node('prompt', 'a'), node('prompt', 'b')] });
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    expect(useStudioStore.getState().nodes.every((n) => n.selected)).toBe(true);

    fireEvent.keyDown(window, { key: 'd', ctrlKey: true });
    expect(useStudioStore.getState().nodes).toHaveLength(4); // 2 originals + 2 clones

    useStudioStore.setState({ nodes: [node('prompt', 'a', { selected: true }), node('prompt', 'b', { selected: true })] });
    fireEvent.keyDown(window, { key: 'g', ctrlKey: true });
    const st = useStudioStore.getState();
    expect(st.nodes).toHaveLength(3);
    expect(st.nodes.some((n) => n.data.nodeKind === 'frame')).toBe(true);
  });
});
