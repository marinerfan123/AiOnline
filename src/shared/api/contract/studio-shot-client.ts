import { v2studioEpisodes, type Shot } from './studio-episode-client';

/**
 * Re-export shot-specific types for direct use.
 */
export type { Shot };

/**
 * Helper namespace for shot operations — delegates to v2studioEpisodes.
 * Kept separate per the task spec (studio-shot-client.ts).
 */
export const studioShotClient = {
  list: (projectId: string, epId: string) => v2studioEpisodes.listShots(projectId, epId),
  create: (projectId: string, epId: string, body: { nodes: Array<{ canvasNodeId: string; assetId?: string; durationSeconds?: number; note?: string }> }) =>
    v2studioEpisodes.bulkCreateShots(projectId, epId, body),
  update: (projectId: string, epId: string, shotId: string, body: { seq?: number; durationSeconds?: number; note?: string; assetId?: string | null }) =>
    v2studioEpisodes.updateShot(projectId, epId, shotId, body),
};
