// @vitest-environment jsdom
/**
 * W3 — AssetLibraryDrawer upload wiring (G06 3-step flow).
 * The drawer's upload button was previously stubbed-disabled ("待接"); this
 * confirms it now drives uploadFile and surfaces honest success / OSS-unconfigured
 * states. asset-client (list) and the api client are mocked; uploadFile is the
 * mocked seam so no real network / Web Crypto runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AssetLibraryDrawer } from '@/features/studio-v2/AssetLibraryDrawer';

configure({ testIdAttribute: 'data-test' });

const mocks = vi.hoisted(() => ({
  listProjectAssets: vi.fn(),
  getAsset: vi.fn(),
  apiGet: vi.fn(),
  uploadFile: vi.fn(),
  onClose: vi.fn(),
  UploadApiError: null as unknown as new (status: number, message: string) => Error,
}));

vi.mock('@/shared/api/contract/asset-client', () => ({
  v2asset: { listProjectAssets: mocks.listProjectAssets, getAsset: mocks.getAsset },
}));

vi.mock('@/shared/api/contract/upload-client', () => {
  class UploadApiError extends Error {
    status: number;
    payload: unknown;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'UploadApiError';
      this.status = status;
      this.payload = null;
    }
    get isStorageUnconfigured() {
      return this.status === 503;
    }
  }
  mocks.UploadApiError = UploadApiError;
  return { uploadFile: mocks.uploadFile, UploadApiError };
});

vi.mock('@/shared/api/client', () => ({ api: { get: mocks.apiGet } }));

afterEach(cleanup);

beforeEach(() => {
  mocks.listProjectAssets.mockReset();
  mocks.getAsset.mockReset();
  mocks.apiGet.mockReset();
  mocks.uploadFile.mockReset();
});

function Providers({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function renderDrawer() {
  mocks.listProjectAssets.mockResolvedValue({
    projectId: 'proj-1',
    assets: [{ assetId: 'm-1', title: 'pic', assetType: 'IMAGE', origin: 'UPLOAD', status: 'ready', thumbnailUrl: '', url: '' }],
    pagination: { limit: 200, offset: 0, total: 1, hasMore: false },
  });
  mocks.apiGet.mockResolvedValue({ versions: [] });
  return render(
    <Providers>
      <AssetLibraryDrawer projectId="proj-1" onClose={mocks.onClose} />
    </Providers>,
  );
}

function file() {
  return new File(['a'], 'a.png', { type: 'image/png' });
}

describe('AssetLibraryDrawer upload (W3)', () => {
  it('uploads a picked file and refreshes the asset list on success', async () => {
    mocks.uploadFile.mockResolvedValue({ assetId: 'm-new', checksumSha256: 'a'.repeat(64) });
    renderDrawer();

    const input = await screen.findByTestId('asset-library-upload-input');
    fireEvent.change(input, { target: { files: [file()] } });

    await waitFor(() => expect(mocks.uploadFile).toHaveBeenCalledWith('proj-1', expect.any(File)));
    // invalidateQueries refetches the list past the initial render.
    await waitFor(() => expect(mocks.listProjectAssets.mock.calls.length).toBeGreaterThanOrEqual(2));
    // success state clears the inline status note and marks the badge.
    await waitFor(() => expect(screen.getByText('uploaded')).toBeTruthy());
  });

  it('surfaces an honest OSS-unconfigured error without faking success', async () => {
    mocks.uploadFile.mockRejectedValue(
      new (mocks.UploadApiError as unknown as new (status: number, message: string) => Error)(503, 'UPLOAD_STORAGE_UNCONFIGURED'),
    );
    renderDrawer();

    const input = await screen.findByTestId('asset-library-upload-input');
    fireEvent.change(input, { target: { files: [file()] } });

    await waitFor(() => expect(screen.getByTestId('asset-library-upload-status')).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByText('对象存储未配置，本次测试环境仅开放只读素材库')).toBeTruthy(),
    );
    expect(mocks.uploadFile).not.toHaveBeenCalledTimes(0);
    expect(mocks.listProjectAssets.mock.calls.length).toBe(1); // no refetch on failure
  });
});
