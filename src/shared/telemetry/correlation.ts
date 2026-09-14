// ── Telemetry: correlation ids (M00) ─────────────────────────────────────────
// Lightweight request/trace correlation. No experimental browser
// auto-instrumentation is a hard dependency (see 17-tech-radar / ADR-012).
// Generates ids in a W3C-traceparent-compatible format so they can later be
// attached to real OpenTelemetry spans without changing the wire shape.

let counter = 0;

function randomHex(len: number): string {
  const arr = new Uint8Array(len / 2);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface CorrelationIds {
  requestId: string; // 16 hex
  traceId: string; // 32 hex (W3C trace-id)
  spanId?: string; // 16 hex
}

/** Fresh request id (16 hex) for a single API call. */
export function newRequestId(): string {
  return randomHex(16);
}

/** Fresh correlation triple for a logical user action / route. */
export function newCorrelation(): CorrelationIds {
  counter = (counter + 1) % 0xffff;
  const low = (counter >>> 0).toString(16).padStart(4, '0');
  return {
    requestId: randomHex(16),
    traceId: randomHex(32),
    spanId: `${randomHex(12)}${low}`,
  };
}

/**
 * Build a W3C `traceparent` header value from a correlation triple.
 * Format: version-traceid-spanid-flags
 */
export function traceparentHeader(c: CorrelationIds): string {
  return `00-${c.traceId}-${c.spanId ?? randomHex(16)}-01`;
}

export type { CorrelationIds as TelemetryCorrelation };
