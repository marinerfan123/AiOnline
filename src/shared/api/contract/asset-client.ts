// ── Typed V2 Asset client (M04-S) ─────────────────────────────────────────
// Contract-first client against moling-v2.yaml. Same pattern as
// project-client.ts: shared ApiClient + Zod runtime validation at the
// boundary. The Studio/Canvas integration contract: M05 nodes consume
// AssetRef (assetId) from these methods — never provider temporary URLs.

import type * as contract from './generated';
import { api } from '../client';
import { telemetry } from '@/shared/telemetry/logger';
import {
  AssetListResponseSchema,
  AssetDetailResponseSchema,
  AssetWriteRequestSchema,
  parseSafe,
  type AssetListResponse,
  type AssetDetailResponse,
  type AssetWriteRequest,
  type AssetType,
  type AssetStatus,
} from './schemas';

type Schemas = contract.components['schemas'];

export class AssetApiError extends Error {
  status: number;
  payload: unknown;
  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = 'AssetApiError';
    this.status = status;
    this.payload = payload;
  }
}

async function call<T>(fn: () => Promise<T>, op: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { status?: number; message?: string; body?: unknown };
    if (err && typeof err.status === 'number') {
      throw new AssetApiError(err.status, err.message ?? op, (err as { body?: unknown }).body ?? err);
    }
    telemetry.warn(`v2asset.${op}`, (e as Error).message);
    throw e;
  }
}

function qs(params: Record<string, string | number | undefined> | ProjectAssetsQuery): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

export interface ProjectAssetsQuery {
  type?: AssetType | '';
  status?: AssetStatus | '';
  search?: string;
  limit?: number;
  offset?: number;
}

export interface MyAssetsQuery extends ProjectAssetsQuery {}

export const v2asset = {
  /** GET /api/v2/projects/:projectId/assets */
  async listProjectAssets(projectId: string, query: ProjectAssetsQuery = {}): Promise<AssetListResponse> {
    const raw = await call(
      () => api.get<Schemas['AssetListResponse']>(`/api/v2/projects/${encodeURIComponent(projectId)}/assets${qs(query)}`),
      'listProjectAssets',
    );
    return parseSafe(AssetListResponseSchema, raw, (err) =>
      telemetry.warn('v2asset.listProjectAssets.invalid', err.issues[0]?.message ?? 'parse error'),
    ) as AssetListResponse;
  },

  /** GET /api/v2/assets */
  async listMyAssets(query: MyAssetsQuery = {}): Promise<AssetListResponse> {
    const raw = await call(() => api.get<Schemas['AssetListResponse']>(`/api/v2/assets${qs(query)}`), 'listMyAssets');
    return parseSafe(AssetListResponseSchema, raw, (err) =>
      telemetry.warn('v2asset.listMyAssets.invalid', err.issues[0]?.message ?? 'parse error'),
    ) as AssetListResponse;
  },

  /** GET /api/v2/assets/:assetId */
  async getAsset(assetId: string): Promise<AssetDetailResponse> {
    const raw = await call(
      () => api.get<Schemas['AssetDetailResponse']>(`/api/v2/assets/${encodeURIComponent(assetId)}`),
      'getAsset',
    );
    return parseSafe(AssetDetailResponseSchema, raw, (err) =>
      telemetry.warn('v2asset.getAsset.invalid', err.issues[0]?.message ?? 'parse error'),
    ) as AssetDetailResponse;
  },

  /**
   * POST /api/v2/assets — create (url) or register (assetId).
   * Returns 201 on create, 200 on register.
   */
  async writeAsset(body: AssetWriteRequest): Promise<AssetDetailResponse> {
    const parsed = AssetWriteRequestSchema.parse(body);
    const raw = await call(
      () => api.post<Schemas['AssetDetailResponse']>('/api/v2/assets', parsed),
      parsed.assetId ? 'registerAsset' : 'createAsset',
    );
    return parseSafe(AssetDetailResponseSchema, raw, (err) =>
      telemetry.warn('v2asset.writeAsset.invalid', err.issues[0]?.message ?? 'parse error'),
    ) as AssetDetailResponse;
  },
};
