// @vitest-environment jsdom
/**
 * W5b — canvas node lock (本地/会话级编辑锁, UX layer; does NOT replace server
 * CAS). Pins three surfaces:
 *   1. store.lockNode(id, locked) toggles the authoritative `lockedNodeIds`
 *      registry + mirrors `data.locked` + sets react-flow `draggable`.
 *   2. store-action 防呆双保险: updateNodeData / updateNodeParameter /
 *      replaceNodeParameters reject a locked node with {ok:false, code:'NODE_LOCKED'}.
 *   3. StudioNode renders the corner 🔒 badge when data.locked is true and the
 *      badge click is the unlock entry (徽标点击).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, configure, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NodeProps } from '@xyflow/react';
import type { ReactNode } from 'react';
import { useStudioStore } from './store';
import { StudioNodeComponent } from './StudioNode';
import { getNodeDef } from './registry';
import { v2asset } from '@/shared/api/contract/asset-client';
import type { StudioNode } from './store';
import type { StudioNodeData } from './types';

// Canvas internals tag nodes with data-test (not data-testid); RTL default
// getByTestId only matches data-testid.
configure({ testIdAttribute: 'data-test' });

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return { ...actual, Handle: () => null, NodeResizer: () => null };
});

vi.mock('@/shared/api/contract/asset-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/api/contract/asset-client')>();
  return { ...actual, v2asset: { ...actual.v2asset, getAsset: vi.fn() } };
});

function qc(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function promptNodeData(extra: Record<string, unknown> = {}): StudioNodeData {
  return { ...getNodeDef('prompt')!.defaultData, ...extra } as StudioNodeData;
}

function loadNode(id: string, data?: StudioNodeData): void {
  const def = getNodeDef('prompt')!;
  const node: StudioNode = {
    id,
    type: 'studio',
    position: { x: 0, y: 0 },
    width: def.width,
    data: data ?? promptNodeData(),
  };
  useStudioStore.getState().loadGraph([node], [], { x: 0, y: 0, zoom: 1 });
}

function renderNode(data: StudioNodeData) {
  const def = getNodeDef(data.nodeKind)!;
  const node = { id: 'n1', type: 'studio', position: { x: 0, y: 0 }, width: def.width, data } as StudioNode;
  const props = { id: node.id, data: node.data, selected: false, width: node.width } as unknown as NodeProps<StudioNode>;
  return render(qc(<StudioNodeComponent {...props} />));
}

beforeEach(() => {
  vi.clearAllMocks();
  useStudioStore.getState().resetProjectState();
});
afterEach(cleanup);

describe('store.lockNode — lock/unlock (W5b)', () => {
  it('lock: adds id to lockedNodeIds, writes data.locked, draggable=false', () => {
    loadNode('n1');
    useStudioStore.getState().lockNode('n1', true);

    const s = useStudioStore.getState();
    expect(s.lockedNodeIds.has('n1')).toBe(true);
    const n = s.nodes.find((x) => x.id === 'n1')!;
    expect(n.data.locked).toBe(true);
    expect(n.draggable).toBe(false);
  });

  it('unlock: removes id from the set, data.locked=false, draggable restored', () => {
    loadNode('n1');
    useStudioStore.getState().lockNode('n1', true);
    useStudioStore.getState().lockNode('n1', false);

    const s = useStudioStore.getState();
    expect(s.lockedNodeIds.has('n1')).toBe(false);
    const n = s.nodes.find((x) => x.id === 'n1')!;
    expect(n.data.locked).toBe(false);
    expect(n.draggable).toBe(true);
  });

  it('lockNode on a missing node is a no-op (no set growth)', () => {
    loadNode('n1');
    useStudioStore.getState().lockNode('missing', true);
    expect(useStudioStore.getState().lockedNodeIds.size).toBe(0);
  });
});

describe('store-action rejection while locked (W5b 防呆双保险)', () => {
  it('updateNodeData → {ok:false, code:NODE_LOCKED} and data unchanged', () => {
    loadNode('n1');
    useStudioStore.getState().lockNode('n1', true);

    const res = useStudioStore.getState().updateNodeData('n1', { title: 'hacked' });

    expect(res).toEqual({ ok: false, code: 'NODE_LOCKED' });
    expect(useStudioStore.getState().nodes.find((x) => x.id === 'n1')!.data.title).toBe('Prompt');
  });

  it('updateNodeParameter → {ok:false, code:NODE_LOCKED}', () => {
    loadNode('n1');
    useStudioStore.getState().lockNode('n1', true);

    expect(useStudioStore.getState().updateNodeParameter('n1', 'prompt', 'new')).toEqual({ ok: false, code: 'NODE_LOCKED' });
  });

  it('replaceNodeParameters → {ok:false, code:NODE_LOCKED}', () => {
    loadNode('n1');
    useStudioStore.getState().lockNode('n1', true);

    expect(useStudioStore.getState().replaceNodeParameters('n1', { prompt: 'new' }, ['prompt'])).toEqual({ ok: false, code: 'NODE_LOCKED' });
  });

  it('an unlocked node edit succeeds with {ok:true}', () => {
    loadNode('n1');
    const res = useStudioStore.getState().updateNodeData('n1', { title: 'edited' });

    expect(res).toEqual({ ok: true });
    expect(useStudioStore.getState().nodes.find((x) => x.id === 'n1')!.data.title).toBe('edited');
  });
});

describe('StudioNode lock badge rendering (W5b)', () => {
  it('renders the 🔒 badge when data.locked is true', () => {
    renderNode(promptNodeData({ locked: true }));

    const badge = screen.getByTestId('node-lock-badge');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain('🔒');
  });

  it('renders no badge when unlocked', () => {
    renderNode(promptNodeData({}));

    expect(screen.queryByTestId('node-lock-badge')).toBeNull();
  });

  it('badge click is the unlock entry → lockNode(id, false)', () => {
    loadNode('n1');
    useStudioStore.getState().lockNode('n1', true);
    renderNode(promptNodeData({ locked: true }));

    fireEvent.click(screen.getByTestId('node-lock-badge'));

    expect(useStudioStore.getState().lockedNodeIds.has('n1')).toBe(false);
    expect(useStudioStore.getState().nodes.find((x) => x.id === 'n1')!.data.locked).toBe(false);
  });
});
