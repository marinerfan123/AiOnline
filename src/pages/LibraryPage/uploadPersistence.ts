import type { IMediaItem } from '@/data/media';

export type UploadPersistResult = { persisted: IMediaItem[]; failed: number };

export function buildPersistedUploadItem(
  item: IMediaItem,
  upload: { success: boolean; url?: string; objectKey?: string },
): IMediaItem | null {
  if (!upload.success || !upload.url) return null;
  return {
    ...item,
    fullUrl: upload.url,
    thumbnail: upload.url,
    ossUrl: upload.url,
    ossObjectKey: upload.objectKey || '',
    ossUploaded: true,
    status: 'success',
  };
}

export function shouldPersistUploadItem(item: IMediaItem): boolean {
  return !!item.ossUploaded && !!item.ossObjectKey && !!item.fullUrl && !item.fullUrl.startsWith('data:') && !item.thumbnail.startsWith('data:');
}
