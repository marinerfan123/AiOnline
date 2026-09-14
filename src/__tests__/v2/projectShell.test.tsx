// @vitest-environment jsdom
/**
 * M01-S — ProjectShell / ProjectContext tests.
 * Verify the shell resolves project identity from the URL and renders the
 * stable ProjectContext contract without leaking full objects into global state.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectShell } from '@/features/project-foundation/ProjectShell';
import { useProjectContext } from '@/features/project-foundation/ProjectContext';

function mockFetchOnce(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })),
  );
}

function Providers({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function ContextProbe() {
  const ctx = useProjectContext();
  return (
    <div data-testid="context">
      <span data-testid="pid">{ctx.projectId}</span>
      <span data-testid="wid">{ctx.workspaceId}</span>
      <span data-testid="type">{ctx.projectType}</span>
      <span data-testid="status">{ctx.projectStatus}</span>
      <span data-testid="canUpdate">{String(ctx.permissions.canUpdate)}</span>
    </div>
  );
}

describe('ProjectShell context (M01-S)', () => {
  it('resolves project identity from route params', async () => {
    mockFetchOnce(200, {
      project: {
        id: 'proj-1',
        workspaceId: 'ws-1',
        ownerId: 'u1',
        name: 'Test Project',
        projectType: 'studio',
        status: 'active',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      permissions: {
        role: 'owner',
        canRead: true,
        canUpdate: true,
        canArchive: true,
        canRestore: false,
        canDelete: false,
      },
    });

    render(
      <Providers>
        <MemoryRouter initialEntries={['/__v2/projects/proj-1']}>
          <Routes>
            <Route
              path="/__v2/projects/:projectId/*"
              element={(
                <ProjectShell>
                  <ContextProbe />
                </ProjectShell>
              )}
            />
          </Routes>
        </MemoryRouter>
      </Providers>,
    );

    await waitFor(() => expect(screen.queryByText('加载项目中…')).toBeNull());

    expect(screen.getByText('Test Project')).toBeTruthy();
    expect(screen.getByTestId('pid').textContent).toBe('proj-1');
    expect(screen.getByTestId('wid').textContent).toBe('ws-1');
    expect(screen.getByTestId('type').textContent).toBe('studio');
    expect(screen.getByTestId('status').textContent).toBe('active');
    expect(screen.getByTestId('canUpdate').textContent).toBe('true');
    expect(screen.getByTestId('project-shell-nav')).toBeTruthy();
  });

  it('renders error state when project is not found', async () => {
    mockFetchOnce(404, { error: 'not found' });

    render(
      <Providers>
        <MemoryRouter initialEntries={['/__v2/projects/missing']}>
          <Routes>
            <Route
              path="/__v2/projects/:projectId/*"
              element={(
                <ProjectShell>
                  <div data-testid="child">child</div>
                </ProjectShell>
              )}
            />
          </Routes>
        </MemoryRouter>
      </Providers>,
    );

    await waitFor(() => expect(screen.queryByText('加载项目中…')).toBeNull());
    expect(screen.getByText('项目不存在')).toBeTruthy();
  });
});
