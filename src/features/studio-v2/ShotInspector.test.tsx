// @vitest-environment jsdom
// W1-11 — Shot Inspector core UI: echo, save (optimistic version), validation,
// 409 STALE_SHOT_VERSION refetch+prompt. Locked fields are read-only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, configure } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ShotInspector } from './ShotInspector';
import { ShotInspectorApiError, type Shot } from '@/shared/api/contract/studio-shot-inspector-client';

configure({ testIdAttribute: 'data-test' });

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/shared/api/contract/studio-shot-inspector-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/api/contract/studio-shot-inspector-client')>();
  return {
    ...actual,
    studioShotInspectorClient: { list: mocks.list, update: mocks.update },
  };
});

afterEach(cleanup);

function Providers({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function baseShot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: 'shot-1',
    episodeId: 'ep-1',
    canvasNodeId: 'node-9',
    seq: 3,
    assetId: null,
    durationSeconds: 5,
    note: '打开镜头',
    title: 'Opening',
    storyIntent: { tension: 'high' },
    cinematography: 'slow push-in',
    context: '夜内景',
    generationMeta: { model: 'video-v1' },
    output: { assetId: 'asset-out-1' },
    commerce: { sku: 'SKU-1' },
    version: 7,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function renderShot(projectId = 'proj-1', episodeId = 'ep-1', shotId = 'shot-1') {
  render(
    <Providers>
      <ShotInspector projectId={projectId} episodeId={episodeId} shotId={shotId} />
    </Providers>,
  );
  // wait for the shots query to resolve and the seed effect to populate the form
  await waitFor(() => expect(screen.queryByTestId('shot-title')).toBeTruthy());
}

describe('ShotInspector — echo (server truth)', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.update.mockReset();
    mocks.list.mockResolvedValue({ shots: [baseShot()] });
  });

  it('echoes the server core fields into the form', async () => {
    await renderShot();
    expect((screen.getByTestId('shot-title') as HTMLInputElement).value).toBe('Opening');
    expect((screen.getByTestId('shot-seq') as HTMLInputElement).value).toBe('3');
    expect((screen.getByTestId('shot-duration') as HTMLInputElement).value).toBe('5');
    expect((screen.getByTestId('shot-note') as HTMLTextAreaElement).value).toBe('打开镜头');
    expect((screen.getByTestId('shot-story-intent') as HTMLTextAreaElement).value).toContain('"tension"');
    expect((screen.getByTestId('shot-cinematography') as HTMLTextAreaElement).value).toBe('slow push-in');
    expect((screen.getByTestId('shot-context') as HTMLTextAreaElement).value).toBe('夜内景');
    expect(screen.getByText(/server v7/)).toBeTruthy();
  });

  it('renders locked fields (generationMeta/output/commerce) read-only', async () => {
    await renderShot();
    expect(screen.getByTestId('shot-locked-generationMeta').textContent).toContain('video-v1');
    expect(screen.getByTestId('shot-locked-output').textContent).toContain('asset-out-1');
    expect(screen.getByTestId('shot-locked-commerce').textContent).toContain('SKU-1');
  });
});

