import type { IMediaItem } from '@/data/media';

/**
 * Merge the authoritative media response into whatever the workspace already
 * rendered while hydration was in flight. Pending cards are transient UI state
 * restored from generation_tasks/localStorage and therefore are not present in
 * /api/media; replacing the array would make them disappear after refresh.
 */
export function mergeWorkspaceMediaHydration(
  current: IMediaItem[],
  serverItems: IMediaItem[],
): IMediaItem[] {
  const serverIds = new Set(serverItems.map((item) => item.id));
  const transient = current.filter(
    (item) => item.status === 'pending' && !serverIds.has(item.id),
  );
  return [...transient, ...serverItems];
}

/** Add recovered pending cards exactly once, preserving current cards. */
export function upsertTransientWorkspaceMedia(
  current: IMediaItem[],
  incoming: IMediaItem[],
): IMediaItem[] {
  const incomingIds = new Set(incoming.map((item) => item.id));
  return [...incoming, ...current.filter((item) => !incomingIds.has(item.id))];
}
