// ── Telemetry: structured client logger (M00) ────────────────────────────────
// Bounded, non-blocking structured logging. Does NOT replace server structured
// logs. In M00 it is a console-backed sink with correlation id attach; later a
// real exporter (OTLP) can be plugged behind the same interface (ADR-012).

import type { CorrelationIds } from './correlation';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  event: string;
  message?: string;
  correlation?: Partial<CorrelationIds>;
  data?: Record<string, unknown>;
  ts: number;
}

export interface TelemetrySink {
  write(entry: LogEntry): void;
}

const consoleSink: TelemetrySink = {
  write(entry) {
    const args: unknown[] = [
      `[ml2:${entry.level}]`,
      entry.event,
      entry.correlation?.requestId ? `req=${entry.correlation.requestId}` : '',
      entry.message ?? '',
      entry.data ?? '',
    ];
    const fn = entry.level === 'error' ? console.error : entry.level === 'warn' ? console.warn : console.info;
    fn(...args.filter((a) => a !== ''));
  },
};

let sink: TelemetrySink = consoleSink;

export function setTelemetrySink(s: TelemetrySink) {
  sink = s;
}

function log(level: LogLevel, event: string, msg?: string, data?: Record<string, unknown>, corr?: Partial<CorrelationIds>) {
  // dev-only debug to keep prod console clean
  if (level === 'debug' && !import.meta.env.DEV) return;
  sink.write({ level, event, message: msg, data, correlation: corr, ts: Date.now() });
}

export const telemetry = {
  debug: (e: string, m?: string, d?: Record<string, unknown>, c?: Partial<CorrelationIds>) => log('debug', e, m, d, c),
  info: (e: string, m?: string, d?: Record<string, unknown>, c?: Partial<CorrelationIds>) => log('info', e, m, d, c),
  warn: (e: string, m?: string, d?: Record<string, unknown>, c?: Partial<CorrelationIds>) => log('warn', e, m, d, c),
  error: (e: string, m?: string, d?: Record<string, unknown>, c?: Partial<CorrelationIds>) => log('error', e, m, d, c),
};