describe('ShotInspector — save with optimistic version', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.update.mockReset();
    mocks.list.mockResolvedValue({ shots: [baseShot()] });
    mocks.update.mockResolvedValue({ ok: true, shot: baseShot() });
  });

  it('PATCHes with the server version and the edited value, then refetches', async () => {
    await renderShot();
    const title = screen.getByTestId('shot-title') as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'Edited Opening' } });
    expect((screen.getByTestId('shot-title') as HTMLInputElement).value).toBe('Edited Opening');

    fireEvent.click(screen.getByTestId('shot-save'));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    const [pid, epId, shotId, body] = mocks.update.mock.calls[0];
    expect(pid).toBe('proj-1');
    expect(epId).toBe('ep-1');
    expect(shotId).toBe('shot-1');
    expect(body.version).toBe(7); // optimistic token = server version, never local
    expect(body.title).toBe('Edited Opening');
    expect(body.seq).toBe(3);
    // locked fields are NEVER sent
    expect(body).not.toHaveProperty('generationMeta');
    expect(body).not.toHaveProperty('output');
    expect(body).not.toHaveProperty('commerce');

    // onSuccess refetches the authoritative shot from the server (list called again)
    await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('re-seeds from the refetched server shot (exact echo) after a version bump', async () => {
    let serverShot = baseShot();
    mocks.list.mockImplementation(async () => ({ shots: [serverShot] }));
    mocks.update.mockImplementation(async () => {
      serverShot = { ...serverShot, version: 8, title: 'Server Sanitized Title' };
      return { ok: true, shot: serverShot };
    });
    await renderShot();
    const title = screen.getByTestId('shot-title') as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'Local Edit' } });
    fireEvent.click(screen.getByTestId('shot-save'));
    // After the refetch returns version 8, the form echoes the SERVER value.
    await waitFor(() => expect((screen.getByTestId('shot-title') as HTMLInputElement).value).toBe('Server Sanitized Title'));
  });
});

describe('ShotInspector — validation', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.update.mockReset();
    mocks.list.mockResolvedValue({ shots: [baseShot()] });
  });

  it('blocks save on invalid seq and shows a field error', async () => {
    await renderShot();
    const seq = screen.getByTestId('shot-seq') as HTMLInputElement;
    fireEvent.change(seq, { target: { value: '0' } }); // not a positive integer
    fireEvent.click(screen.getByTestId('shot-save'));
    await waitFor(() => expect(screen.queryByText('必须是正整数')).toBeTruthy());
    expect(seq.getAttribute('aria-invalid')).toBe('true');
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe('ShotInspector — 409 STALE_SHOT_VERSION', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.update.mockReset();
    mocks.list.mockResolvedValue({ shots: [baseShot()] });
  });

  it('prompts the user and refetches server truth on a stale version (notice survives refetch)', async () => {
    // First read is v7; another writer bumps to v9 AFTER our read, so our PATCH clashes.
    let calls = 0;
    let serverShot = baseShot();
    mocks.list.mockImplementation(async () => {
      // The server's current truth moves to v9 after our first read.
      if (calls++ > 0) serverShot = { ...serverShot, version: 9, title: 'Server v9' };
      return { shots: [serverShot] };
    });
    mocks.update.mockRejectedValue(new ShotInspectorApiError(409, 'STALE_SHOT_VERSION', { error: 'STALE_SHOT_VERSION' }));

    await renderShot();
    fireEvent.change(screen.getByTestId('shot-title') as HTMLInputElement, { target: { value: 'My Edit' } });
    fireEvent.click(screen.getByTestId('shot-save'));

    await waitFor(() => expect(screen.getByTestId('shot-server-notice').textContent).toContain('其他用户更新'));
    // The invalidate must refetch the authoritative shot from the server…
    await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThanOrEqual(2));
    // …and the stale prompt SURVIVES the server-truth refetch (version now 9).
    expect(screen.queryByTestId('shot-server-notice')).not.toBeNull();
    expect(screen.getByText(/server v9/)).toBeTruthy();
  });

  it('shows a read-only notice when a LOCKED_FIELD PATCH is rejected (400)', async () => {
    let serverShot = baseShot();
    mocks.list.mockImplementation(async () => ({ shots: [serverShot] }));
    mocks.update.mockRejectedValue(new ShotInspectorApiError(400, 'LOCKED_FIELD', { error: 'LOCKED_FIELD', field: 'output' }));

    await renderShot();
    fireEvent.change(screen.getByTestId('shot-title') as HTMLInputElement, { target: { value: 'My Edit' } });
    fireEvent.click(screen.getByTestId('shot-save'));

    await waitFor(() => expect(screen.getByTestId('shot-server-notice').textContent).toContain('output'));
  });
});
