// @vitest-environment jsdom
/**
 * W4b — BottomDock History tab wiring: the History tab button exists and
 * selecting it mounts HistoryPanel with the projectId. Children are mocked as
 * probes (mirrors StudioPage.test.tsx's probe pattern), so this file asserts
 * only the tab wiring — the panel internals are covered by HistoryPanel.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, configure } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BottomDock } from './BottomDock';

configure({ testIdAttribute: 'data-test' });
afterEach(cleanup);

const mocks = vi.hoisted(() => ({
  listVersions: vi.fn(),
  createVersion: vi.fn(),
  restoreVersion: vi.fn(),
  HistoryPanel: vi.fn(),
  RunsPanel: vi.fn(),
  StoryboardRowsPanel: vi.fn(),
}));

vi.mock('@/shared/api/contract/studio-canvas-client', () => ({
  v2studio: {
    listVersions: mocks.listVersions,
    createVersion: mocks.createVersion,
    restoreVersion: mocks.restoreVersion,
  },
}));

vi.mock('./history/HistoryPanel', () => ({
  HistoryPanel: (props: { projectId?: string }) => {
    mocks.HistoryPanel(props);
    return <div data-test="history-panel-probe" data-project-id={props.projectId} />;
  },
}));

vi.mock('./run/RunsPanel', () => ({
  RunsPanel: (props: { projectId?: string }) => {
    mocks.RunsPanel(props);
    return <div data-test="runs-panel-probe" />;
  },
}));

vi.mock('./StoryboardRowsPanel', () => ({
  StoryboardRowsPanel: () => <div data-test="storyboard-probe" />,
}));

function Providers({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  mocks.listVersions.mockReset();
  mocks.createVersion.mockReset();
  mocks.restoreVersion.mockReset();
  mocks.HistoryPanel.mockReset();
  mocks.RunsPanel.mockReset();
  mocks.StoryboardRowsPanel.mockReset();
  mocks.listVersions.mockResolvedValue({ versions: [] });
});

describe('BottomDock — History tab wiring', () => {
  it('renders the History tab button', () => {
    render(
      <Providers>
        <BottomDock projectId="p1" />
      </Providers>,
    );
    expect(screen.getByTestId('dock-tab-history')).toBeTruthy();
  });

  it('selecting History mounts HistoryPanel with projectId', async () => {
    render(
      <Providers>
        <BottomDock projectId="p1" />
      </Providers>,
    );
    fireEvent.click(screen.getByTestId('dock-tab-history'));
    await waitFor(() => expect(screen.getByTestId('history-panel-probe')).toBeTruthy());
    expect(mocks.HistoryPanel).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }));
  });

  it('does not mount HistoryPanel until its tab is selected', () => {
    render(
      <Providers>
        <BottomDock projectId="p1" />
      </Providers>,
    );
    expect(mocks.HistoryPanel).not.toHaveBeenCalled();
  });
});
