// @vitest-environment jsdom
/**
 * W3 — G06 upload client contract tests.
 * No network: fetch + api.post are stubbed; verify the 3-step flow's URL/body
 * shape, Zod boundary behavior, typed error mapping (incl. 503 OSS unconfigured),
 * and that we never fake a success. uploadFile (Web Crypto SHA-256) is not
 * exercised here — it's the drawer-layer seam, covered by the wiring test.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { upload, UploadApiError } from '@/shared/api/contract/upload-client';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
}));

vi.mock('@/shared/api/client', () => ({
  api: { post: mocks.post, get: mocks.get },
}));

beforeEach(() => {
  mocks.post.mockReset();
  mocks.get.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

function stubFetch(responses: Array<{ status: number; body?: string; headers?: Record<string, string> }>) {
  let call = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return new Response(r.body ?? '', {
      status: r.status,
      headers: r.headers ? { 'content-type': 'application/json', ...r.headers } : { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('upload client (G06 3-step)', () => {
  it('createUpload posts create payload and validates the signed-put response', async () => {
    mocks.post.mockResolvedValue({
      ok: true,
      uploadId: 'm-abc',
      putUrl: 'https://oss.example/x',
      objectKey: 'uploads/p-1/m-abc/a.png',
      contentType: 'image/png',
      expiresIn: 3600,
    });

    const out = await upload.createUpload({
      projectId: 'proj-1',
      filename: 'a.png',
      mime: 'image/png',
      size: 1024,
    });

    expect(mocks.post).toHaveBeenCalledWith('/api/v2/uploads', {
      projectId: 'proj-1',
      filename: 'a.png',
      mime: 'image/png',
      size: 1024,
    });
    expect(out.uploadId).toBe('m-abc');
    expect(out.putUrl).toContain('oss.example');
  });

  it('createUpload surfaces a 503 OSS-unconfigured as a typed storage error', async () => {
    mocks.post.mockRejectedValue(
      (() => {
        const e = new Error('UPLOAD_STORAGE_UNCONFIGURED') as Error & { status?: number; body?: unknown };
        e.status = 503;
        e.body = { ok: false, code: 'UPLOAD_STORAGE_UNCONFIGURED' };
        return e;
      })(),
    );

    await expect(
      upload.createUpload({ projectId: 'p', filename: 'a.png', mime: 'image/png', size: 1 }),
    ).rejects.toSatisfy((e) => e instanceof UploadApiError && e.isStorageUnconfigured && e.status === 503);
  });

  it('createUpload rejects a malformed (non-signed-put) response shape', async () => {
    mocks.post.mockResolvedValue({ ok: true, uploadId: 'x' }); // missing putUrl/objectKey/contentType
    await expect(
      upload.createUpload({ projectId: 'p', filename: 'a.png', mime: 'image/png', size: 1 }),
    ).rejects.toBeInstanceOf(UploadApiError);
  });

  it('putBytes PUTs raw bytes to the signed URL with the mime Content-Type', async () => {
    const fn = stubFetch([{ status: 200, body: '' }]);
    const blob = new Blob(['hello'], { type: 'image/png' });

    await upload.putBytes('https://oss.example/x', blob, 'image/png');

    const url = String((fn.mock.calls[0] as unknown as [string, RequestInit?])[0]);
    const init = (fn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(url).toBe('https://oss.example/x');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('image/png');
  });

  it('putBytes surfaces a non-OK OSS response as an error', async () => {
    stubFetch([{ status: 403, body: 'Forbidden' }]);
    await expect(upload.putBytes('https://oss.example/x', new Blob([], { type: 'application/octet-stream' }), 'x')).rejects.toBeInstanceOf(
      UploadApiError,
    );
  });

  it('finalizeUpload posts checksum+sizeBytes and validates the ok envelope', async () => {
    mocks.post.mockResolvedValue({ ok: true, probeJobId: 'job-1', plannedJobs: ['job-1'] });

    const out = await upload.finalizeUpload('m-abc', { checksumSha256: 'a'.repeat(64), sizeBytes: 1024 });

    expect(mocks.post).toHaveBeenCalledWith('/api/v2/uploads/m-abc/finalize', {
      checksumSha256: 'a'.repeat(64),
      sizeBytes: 1024,
    });
    expect(out.ok).toBe(true);
    expect(out.probeJobId).toBe('job-1');
  });

  it('finalizeUpload treats alreadyFinalized as a valid (idempotent) retry', async () => {
    mocks.post.mockResolvedValue({ ok: true, alreadyFinalized: true });
    const out = await upload.finalizeUpload('m-abc', { checksumSha256: 'a'.repeat(64), sizeBytes: 1 });
    expect(out.alreadyFinalized).toBe(true);
  });
});
