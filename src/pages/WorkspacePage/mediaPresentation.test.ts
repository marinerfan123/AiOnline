import { describe, expect, it } from 'vitest';
import type { IMediaItem } from '@/data/media';
import { getMediaPresentationState, normalizeStoredMedia } from '@/pages/WorkspacePage/mediaPresentation';

const item = (patch: Partial<IMediaItem> = {}): IMediaItem => ({
  id: 'm1', title: 'image', type: 'image', thumbnail: 'https://provider/image.png', fullUrl: 'https://provider/image.png',
  prompt: 'p', model: 'm', ratio: '16:9', createdAt: new Date().toISOString(), isFavorite: false, isDeleted: false, source: 'user',
  ...patch,
});

describe('media presentation state', () => {
  it('does not label a generated image with pending cloud upload as generation failed', () => {
    expect(getMediaPresentationState(item({ status: 'pending_upload', ossUploaded: false }))).toBe('sync-pending');
  });

  it('normalizes storage status drift when the object is already uploaded', () => {
    expect(normalizeStoredMedia(item({ status: 'pending_upload', ossUploaded: true, ossUrl: 'https://oss/image.png' })).status).toBe('success');
  });

  it('keeps actual generation failures distinct', () => {
    expect(getMediaPresentationState(item({ status: 'failed' }))).toBe('failed');
  });
});
