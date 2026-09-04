// @vitest-environment jsdom
// G24 — ExportMenu (project header dropdown).
// Covers: menu opens with the whole-project item + a GRAYED timeline entry
// (no project→timeline list on the FE yet, so timelineId is unavailable and
// the entry must be inert), whole-project export fetches
// GET /api/v2/projects/:id/export and downloads a Blob as project-<id>.json,
// HTTP failure surfaces a toast + onError, and passing `timelines` turns the
// placeholder into per-timeline export items hitting the timeline endpoint.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ExportMenu } from '@/features/project-foundation/ExportMenu';

configure({ testIdAttribute: 'data-test' });

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

// Spy on the download mechanics (jsdom has no real object URLs / navigation).
let capturedAnchor: HTMLAnchorElement | null = null;
let clickSpy: ReturnType<typeof vi.fn>;
let createObjectUrlSpy: ReturnType<typeof vi.fn>;
let revokeObjectUrlSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  capturedAnchor = null;
  clickSpy = vi.fn(() => {
    // no-op: jsdom cannot navigate a Blob URL
  });
  createObjectUrlSpy = vi.fn(() => 'blob:mock-export');
  revokeObjectUrlSpy = vi.fn();
  vi.stubGlobal('URL', { ...URL, createObjectURL: createObjectUrlSpy, revokeObjectURL: revokeObjectUrlSpy });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    capturedAnchor = this;
    clickSpy();
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function openMenu(projectId = 'proj-1') {
  render(<ExportMenu projectId={projectId} />);
  fireEvent.click(screen.getByTestId('export-menu-trigger'));
  await waitFor(() => expect(screen.getByTestId('export-menu')).toBeTruthy());
}

describe('ExportMenu — structure', () => {
  it('renders the whole-project item plus a grayed timeline entry when no timeline list exists', async () => {
    await openMenu();

    const projectItem = screen.getByTestId('export-whole-project-item');
    expect(projectItem).toBeTruthy();
    expect(projectItem.textContent).toContain('导出整项目(JSON)');

    // Timeline export needs a timelineId; with no project timeline list the
    // entry must be present but disabled/inert.
    const timelineItem = screen.getByTestId('export-timeline-placeholder');
    expect(timelineItem).toBeTruthy();
    expect(timelineItem.textContent).toContain('导出时间线');
    expect(timelineItem).toHaveProperty('disabled', true);
    expect(timelineItem.getAttribute('aria-disabled')).toBe('true');

    // Clicking the disabled entry must not trigger any network call.
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    fireEvent.click(timelineItem);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('ExportMenu — whole-project export', () => {
  it('fetches /api/v2/projects/:id/export and downloads the JSON blob as project-<id>.json', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) =>
      new Response(new Blob(['{"exported":true}'], { type: 'application/json' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await openMenu('proj-7');
    fireEvent.click(screen.getByTestId('export-whole-project-item'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/projects/proj-7/export');

    await waitFor(() => expect(createObjectUrlSpy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));

    // The anchor used for the download must carry the expected filename.
    expect(capturedAnchor).not.toBeNull();
    expect(capturedAnchor!.getAttribute('download')).toBe('project-proj-7.json');
    expect(capturedAnchor!.getAttribute('href')).toBe('blob:mock-export');

    await waitFor(() => expect(revokeObjectUrlSpy).toHaveBeenCalled(), { timeout: 3000 });

    // Menu closes after the export attempt.
    await waitFor(() => expect(screen.queryByTestId('export-menu')).toBeNull());
  });

  it('URL-encodes a project id containing special characters', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) =>
      new Response(new Blob(['{}'], { type: 'application/json' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await openMenu('a/b c?');
    fireEvent.click(screen.getByTestId('export-whole-project-item'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/projects/a%2Fb%20c%3F/export');
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
  });
});

describe('ExportMenu — failure feedback', () => {
  it('fires the error toast and onError when the server returns an HTTP error', async () => {
    const onError = vi.fn();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) =>
      new Response(JSON.stringify({ ok: false, error: '项目不存在' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ExportMenu projectId="proj-1" onError={onError} />);
    fireEvent.click(screen.getByTestId('export-menu-trigger'));
    fireEvent.click(screen.getByTestId('export-whole-project-item'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith('项目不存在');
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).toHaveBeenCalledWith('导出失败', expect.objectContaining({ description: '项目不存在' }));

    // No download must have been attempted.
    expect(clickSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('export-menu')).toBeNull());
  });

  it('reports transport/network failures through toast + onError', async () => {
    const onError = vi.fn();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ExportMenu projectId="proj-1" onError={onError} />);
    fireEvent.click(screen.getByTestId('export-menu-trigger'));
    fireEvent.click(screen.getByTestId('export-whole-project-item'));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith('Failed to fetch');
    expect(mocks.toastError).toHaveBeenCalledWith('导出失败', expect.objectContaining({ description: 'Failed to fetch' }));
  });
});

describe('ExportMenu — timeline options (future list wiring)', () => {
  it('lists per-timeline export items when timelines are provided and hits the timeline endpoint', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) =>
      new Response(new Blob(['{"t":1}'], { type: 'application/json' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ExportMenu
        projectId="proj-1"
        timelines={[
          { id: 'tl-a', name: '主时间线' },
          { id: 'tl-b', name: '备用线' },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId('export-menu-trigger'));

    // No grayed placeholder; one actionable item per timeline.
    expect(screen.queryByTestId('export-timeline-placeholder')).toBeNull();
    const items = screen.getAllByTestId('export-timeline-item');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('主时间线');
    expect(items[0].textContent).toContain('导出时间线');
    expect(items[0]).toHaveProperty('disabled', false);

    fireEvent.click(items[0]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/timelines/tl-a/export?projectId=proj-1');
    await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));

    expect(capturedAnchor).not.toBeNull();
    expect(capturedAnchor!.getAttribute('download')).toBe('project-proj-1-timeline-tl-a.json');
  });
});
