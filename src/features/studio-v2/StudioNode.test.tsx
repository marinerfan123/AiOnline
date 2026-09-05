// @vitest-environment jsdom
/**
 * W1B — StudioNode output-thumbnail badge.
 * Contract: a node whose data carries a durable output asset id (§119
 * outputAssetIds / output_asset_ids, or a single media_id) renders a
 * bottom-left thumbnail resolved through the M04-S asset read endpoint
 * (v2asset.getAsset → GET /api/v2/assets/:assetId). Thumb first, full
 * fallback; no ids → no badge (honest empty state, never fake media).
 *
 * Only the third-party @xyflow/react handle/resizer primitives and the
 * asset client are stubbed; the node renderer, registry and query wiring
 * are all real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, configure } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NodeProps } from '@xyflow/react';
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
  return {
    ...actual,
    Handle: () => null,
    NodeResizer: () => null,
  };
});

vi.mock('@/shared/api/contract/asset-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/api/contract/asset-client')>();
  return { ...actual, v2asset: { ...actual.v2asset, getAsset: vi.fn() } };
});

function qc(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderNode(data: StudioNodeData) {
  const def = getNodeDef(data.nodeKind)!;
  const node = { id: 'n1', type: 'studio', position: { x: 0, y: 0 }, width: def.width, data } as StudioNode;
  const props = { id: node.id, data: node.data, selected: false, width: node.width } as unknown as NodeProps<StudioNode>;
  return render(qc(<StudioNodeComponent {...props} />));
}

function vidNodeData(extra: Partial<StudioNodeData> = {}): StudioNodeData {
  return { ...getNodeDef('text-to-video')!.defaultData, ...extra } as StudioNodeData;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('StudioNode output-thumbnail badge (W1B)', () => {
  it('renders an <img> thumbnail for the first outputAssetId, thumb over full', async () => {
    vi.mocked(v2asset.getAsset).mockResolvedValueOnce({
      asset: { assetId: 'media-1', assetType: 'VIDEO', thumbnailUrl: 'https://cdn.example/thumb.jpg', url: 'https://cdn.example/full.mp4' },
    } as never);

    renderNode(vidNodeData({ outputAssetIds: ['media-1', 'media-2'] }));

    const badge = await screen.findByTestId('output-thumb-badge');
    expect(badge.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/thumb.jpg');
    expect(vi.mocked(v2asset.getAsset)).toHaveBeenCalledWith('media-1');
  });

  it('renders no badge (empty state) when there are no output asset ids', () => {
    renderNode(vidNodeData({}));

    expect(screen.queryByTestId('output-thumb-badge')).toBeNull();
    expect(vi.mocked(v2asset.getAsset)).not.toHaveBeenCalled();
  });

  it('falls back to the full URL when thumbnailUrl is empty (URL resolution)', async () => {
    vi.mocked(v2asset.getAsset).mockResolvedValueOnce({
      asset: { assetId: 'media-3', assetType: 'IMAGE', thumbnailUrl: '', url: 'https://cdn.example/full.png' },
    } as never);

    renderNode(vidNodeData({ outputAssetIds: ['media-3'] }));

    const badge = await screen.findByTestId('output-thumb-badge');
    expect(badge.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/full.png');
  });

  it('accepts snake_case output_asset_ids and a single media_id fallback', async () => {
    vi.mocked(v2asset.getAsset).mockResolvedValue({
      asset: { assetId: 'media-x', assetType: 'IMAGE', thumbnailUrl: 'https://cdn.example/x.jpg', url: '' },
    } as never);

    renderNode(vidNodeData({ output_asset_ids: ['media-x'] } as Partial<StudioNodeData>));
    expect((await screen.findByTestId('output-thumb-badge')).querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/x.jpg');
    expect(vi.mocked(v2asset.getAsset)).toHaveBeenCalledWith('media-x');

    cleanup();
    renderNode(vidNodeData({ media_id: 'media-single' } as Partial<StudioNodeData>));
    expect((await screen.findByTestId('output-thumb-badge')).querySelector('img')?.getAttribute('src')).toBe('https://cdn.example/x.jpg');
    expect(vi.mocked(v2asset.getAsset)).toHaveBeenCalledWith('media-single');
  });
});
