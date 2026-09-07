import type { IMediaItem } from '@/data/media';

export type MediaPresentationState = 'generating' | 'failed' | 'sync-pending' | 'ready';

export function getMediaPresentationState(item: IMediaItem): MediaPresentationState {
  if (item.status === 'pending') return 'generating';
  if (item.status === 'failed') return 'failed';
  if (item.status === 'pending_upload' && !item.ossUploaded) return 'sync-pending';
  return 'ready';
}

export function normalizeStoredMedia(item: IMediaItem): IMediaItem {
  if (item.status === 'pending_upload' && item.ossUploaded && item.ossUrl) {
    return { ...item, status: 'success' };
  }
  return item;
}
