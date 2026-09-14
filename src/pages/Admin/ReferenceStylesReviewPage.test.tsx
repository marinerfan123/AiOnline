// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import ReferenceStylesReviewPage from './ReferenceStylesReviewPage';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/services/api', () => ({
  apiAdminGetReferenceStyles: mocks.list,
  apiAdminReviewReferenceStyle: vi.fn(),
  apiAdminPromoteReferenceStyle: vi.fn(),
  apiDeleteReferenceStyle: mocks.remove,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeAll(() => {
  HTMLCanvasElement.prototype.toDataURL = vi.fn(() => 'data:image/png;base64,test');
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ReferenceStylesReviewPage delete', () => {
  it('管理员二次确认后删除样式并从列表移除', async () => {
    mocks.list.mockResolvedValue({ items: [{
      id: 'rs-1', name: '待删除样式', previewUrl: '', status: 'approved', reviewedAt: '2026-09-08T00:00:00Z',
    }], total: 1 });
    mocks.remove.mockResolvedValue({ ok: true });
    render(<ReferenceStylesReviewPage />);

    expect(await screen.findByText('待删除样式')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除待删除样式' }));
    expect(screen.getByText('确认删除参考样式？')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith('rs-1'));
    await waitFor(() => expect(screen.queryByText('待删除样式')).toBeNull());
  });
});
