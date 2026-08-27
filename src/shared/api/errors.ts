// ── Shared API error contract (M00) ──────────────────────────────────────────
// Standard, normalized error shape used by every NEW V2 module. The legacy
// api.ts is untouched; this is the contract V2 code must validate against.

export type ApiErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'VALIDATION'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'UNKNOWN';

export interface ApiErrorPayload {
  code: ApiErrorCode;
  message: string;
  request_id?: string;
  status?: number;
  details?: unknown;
  field_errors?: Record<string, string[]>;
}

export class ApiError extends Error implements ApiErrorPayload {
  code: ApiErrorCode;
  request_id?: string;
  status?: number;
  details?: unknown;
  field_errors?: Record<string, string[]>;

  constructor(payload: ApiErrorPayload) {
    super(payload.message);
    this.name = 'ApiError';
    this.code = payload.code;
    this.request_id = payload.request_id;
    this.status = payload.status;
    this.details = payload.details;
    this.field_errors = payload.field_errors;
  }

  get isAuth() {
    return this.code === 'UNAUTHORIZED' || this.code === 'FORBIDDEN';
  }
  get isValidation() {
    return this.code === 'VALIDATION';
  }
}

/** Map an HTTP status to a stable error code. */
export function codeFromStatus(status: number): ApiErrorCode {
  switch (status) {
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 429:
      return 'RATE_LIMITED';
    case 0:
      return 'NETWORK';
    default:
      return status >= 500 ? 'SERVER_ERROR' : 'HTTP_ERROR';
  }
}

/** Extract a normalized ApiErrorPayload from arbitrary response text. */
export function parseErrorPayload(
  status: number,
  text: string,
  requestId: string,
): ApiErrorPayload {
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const message =
    parsed?.error || parsed?.message || parsed?.detail || (text || `请求失败 (${status})`).slice(0, 200);
  return {
    code: codeFromStatus(status),
    message: String(message),
    request_id: parsed?.request_id ?? requestId,
    status,
    field_errors: parsed?.field_errors,
    details: parsed ?? (text ? text.slice(0, 500) : undefined),
  };
}
