import { describe, expect, it } from 'vitest';
import type { IMediaItem } from '@/data/media';
import { mergeWorkspaceMediaHydration, upsertTransientWorkspaceMedia } from './workspaceMediaHydration';

const item = (id: string, status: IMediaItem['status'] = 'success'): IMediaItem => ({
  id,
  title: id,
  type: 'image',
  thumbnail: status === 'pending' ? '' : `https://example.test/${id}.png`,
  fullUrl: status === 'pending' ? '' : `https://example.test/${id}.png`,
  prompt: '',
  model: 'm',
  ratio: '1:1',
  createdAt: '2026-09-06T00:00:00.000Z',
  isFavorite: false,
  isDeleted: false,
  source: 'user',
  status,
});

describe('mergeWorkspaceMediaHydration', () => {
  it('keeps pending cards recovered before the media API hydration resolves', () => {
    const pending = item('pending-1', 'pending');
    const stored = item('stored-1');
    expect(mergeWorkspaceMediaHydration([pending], [stored]).map((x) => x.id)).toEqual([
      'pending-1',
      'stored-1',
    ]);
  });

  it('uses server authority for duplicate persisted media while preserving transient cards', () => {
    const stale = item('stored-1');
    stale.title = 'stale';
    const authoritative = item('stored-1');
    authoritative.title = 'server';
    expect(mergeWorkspaceMediaHydration([stale], [authoritative])).toEqual([authoritative]);
  });

  it('upserts recovered pending cards by id instead of duplicating them', () => {
    const pending = item('pending-1', 'pending');
    expect(upsertTransientWorkspaceMedia([pending], [pending])).toEqual([pending]);
  });
});
