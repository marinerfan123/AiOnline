// @vitest-environment jsdom
/**
 * M01-S — V2 Project / Workspace client tests.
 * Focus on contract mapping, URL shapes, Zod boundary validation, and error normalization.
 */

import { describe, it, expect, vi } from 'vitest';
import { v2project, ProjectApiError } from '@/shared/api/contract/project-client';

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

describe('v2project client (M01-S)', () => {
  it('listWorkspaces calls /api/v2/workspaces', async () => {
    const fn = mockFetch([{
      status: 200,
      body: JSON.stringify({
        workspaces: [{
          id: 'ws-1', name: 'Personal', ownerId: 'u1', role: 'owner',
          status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        }],
      }),
    }]);
    const out = await v2project.listWorkspaces();
    expect(String((fn.mock.calls[0] as unknown as [string, RequestInit?])[0])).toContain('/api/v2/workspaces');
    expect(out.workspaces[0].id).toBe('ws-1');
  });

  it('listProjects builds query string with filters', async () => {
    const fn = mockFetch([{
      status: 200,
      body: JSON.stringify({ projects: [], pagination: { limit: 20, offset: 0, total: 0, hasMore: false } }),
    }]);
    await v2project.listProjects({ workspace: 'ws-1', status: 'active', projectType: 'studio', search: 'foo', limit: 10, offset: 5 });
    const url = String((fn.mock.calls[0] as unknown as [string, RequestInit?])[0]);
    expect(url).toContain('/api/v2/projects?');
    expect(url).toContain('workspace=ws-1');
    expect(url).toContain('status=active');
    expect(url).toContain('projectType=studio');
    expect(url).toContain('search=foo');
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=5');
  });

  it('createProject posts validated body and returns detail', async () => {
    const fn = mockFetch([{
      status: 201,
      body: JSON.stringify({
        project: {
          id: 'proj-1', workspaceId: 'ws-1', ownerId: 'u1', name: 'Alpha',
          projectType: 'general', status: 'active', version: 1,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        },
        permissions: { role: 'owner', canRead: true, canUpdate: true, canArchive: true, canRestore: false, canDelete: false },
      }),
    }]);
    const out = await v2project.createProject({ workspaceId: 'ws-1', name: 'Alpha' });
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ workspaceId: 'ws-1', name: 'Alpha' });
    expect(out.project.name).toBe('Alpha');
    expect(out.permissions.canUpdate).toBe(true);
  });

  it('rejects invalid createProject input at Zod boundary', async () => {
    mockFetch([]);
    await expect(v2project.createProject({ workspaceId: 'ws-1', name: '' })).rejects.toBeTruthy();
  });

  it('non-2xx throws ProjectApiError with status', async () => {
    mockFetch([{ status: 403, body: '{"error":"forbidden"}' }]);
    await expect(v2project.getProject('proj-1')).rejects.toMatchObject({
      status: 403,
      name: 'ProjectApiError',
    });
  });
});
