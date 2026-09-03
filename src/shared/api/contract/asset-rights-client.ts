// ── W2-13 — Asset Rights API contract ────────────────────────────────────────
// Contract-first typed client for the commercial asset rights / provenance domain
// (W2-05). Mirrors server/modules/project-foundation/assetRights.cjs +
// db/migrations/0029_asset_rights.sql (asset_rights). Embedded per-asset, keyed by
// asset_id: origin / uploaded_by / generated_by / provider / model / generation_id /
// reference_assets / owner / license / consent / commercial_usage.
//
//   GET /api/v2/assets/:assetId/rights   → read rights for one asset
//   PUT /api/v2/assets/:assetId/rights   → upsert rights for one asset
//
// This file is a frontend contract only — it does not touch the backend.

import { api } from '../client';
import { telemetry } from '@/shared/telemetry/logger';

/** Origin of an asset's rights / provenance (mirrors ORIGINS in assetRights.cjs). */
export type AssetRightsOrigin = 'uploaded' | 'generated' | 'imported';

/** asset_rights row (snake_case mirrors the backend module / migration), keyed by asset_id. */
export interface AssetRights {
  asset_id: string;
  origin: AssetRightsOrigin | null;
  uploaded_by: string | null;
  generated_by: string | null;
  provider: string | null;
  model: string | null;
  generation_id: string | null;
  reference_assets: string[];
  owner: string | null;
  license: string | null;
  consent: Record<string, unknown>;
  /** Fail-closed readiness flag — the minimum commercial-usage gate (W2-05). */
  commercial_usage: boolean | null;
  created_at: string;
  updated_at: string;
}

/** GET /api/v2/assets/:assetId/rights — 200 */
export interface AssetRightsResponse {
  ok: true;
  rights: AssetRights;
}

/** PUT body — partial rights write; only provided scalar fields are sanitized server-side. */
export interface AssetRightsWriteBody {
  origin?: AssetRightsOrigin;
  uploaded_by?: string;
  generated_by?: string;
  provider?: string;
  model?: string;
  generation_id?: string;
  reference_assets?: string[];
  owner?: string;
  license?: string;
  consent?: Record<string, unknown>;
  commercial_usage?: boolean;
}

export class AssetRightsApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'AssetRightsApiError';
    this.status = status;
    this.body = body;
  }
}

async function call<T>(fn: () => Promise<T>, op: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { status?: number; message?: string; body?: unknown };
    if (typeof err.status === 'number') {
      throw new AssetRightsApiError(err.status, err.message ?? op, err.body);
    }
    telemetry.warn(`v2asset.rights.${op}`, (e as Error).message);
    throw e;
  }
}

function assetPath(assetId: string, suffix = '') {
  return `/api/v2/assets/${encodeURIComponent(assetId)}${suffix}`;
}

export const v2assetRights = {
  /** GET /api/v2/assets/:assetId/rights — read rights for one asset. */
  get(assetId: string): Promise<AssetRightsResponse> {
    return call(() => api.get<AssetRightsResponse>(assetPath(assetId, '/rights')), 'get');
  },

  /** PUT /api/v2/assets/:assetId/rights — upsert rights for one asset. */
  upsert(assetId: string, body: AssetRightsWriteBody): Promise<AssetRightsResponse> {
    return call(() => api.put<AssetRightsResponse>(assetPath(assetId, '/rights'), body), 'upsert');
  },
};
