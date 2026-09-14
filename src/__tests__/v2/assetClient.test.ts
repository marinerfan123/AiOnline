// @vitest-environment jsdom
/**
 * M04-S — Asset client contract tests.
 * No network: fetch is stubbed and assertions verify URL shape, pagination,
 * Zod boundary validation, and stable assetId identity use.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { v2asset } from '@/shared/api/contract/asset-client';

function mockFetch(responses: Array<{ status: number; body: string }>) {
  let call = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const asset = {
  assetId: 'm-asset-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  ownerId: 'u-1',
  assetType: 'IMAGE',
  mimeType: 'image/png',
  status: 'READY',
  storageProvider: 'provider',
  width: 512,
  height: 512,
  durationMs: null,
  sizeBytes: 123,
  title: 'local fixture',
  url: 'http://127.0.0.1/test-fixtures/asset.png',
  thumbnailUrl: 'http://127.0.0.1/test-fixtures/asset-thumb.png',
  origin: 'UPLOAD',
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:01.000Z',
};

afterEach(() => vi.unstubAllGlobals());

describe('v2asset client (M04-S)', () => {
  it('listProjectAssets builds paginated project query and validates response', async () => {
    const fn = mockFetch([{
      status: 200,
      body: JSON.stringify({ projectId: 'proj-1', assets: [asset], pagination: { limit: 24, offset: 0, total: 1, hasMore: false } }),
    }]);

    const out = await v2asset.listProjectAssets('proj-1', { type: 'IMAGE', search: 'local', limit: 24, offset: 0 });

    const url = String((fn.mock.calls[0] as unknown as [string, RequestInit?])[0]);
    expect(url).toContain('/api/v2/projects/proj-1/assets?');
    expect(url).toContain('type=IMAGE');
    expect(url).toContain('search=local');
    expect(url).toContain('limit=24');
    expect(out.assets[0].assetId).toBe('m-asset-1');
    expect(out.assets[0].url).toContain('/test-fixtures/asset.png');
  });

  it('getAsset returns detail with provenance without treating URL as identity', async () => {
    mockFetch([{
      status: 200,
      body: JSON.stringify({ asset: { ...asset, ratio: '1:1', tags: [], isFavorite: false, ossUploaded: false, errorMessage: null, failedAt: null, provenance: { origin: 'UPLOAD', generationTaskId: null, generationBatchId: null, prompt: null, model: null } } }),
    }]);

    const out = await v2asset.getAsset('m-asset-1');

    expect(out.asset.assetId).toBe('m-asset-1');
    expect(out.asset.url).not.toBe(out.asset.assetId);
    expect(out.asset.provenance.origin).toBe('UPLOAD');
  });

  it('writeAsset rejects ambiguous create/register input before fetch', async () => {
    const fn = mockFetch([]);
    await expect(v2asset.writeAsset({ projectId: 'proj-1', assetId: 'm-1', url: 'http://127.0.0.1/a.png' })).rejects.toBeTruthy();
    expect(fn).not.toHaveBeenCalled();
  });
});
