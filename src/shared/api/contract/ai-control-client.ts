// ── Typed V2 AI Control Plane client (M02-B) ────────────────────────────────
// Follows the M00 contract-first pattern against the M02 contract
// (moling-v2-ai-control.yaml → ai-control.d.ts). Transport = shared ApiClient
// (cookie session + bearer discovery). Responses are the MASKED contract
// shapes — the full API key never exists on the wire (write-boundary only).
//
// Legacy client.ts is untouched.

import type * as aiControl from './ai-control';
import { api } from '../client';
import { telemetry } from '@/shared/telemetry/logger';

type Schemas = aiControl.components['schemas'];

export type ProviderView = Schemas['ProviderView'];
export type CredentialSource = Schemas['CredentialSource'];
export type MaskedKey = Schemas['MaskedKey'];
export type KeyPoolView = Schemas['KeyPoolView'];
export type ProviderCreateRequest = Omit<Schemas['ProviderCreateRequest'], 'type' | 'protocol' | 'enabled' | 'supportedTypes' | 'remark' | 'apiKey'> & {
  type?: string;
  protocol?: string;
  enabled?: boolean;
  supportedTypes?: string | string[];
  remark?: string;
  apiKey?: string;
};
export type ProviderUpdateRequest = Schemas['ProviderUpdateRequest'];
export type ProviderMutationResult = Schemas['ProviderMutationResult'];
export type KeysAddRequest = Omit<Schemas['KeysAddRequest'], 'weight'> & {
  weight?: number;
};
export type KeysAddResult = Schemas['KeysAddResult'];
export type KeyUpdateRequest = Schemas['KeyUpdateRequest'];

/**
 * Thrown with a stable .status so UI can branch on 401/403/404/409.
 */
export class AiControlApiError extends Error {
  status: number;
  payload: unknown;
  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = 'AiControlApiError';
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
      throw new AiControlApiError(err.status, err.message ?? op, (err as { body?: unknown }).body ?? err);
    }
    telemetry.warn(`v2ai.${op}`, (e as Error).message);
    throw e;
  }
}

export const v2ai = {
  /** GET /api/v2/ai-control/providers?q=&enabled= */
  listProviders(params: { q?: string; enabled?: 'true' | 'false' } = {}) {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.enabled) qs.set('enabled', params.enabled);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return call(
      () => api.get<{ providers: ProviderView[] }>(`/api/v2/ai-control/providers${suffix}`),
      'listProviders',
    );
  },

  /** GET /api/v2/ai-control/providers/:id */
  getProvider(providerId: string) {
    return call(
      () => api.get<{ provider: ProviderView }>(`/api/v2/ai-control/providers/${encodeURIComponent(providerId)}`),
      'getProvider',
    );
  },

  /** POST /api/v2/ai-control/providers */
  createProvider(body: ProviderCreateRequest) {
    return call(() => api.post<ProviderMutationResult>('/api/v2/ai-control/providers', body), 'createProvider');
  },

  /** PATCH /api/v2/ai-control/providers/:id (optimistic lock via body.revision) */
  updateProvider(providerId: string, body: ProviderUpdateRequest) {
    return call(
      () => api.patch<ProviderMutationResult>(`/api/v2/ai-control/providers/${encodeURIComponent(providerId)}`, body),
      'updateProvider',
    );
  },

  /** POST /api/v2/ai-control/providers/:id/enable */
  setProviderEnabled(providerId: string, enabled: boolean) {
    return call(
      () =>
        api.post<ProviderMutationResult>(`/api/v2/ai-control/providers/${encodeURIComponent(providerId)}/enable`, {
          enabled,
        }),
      'setProviderEnabled',
    );
  },

  /** GET /api/v2/ai-control/providers/:id/keys */
  listKeys(providerId: string) {
    return call(
      () => api.get<KeyPoolView>(`/api/v2/ai-control/providers/${encodeURIComponent(providerId)}/keys`),
      'listKeys',
    );
  },

  /** POST /api/v2/ai-control/providers/:id/keys — single key or batch (deduped server-side) */
  addKeys(providerId: string, body: KeysAddRequest) {
    return call(
      () => api.post<KeysAddResult>(`/api/v2/ai-control/providers/${encodeURIComponent(providerId)}/keys`, body),
      'addKeys',
    );
  },

  /** PATCH /api/v2/ai-control/providers/:id/keys/:keyId */
  updateKey(providerId: string, keyId: string, body: KeyUpdateRequest) {
    return call(
      () =>
        api.patch<{ ok: boolean; key: MaskedKey }>(
          `/api/v2/ai-control/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}`,
          body,
        ),
      'updateKey',
    );
  },

  /** DELETE /api/v2/ai-control/providers/:id/keys/:keyId */
  deleteKey(providerId: string, keyId: string) {
    return call(
      () =>
        api.delete<{ ok: boolean; deleted: string }>(
          `/api/v2/ai-control/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}`,
        ),
      'deleteKey',
    );
  },

  /** POST /api/v2/ai-control/providers/:id/keys/:keyId/cooldown — cooldownMs 0 = clear */
  setKeyCooldown(providerId: string, keyId: string, cooldownMs: number) {
    return call(
      () =>
        api.post<{ ok: boolean; key_id: string; cooldown_until: string | null }>(
          `/api/v2/ai-control/providers/${encodeURIComponent(providerId)}/keys/${encodeURIComponent(keyId)}/cooldown`,
          { cooldownMs },
        ),
      'setKeyCooldown',
    );
  },
};
