// 后台「实时监控 · API 活动流」页面（M3 强化：覆盖所有 HTTP 路径的实时仪表盘）
// 数据源：SSE /api/admin/monitor/stream（admin 鉴权，由 server/monitor.cjs 推送）
// 内容：
//   - 5 个 KPI 卡：QPS / 成功率 / P95 时延 / 错误(>=400) / 总请求(累计)
//   - 60 秒吞吐 sparkline（红顶 = 告警阈值）
//   - 实时活动表：可按"只看错误"/"路径子串"/"方法"筛选，自动滚动可关
import { Activity, Zap, CheckCircle2, Timer, AlertTriangle, Hash, Filter, Pause, Play, Trash2 } from 'lucide-react';
import { PageHeader, StatCard, SectionCard, cn } from '@/components/skeleton';
import { useEffect, useMemo, useRef, useState } from 'react';

interface Record {
  id: number;
  ts: number;
  method: string;
  url: string;
  status: number;
  latencyMs: number;
  upstream?: { provider?: string; model?: string } | null;
}
interface Metrics {
  qps: number;
  successRate: number | null;
  p95: number | null;
  errors: number;
  total60s: number;
}
interface Snapshot {
  records: Record[];
  metrics: Metrics;
  cumulative: { total: number; errors: number; startTs: number };
}

const METHOD_OPTIONS = ['ALL', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
type MethodFilter = typeof METHOD_OPTIONS[number];

const STATUS_STYLE = (s: number) => {
  if (s >= 500) return 'text-rose-300 bg-rose-500/15 ring-rose-500/30';
  if (s >= 400) return 'text-amber-300 bg-amber-500/15 ring-amber-500/30';
  if (s >= 300) return 'text-sky-300 bg-sky-500/15 ring-sky-500/30';
  if (s >= 200) return 'text-emerald-300 bg-emerald-500/15 ring-emerald-500/30';
  return 'text-zinc-400 bg-zinc-500/15 ring-zinc-500/30';
};

const METHOD_STYLE: Record<string, string> = {
  GET: 'text-sky-300 bg-sky-500/10',
  POST: 'text-emerald-300 bg-emerald-500/10',
  PUT: 'text-amber-300 bg-amber-500/10',
  DELETE: 'text-rose-300 bg-rose-500/10',
  PATCH: 'text-violet-300 bg-violet-500/10',
};

function fmtTime(ts: number) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

// 60 秒每秒一桶的 sparkline，红顶 = 触达 max*0.8 视为告警
function ThroughputSparkline({ records }: { records: Record[] }) {
  const buckets = useMemo(() => {
    const out = new Array(60).fill(0);
    const now = Date.now();
    for (const r of records) {
      const sec = Math.floor((now - r.ts) / 1000);
      if (sec >= 0 && sec < 60) out[59 - sec]++;
    }
    return out;
  }, [records]);
  const max = Math.max(1, ...buckets);
  const W = 600, H = 60, barW = W / 60 - 1;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-14" preserveAspectRatio="none">
      {buckets.map((v, i) => {
        const h = (v / max) * (H - 4);
        const y = H - h;
        const warn = v >= max * 0.8;
        return (
          <rect
            key={i}
            x={i * (barW + 1)}
            y={y}
            width={barW}
            height={Math.max(1, h)}
            rx={1}
            fill={warn ? '#ef4444' : '#10b981'}
            opacity={v === 0 ? 0.15 : 0.85}
          />
        );
      })}
    </svg>
  );
}

