import { describe, it, expect } from 'vitest';
import type { IMediaItem } from '@/data/media';
import { buildPersistedUploadItem, shouldPersistUploadItem } from './uploadPersistence';

function item(over: Partial<IMediaItem> = {}): IMediaItem {
  return {
    id: 'upload-1',
    title: 'local file',
    type: 'image',
    thumbnail: 'data:image/png;base64,abc',
    fullUrl: 'data:image/png;base64,abc',
    prompt: '',
    model: '本地上传',
    ratio: '1:1',
    createdAt: new Date().toISOString(),
    isFavorite: false,
    isDeleted: false,
    source: 'user',
    category: 'upload',
    ...over,
  };
}

describe('library upload persistence', () => {
  it('does not treat data-url preview as refresh-safe persistence', () => {
    expect(shouldPersistUploadItem(item())).toBe(false);
  });

  it('turns a successful OSS upload into a persistable media item', () => {
    const saved = buildPersistedUploadItem(item(), {
      success: true,
      url: 'https://oss.example/images/u/file.png',
      objectKey: 'images/u/file.png',
    })!;
    expect(saved.fullUrl).toBe('https://oss.example/images/u/file.png');
    expect(saved.thumbnail).toBe('https://oss.example/images/u/file.png');
    expect(saved.ossUrl).toBe('https://oss.example/images/u/file.png');
    expect(saved.ossObjectKey).toBe('images/u/file.png');
    expect(saved.ossUploaded).toBe(true);
    expect(saved.category).toBe('upload');
    expect(shouldPersistUploadItem(saved)).toBe(true);
  });

  it('returns null when OSS upload fails, so caller cannot silently persist a dead preview', () => {
    expect(buildPersistedUploadItem(item(), { success: false })).toBeNull();
  });
});
