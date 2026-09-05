// @vitest-environment jsdom
/**
 * W2 — NodePreviewModal: double-click node → output preview / download / re-run.
 *
 * Covers the five required leaves:
 *   ① modal opens (open=true renders the dialog content);
 *   ② output rendering (v2asset.getAsset → main <img>);
 *   ③ video branch (<video controls> on the direct url for VIDEO assets);
 *   ④ no-output empty state ("尚未生成，点 Run 执行");
 *   ⑤ download button presence.
 * Plus the re-run action (studioRunClient.runNode → onClose on success).
 *
 * Only the asset client, the run client and sonner (toast) are stubbed; the
 * modal, Dialog primitive and query wiring are all real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NodePreviewModal } from './NodePreviewModal';
import type { StudioNode } from './store';
import type { StudioNodeData } from './types';

const mocks = vi.hoisted(() => ({
  getAsset: vi.fn(),
  runNode: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/shared/api/contract/asset-client', () => ({
  v2asset: { getAsset: mocks.getAsset },
}));

vi.mock('./run/studioRunClient', () => ({
  studioRunClient: { runNode: mocks.runNode },
}));

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    message: vi.fn(),
    promise: vi.fn(),
    custom: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
  Toaster: () => null,
}));

function makeNode(extra: Record<string, unknown> = {}): StudioNode {
  const data = {
    nodeKind: 'text-to-video',
    nodeType: 'text-to-video',
    schemaVersion: 1,
    title: '视频节点',
    parameters: {},
    status: 'READY',
    ...extra,
  } as StudioNodeData;
  return { id: 'n1', type: 'studio', position: { x: 0, y: 0 }, data } as StudioNode;
}

function renderModal(opts: {
  open?: boolean;
  node?: StudioNode;
  projectId?: string;
  canvasRevision?: number | null;
  onClose?: () => void;
} = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NodePreviewModal
        open={opts.open ?? true}
        node={opts.node ?? makeNode()}
        projectId={opts.projectId ?? 'p1'}
        canvasRevision={opts.canvasRevision ?? 3}
        onClose={opts.onClose ?? (() => {})}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.getAsset.mockReset();
  mocks.runNode.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
});
afterEach(cleanup);

describe('NodePreviewModal (W2)', () => {
  it('opens the modal (dialog content renders when open=true)', () => {
    renderModal({ open: true });
    expect(screen.getByTestId('node-preview-modal')).toBeTruthy();
  });

  it('resolves output assets and renders the main <img>', async () => {
    mocks.getAsset.mockResolvedValue({
      asset: { assetId: 'm-1', assetType: 'IMAGE', url: 'https://cdn.example/out.png', thumbnailUrl: 'https://cdn.example/thumb.png' },
    });

    renderModal({ node: makeNode({ outputAssetIds: ['m-1'] }) });

    const img = await screen.findByTestId('node-preview-image');
    expect(img.getAttribute('src')).toBe('https://cdn.example/out.png');
    expect(mocks.getAsset).toHaveBeenCalledWith('m-1');
  });

  it('renders a <video controls> on the direct url for VIDEO assets', async () => {
    mocks.getAsset.mockResolvedValue({
      asset: { assetId: 'm-v', assetType: 'VIDEO', url: 'https://cdn.example/out.mp4', thumbnailUrl: '' },
    });

    renderModal({ node: makeNode({ outputAssetIds: ['m-v'] }) });

    const video = await screen.findByTestId('node-preview-video');
    expect(video.tagName.toLowerCase()).toBe('video');
    expect(video.getAttribute('src')).toBe('https://cdn.example/out.mp4');
    expect(video.hasAttribute('controls')).toBe(true);
  });

  it('shows the empty state ("尚未生成，点 Run 执行") when there are no output assets', () => {
    renderModal({ node: makeNode({}) });

    const empty = screen.getByTestId('node-preview-empty');
    expect(empty.textContent).toContain('尚未生成');
    expect(empty.textContent).toContain('Run');
    expect(mocks.getAsset).not.toHaveBeenCalled();
  });

  it('renders a download button once an asset url resolves', async () => {
    mocks.getAsset.mockResolvedValue({
      asset: { assetId: 'm-1', assetType: 'IMAGE', url: 'https://cdn.example/out.png', thumbnailUrl: '' },
    });

    renderModal({ node: makeNode({ outputAssetIds: ['m-1'] }) });

    await screen.findByTestId('node-preview-image');
    expect(screen.getByTestId('node-preview-download')).toBeTruthy();
  });

  it('re-runs the node via studioRunClient.runNode and closes on success', async () => {
    mocks.getAsset.mockResolvedValue({
      asset: { assetId: 'm-1', assetType: 'IMAGE', url: 'https://cdn.example/out.png', thumbnailUrl: '' },
    });
    mocks.runNode.mockResolvedValue({ runId: 'run-1', status: 'QUEUED', idempotent: false });
    const onClose = vi.fn();

    renderModal({ node: makeNode({ outputAssetIds: ['m-1'] }), onClose });

    await screen.findByTestId('node-preview-image');
    fireEvent.click(screen.getByTestId('node-preview-run'));

    await waitFor(() =>
      expect(mocks.runNode).toHaveBeenCalledWith({ projectId: 'p1', nodeId: 'n1', canvasRevision: 3 }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });
});
