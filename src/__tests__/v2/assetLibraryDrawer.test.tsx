// @vitest-environment jsdom
// G-v2.0 must#6 — AssetLibraryDrawer version-browsing UI.
// Covers: select-asset → GET versions list renders rows (ordinal/kind/status/
// size/time), silent empty state (empty payload AND failed load), debounce +
// race guards (rapid asset switching, stale list response dropped), and the
// row-click single-version GET with inline detail (storageKey never rendered).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AssetLibraryDrawer } from '@/features/studio-v2/AssetLibraryDrawer';
import type { AssetVersionSummary } from '@/features/studio-v2/AssetLibraryDrawer';

configure({ testIdAttribute: 'data-test' });

const mocks = vi.hoisted(() => ({
  listProjectAssets: vi.fn(),
  getAsset: vi.fn(),
  apiGet: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock('@/shared/api/contract/asset-client', () => ({
  v2asset: {
    listProjectAssets: mocks.listProjectAssets,
    getAsset: mocks.getAsset,
  },
}));

vi.mock('@/shared/api/client', () => ({ api: { get: mocks.apiGet } }));

afterEach(cleanup);

function Providers({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function asset(id: string, title: string) {
  return {
    assetId: id,
    title,
    assetType: 'IMAGE',
    origin: 'UPLOAD',
    status: 'ready',
    thumbnailUrl: '',
    url: '',
  };
}

function version(overrides: Partial<AssetVersionSummary>): AssetVersionSummary {
  return {
    versionId: 'av-1',
    kind: 'generated',
    status: 'ready',
    sizeBytes: 2_048_000,
    createdAt: '2026-09-04T06:00:00.000Z',
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderDrawer(assetsArr: ReturnType<typeof asset>[]) {
  mocks.listProjectAssets.mockResolvedValue({
    assets: assetsArr,
    pagination: { hasMore: false },
  });
  // Lazy per-item detail (favorite star) failures are swallowed by the drawer.
  mocks.getAsset.mockRejectedValue(new Error('detail-unavailable'));
  render(
    <Providers>
      <AssetLibraryDrawer projectId="p1" onClose={mocks.onClose} />
    </Providers>,
  );
  await screen.findByTestId('asset-library-list');
}

function assetClicks() {
  return mocks.apiGet.mock.calls.map((c) => String(c[0]));
}

/** Wait past the selection debounce then flush any in-flight list response. */
async function settleVersions() {
  await new Promise((r) => setTimeout(r, 350));
  await act(async () => {});
}

beforeEach(() => {
  mocks.listProjectAssets.mockReset();
  mocks.getAsset.mockReset();
  mocks.apiGet.mockReset();
  mocks.onClose.mockReset();
});

describe('AssetLibraryDrawer — version browsing', () => {
  it('selecting an asset GETs its versions and lists rows (kind/status/size/time + count)', async () => {
    const newest = version({ versionId: 'av-2', createdAt: '2026-09-04T07:00:00.000Z' });
    const oldest = version({ versionId: 'av-1', createdAt: '2026-09-04T06:00:00.000Z', kind: 'derived', status: 'failed', sizeBytes: 512 });
    mocks.apiGet.mockResolvedValue({ ok: true, versions: [newest, oldest] }); // server order: newest first

    await renderDrawer([asset('m-1', '首图')]);
    fireEvent.click(screen.getByTestId('asset-library-item-m-1'));
    await settleVersions();

    await waitFor(() => expect(assetClicks()).toContain('/api/v2/uploads/m-1/versions'));
    expect(assetClicks().filter((p) => p.endsWith('/m-1/versions'))).toHaveLength(1);

    // Panel + count + rows (oldest first: v1 = derived, v2 = generated).
    expect(screen.getByTestId('asset-versions-m-1')).toBeTruthy();
    expect(screen.getByTestId('asset-versions-count-m-1').textContent).toBe('2');
    const row1 = screen.getByTestId('asset-version-row-av-1');
    expect(row1.textContent).toContain('v1');
    expect(row1.textContent).toContain('派生');
    expect(row1.textContent).toContain('失败');
    expect(row1.textContent).toContain('512 B');
    const row2 = screen.getByTestId('asset-version-row-av-2');
    expect(row2.textContent).toContain('v2');
    expect(row2.textContent).toContain('生成');
    expect(row2.textContent).toContain('就绪');
    expect(row2.textContent).toContain('2.0 MB');
    expect(row2.textContent).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it('re-clicking the selected asset collapses the versions panel (data stays cached)', async () => {
    mocks.apiGet.mockResolvedValue({ ok: true, versions: [version({ versionId: 'av-1' })] });
    await renderDrawer([asset('m-1', '首图')]);

    fireEvent.click(screen.getByTestId('asset-library-item-m-1'));
    await settleVersions();
    await waitFor(() => expect(screen.getByTestId('asset-version-row-av-1')).toBeTruthy());
    const callsAfterLoad = assetClicks().filter((p) => p.endsWith('/m-1/versions')).length;

    fireEvent.click(screen.getByTestId('asset-library-item-m-1')); // collapse
    expect(screen.queryByTestId('asset-version-row-av-1')).toBeNull();
    expect(screen.getByTestId('asset-versions-m-1')).toBeTruthy(); // header stays

    fireEvent.click(screen.getByTestId('asset-library-item-m-1')); // expand again
    await waitFor(() => expect(screen.getByTestId('asset-version-row-av-1')).toBeTruthy());
    // Cache hit — no second list request for the same asset.
    expect(assetClicks().filter((p) => p.endsWith('/m-1/versions'))).toHaveLength(callsAfterLoad);
  });

  it('empty versions render the silent empty state (no error UI)', async () => {
    mocks.apiGet.mockResolvedValue({ ok: true, versions: [] });
    await renderDrawer([asset('m-1', '首图')]);

    fireEvent.click(screen.getByTestId('asset-library-item-m-1'));
    await settleVersions();

    await waitFor(() => expect(screen.getByTestId('asset-versions-empty-m-1').textContent).toContain('暂无版本'));
    expect(screen.queryByTestId('asset-library-error')).toBeNull();
    expect(screen.queryByText(/加载失败|错误/i)).toBeNull();
  });

  it('a failed versions load also lands in the silent empty state (never an error)', async () => {
    mocks.apiGet.mockRejectedValue(new Error('boom'));
    await renderDrawer([asset('m-1', '首图')]);

    fireEvent.click(screen.getByTestId('asset-library-item-m-1'));
    await settleVersions();

    await waitFor(() => expect(screen.getByTestId('asset-versions-empty-m-1').textContent).toContain('暂无版本'));
    expect(screen.queryByTestId('asset-versions-count-m-1')).toBeNull();
    expect(screen.queryByText(/失败|错误|无法/i)).toBeNull();
  });

  it('rapid asset switching is debounced: only the last selected asset is fetched', async () => {
    await renderDrawer([asset('m-1', '甲'), asset('m-2', '乙')]);

    fireEvent.click(screen.getByTestId('asset-library-item-m-1'));
    fireEvent.click(screen.getByTestId('asset-library-item-m-2'));
    await settleVersions();

    await waitFor(() => expect(assetClicks()).toContain('/api/v2/uploads/m-2/versions'));
    expect(assetClicks().filter((p) => p.includes('/m-1/versions'))).toHaveLength(0);
    expect(assetClicks().filter((p) => p.includes('/versions'))).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId('asset-versions-m-2')).toBeTruthy());
    expect(screen.queryByTestId('asset-versions-m-1')).toBeNull();
  });

  it('a stale in-flight list response is dropped when the selection moves on (race guard)', async () => {
    const slowA = deferred<{ ok: boolean; versions: AssetVersionSummary[] }>();
    mocks.apiGet.mockImplementation((path: string) => {
      if (path.endsWith('/m-1/versions')) return slowA.promise; // m-1 hangs
      if (path.endsWith('/m-2/versions')) return Promise.resolve({ ok: true, versions: [version({ versionId: 'av-b', createdAt: '2026-09-04T08:00:00.000Z' })] });
      return Promise.resolve({ ok: true, version: {} });
    });
    await renderDrawer([asset('m-1', '甲'), asset('m-2', '乙')]);

    fireEvent.click(screen.getByTestId('asset-library-item-m-1'));
    await new Promise((r) => setTimeout(r, 350)); // debounce passes, m-1 request is in flight (still pending)
    fireEvent.click(screen.getByTestId('asset-library-item-m-2'));

    // m-2 completes normally and renders.
    await waitFor(() => expect(screen.getByTestId('asset-version-row-av-b')).toBeTruthy());
    expect(screen.getByTestId('asset-versions-m-2')).toBeTruthy();

    // Now m-1's stale response finally lands — it must NOT overwrite the panel.
    await act(async () => {
      slowA.resolve({ ok: true, versions: [version({ versionId: 'av-stale', createdAt: '2026-09-04T09:00:00.000Z' })] });
    });
    expect(screen.queryByTestId('asset-version-row-av-stale')).toBeNull();
    expect(screen.getByTestId('asset-version-row-av-b')).toBeTruthy();
  });

  it('row click GETs the single version and shows inline detail without storageKey', async () => {
    mocks.apiGet.mockImplementation((path: string) => {
      if (path.endsWith('/m-1/versions')) {
        return Promise.resolve({ ok: true, versions: [version({ versionId: 'av-1' })] });
      }
      if (path.includes('/uploads/versions/av-1')) {
        return Promise.resolve({
          ok: true,
          version: {
            ...version({ versionId: 'av-1' }),
            model: 'test-model-x',
            provider: 'oss',
            storageKey: 'derived/secret-bucket/path/probe.bin', // must never surface
          },
        });
      }
      return Promise.resolve({ ok: true, version: {} });
    });
    await renderDrawer([asset('m-1', '首图')]);

    fireEvent.click(screen.getByTestId('asset-library-item-m-1'));
    await settleVersions();
    await waitFor(() => expect(screen.getByTestId('asset-version-row-av-1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('asset-version-toggle-av-1'));
    await waitFor(() => expect(assetClicks()).toContain('/api/v2/uploads/versions/av-1'));

    const detail = await screen.findByTestId('asset-version-detail-av-1');
    expect(detail.textContent).toContain('生成');
    expect(detail.textContent).toContain('test-model-x');
    expect(detail.textContent).toContain('oss');
    expect(detail.textContent).not.toContain('secret-bucket');
    expect(detail.textContent).not.toContain('storageKey');
  });
});
