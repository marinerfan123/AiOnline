import type { IMediaItem } from '@/data/media';

export function filterWorkspaceMedia(
  mediaList: IMediaItem[],
  searchQuery: string,
  sortMode: 'newest' | 'oldest',
  generatingOnly: boolean,
): IMediaItem[] {
  const query = searchQuery.toLowerCase();
  const list = mediaList.filter((item) => {
    if (item.isDeleted) return false;
    if (generatingOnly && item.status !== 'pending') return false;
    return item.title.toLowerCase().includes(query);
  });
  return [...list].sort((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    return sortMode === 'newest' ? tb - ta : ta - tb;
  });
}
