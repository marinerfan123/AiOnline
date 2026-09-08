import { describe, expect, it } from 'vitest';
import { filterWorkspaceMedia } from './workspaceView';
import type { IMediaItem } from '@/data/media';

const item = (id: string, status?: IMediaItem['status']): IMediaItem => ({
  id, title: id, type: 'image', thumbnail: '', fullUrl: '', prompt: '', model: '', ratio: '1:1',
  createdAt: '2026-09-08T00:00:00.000Z', isFavorite: false, isDeleted: false, source: 'user', status,
});

describe('workspace generating view', () => {
  it('正在生成页只保留 pending，普通工作台保留全部未删除媒体', () => {
    const media = [item('pending', 'pending'), item('done', 'success'), { ...item('deleted', 'pending'), isDeleted: true }];
    expect(filterWorkspaceMedia(media, '', 'newest', true).map((x) => x.id)).toEqual(['pending']);
    expect(filterWorkspaceMedia(media, '', 'newest', false).map((x) => x.id)).toEqual(['pending', 'done']);
  });
});
