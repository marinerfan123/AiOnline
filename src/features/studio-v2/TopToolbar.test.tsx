// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TopToolbar } from './TopToolbar';

vi.mock('@/features/project-foundation/ProjectContext', () => ({
  useProjectContext: () => ({ projectName: '测试项目', projectType: 'studio', projectId: 'proj-1' }),
}));

vi.mock('@/features/project-foundation/ExportMenu', () => ({
  ExportMenu: ({ projectId }: { projectId: string }) => <button data-testid="export-probe">导出 {projectId}</button>,
}));

vi.mock('./AssetLibraryDrawer', () => ({
  AssetLibraryToggle: () => <button data-testid="assets-probe">素材</button>,
}));

describe('TopToolbar', () => {
  afterEach(cleanup);

  it('keeps project export available in the immersive toolbar', () => {
    render(<MemoryRouter><TopToolbar /></MemoryRouter>);
    expect(screen.getByTestId('export-probe').textContent).toContain('proj-1');
  });
});