export default function MonitorPage() {
  const [records, setRecords] = useState<Record[]>([]);
  const [metrics, setMetrics] = useState<Metrics>({ qps: 0, successRate: null, p95: null, errors: 0, total60s: 0 });
  const [cumulative, setCumulative] = useState({ total: 0, errors: 0, startTs: Date.now() });
  const [conn, setConn] = useState<'connecting' | 'live' | 'error'>('connecting');

  // 过滤状态
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [pathFilter, setPathFilter] = useState('');
  const [methodFilter, setMethodFilter] = useState<MethodFilter>('ALL');
  const [autoScroll, setAutoScroll] = useState(true);

  const tableRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  // SSE 订阅
  useEffect(() => {
    let alive = true;
    const es = new EventSource('/api/admin/monitor/stream');
    es.onopen = () => { if (alive) setConn('live'); };
    es.onerror = () => { if (alive) setConn('error'); };
    es.onmessage = (e) => {
      if (!alive) return;
      try {
        const msg = JSON.parse((e as MessageEvent).data) as { type: string; data: any };
        if (msg.type === 'snapshot') {
          const s = msg.data as Snapshot;
          setRecords(s.records);
          setMetrics(s.metrics);
          setCumulative(s.cumulative);
        } else if (msg.type === 'req') {
          if (pausedRef.current) return;
          const r = msg.data as Record;
          setRecords((prev) => {
            const next = [...prev, r];
            // 客户端只保留最近 500 条（与服务端对齐）
            return next.length > 500 ? next.slice(next.length - 500) : next;
          });
        } else if (msg.type === 'metrics') {
          setMetrics(msg.data as Metrics);
        }
      } catch {}
    };
    return () => { alive = false; es.close(); };
  }, []);

  // 自动滚动：records 变化时滚到底部（受 autoScroll 与 paused 控制）
  useEffect(() => {
    if (!autoScroll || pausedRef.current) return;
    if (tableRef.current) tableRef.current.scrollTop = tableRef.current.scrollHeight;
  }, [records, autoScroll]);

  // 过滤
  const filtered = useMemo(() => {
    const path = pathFilter.trim().toLowerCase();
    return records.filter((r) => {
      if (errorsOnly && r.status < 400) return false;
      if (methodFilter !== 'ALL' && r.method !== methodFilter) return false;
      if (path && !r.url.toLowerCase().includes(path)) return false;
      return true;
    });
  }, [records, errorsOnly, pathFilter, methodFilter]);

  // 清空（仅客户端隐藏；服务端 records 由"清空"按钮单独触发）
  const localClear = () => setRecords([]);
  const serverClear = async () => {
    try {
      await fetch('/api/admin/monitor/clear', { method: 'POST', credentials: 'include' });
      setRecords([]);
    } catch {}
  };

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="实时监控 · API 活动流"
        subtitle="覆盖全站 HTTP 请求 · admin 鉴权 · SSE 推送 · 仅管理员可见"
        actions={
          <span
            className={cn(
              'inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1',
              conn === 'live' && 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
              conn === 'connecting' && 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
              conn === 'error' && 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
            )}
          >
            <span
              className={cn(
                'size-2 rounded-full',
                conn === 'live' && 'bg-emerald-400 animate-pulse',
                conn === 'connecting' && 'bg-amber-400',
                conn === 'error' && 'bg-rose-400',
              )}
            />
            {conn === 'live' ? '实时' : conn === 'connecting' ? '连接中' : '已断开'}
          </span>
        }
      />

      {/* KPI 5 卡 */}
      <div className="grid grid-cols-5 gap-3">
        <StatCard
          label="QPS (req/s)"
          value={metrics.qps.toFixed(1)}
          icon={<Zap className="size-4" />}
        />
        <StatCard
          label="成功率"
          value={metrics.successRate == null ? '—' : `${(metrics.successRate * 100).toFixed(1)}%`}
          icon={<CheckCircle2 className="size-4" />}
        />
        <StatCard
          label="P95 时延"
          value={metrics.p95 == null ? '—' : `${metrics.p95}ms`}
          icon={<Timer className="size-4" />}
        />
        <StatCard
          label="错误(>=400)"
          value={String(metrics.errors)}
          icon={<AlertTriangle className="size-4" />}
        />
        <StatCard
          label="总请求"
          value={String(cumulative.total)}
          icon={<Hash className="size-4" />}
        />
      </div>

      {/* 吞吐 sparkline */}
      <SectionCard title="每秒请求量" subtitle="最近 60 秒 · 红顶 = 触达峰值 80% 告警阀">
        <ThroughputSparkline records={records} />
      </SectionCard>

      {/* 实时活动表 */}
      <SectionCard
        title="API 活动流"
        subtitle={`共 ${filtered.length} 条 · 服务端缓冲 500 条 · 累计 ${cumulative.total} (启动至今)`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={serverClear}
              className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
              title="清空服务端环形缓冲"
            >
              <Trash2 className="size-3" /> 清空
            </button>
            <button
              onClick={localClear}
              className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
              title="仅清空当前显示"
            >
              <Trash2 className="size-3" /> 清屏
            </button>
            <label className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 cursor-pointer hover:bg-zinc-700 transition-colors">
              <input
                type="checkbox"
                checked={errorsOnly}
                onChange={(e) => setErrorsOnly(e.target.checked)}
                className="size-3 accent-rose-500"
              />
              错误
            </label>
            <div className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-2 py-1 text-xs">
              <Filter className="size-3 text-zinc-500" />
              <input
                type="text"
                value={pathFilter}
                onChange={(e) => setPathFilter(e.target.value)}
                placeholder="路径子串"
                className="w-28 bg-transparent text-zinc-200 placeholder:text-zinc-600 outline-none"
              />
            </div>
            <select
              value={methodFilter}
              onChange={(e) => setMethodFilter(e.target.value as MethodFilter)}
              className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none border border-zinc-700"
            >
              {METHOD_OPTIONS.map((m) => (
                <option key={m} value={m}>{m === 'ALL' ? '全部' : m}</option>
              ))}
            </select>
            <label className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 cursor-pointer hover:bg-zinc-700 transition-colors">
              <input
                type="checkbox"
                checked={paused}
                onChange={(e) => setPaused(e.target.checked)}
                className="size-3 accent-emerald-500"
              />
              {paused ? <Pause className="size-3" /> : <Play className="size-3" />}
              {paused ? '已暂停' : '实时'}
            </label>
            <label className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 cursor-pointer hover:bg-zinc-700 transition-colors">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="size-3 accent-emerald-500"
              />
              自动滚动
            </label>
          </div>
        }
      >
        <div
          ref={tableRef}
          className="max-h-[520px] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950/60"
        >
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-zinc-900/95 backdrop-blur text-zinc-500 uppercase tracking-wider">
              <tr>
                <th className="px-3 py-2 text-left font-medium">时间</th>
                <th className="px-3 py-2 text-left font-medium">方法</th>
                <th className="px-3 py-2 text-left font-medium">路径</th>
                <th className="px-3 py-2 text-left font-medium">状态</th>
                <th className="px-3 py-2 text-right font-medium">时延</th>
                <th className="px-3 py-2 text-left font-medium">上/下游</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-zinc-600">
                    等待流量...
                  </td>
                </tr>
              ) : (
                filtered.slice().reverse().map((r) => (
                  <tr key={r.id} className="border-t border-zinc-800/60 hover:bg-zinc-900/40 transition-colors">
                    <td className="px-3 py-1.5 text-zinc-400">{fmtTime(r.ts)}</td>
                    <td className="px-3 py-1.5">
                      <span className={cn('inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold', METHOD_STYLE[r.method] || 'text-zinc-300 bg-zinc-700/40')}>
                        {r.method}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-zinc-200 max-w-[480px] truncate" title={r.url}>
                      {r.url}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={cn('inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1', STATUS_STYLE(r.status))}>
                        {r.status}
                      </span>
                    </td>
                    <td className={cn('px-3 py-1.5 text-right tabular-nums', r.latencyMs >= 500 ? 'text-amber-300' : r.latencyMs >= 200 ? 'text-zinc-300' : 'text-zinc-500')}>
                      {r.latencyMs}ms
                    </td>
                    <td className="px-3 py-1.5 text-zinc-500 truncate max-w-[160px]">
                      {r.upstream?.provider ? `${r.upstream.provider}${r.upstream.model ? `/${r.upstream.model}` : ''}` : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}