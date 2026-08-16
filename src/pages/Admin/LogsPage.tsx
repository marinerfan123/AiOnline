// 后台「实时日志 · 数据库/Redis/控制台」页面（M 模块前端）
// 数据源：SSE /api/admin/logs/stream（admin 鉴权，由 server/logbus.cjs 推送）
// 内容：
//   - 3 个统计：INFO / WARN / ERROR 计数（最近 1s 广播的累计值）
//   - 实时日志流：level 三色（INFO/WARN/ERROR）+ source 徽标(pg/redis/console/app)
//   - 筛选：按级别 / 按来源 / 关键字搜索；自动滚动可关；清空(服务端+本地)
// 目标：管理员一眼看出「错在哪、问题在哪」——PG/Redis 事件 + console.warn/error 全收纳
import {
  ScrollText,
  Info,
  AlertTriangle,
  XCircle,
  Filter,
  Pause,
  Play,
  Trash2,
  Search,
} from 'lucide-react';
import { PageHeader, StatCard, SectionCard, cn } from '@/components/skeleton';
import { useEffect, useMemo, useRef, useState } from 'react';

interface LogLine {
  id: number;
  ts: number;
  level: 'INFO' | 'WARN' | 'ERROR';
  source: string;
  message: string;
  meta?: any | null;
}
interface Snapshot {
  lines: LogLine[];
  stats: { total: number; byLevel: { INFO: number; WARN: number; ERROR: number }; startTs: number };
}

const LEVEL_OPTIONS = ['ALL', 'INFO', 'WARN', 'ERROR'] as const;
type LevelFilter = typeof LEVEL_OPTIONS[number];

const SOURCE_OPTIONS = ['ALL', 'pg', 'redis', 'console', 'app'] as const;
type SourceFilter = typeof SOURCE_OPTIONS[number];

// level → 行样式（三色）
const LEVEL_STYLE: Record<string, string> = {
  INFO: 'text-sky-300',
  WARN: 'text-amber-300',
  ERROR: 'text-rose-300',
};
// level → 左侧竖条 / 圆点
const LEVEL_DOT: Record<string, string> = {
  INFO: 'bg-sky-400',
  WARN: 'bg-amber-400',
  ERROR: 'bg-rose-400',
};
// source → 徽标
const SOURCE_STYLE: Record<string, string> = {
  pg: 'text-sky-300 bg-sky-500/15 ring-sky-500/30',
  redis: 'text-rose-300 bg-rose-500/15 ring-rose-500/30',
  console: 'text-zinc-300 bg-zinc-500/15 ring-zinc-500/30',
  app: 'text-emerald-300 bg-emerald-500/15 ring-emerald-500/30',
};

function fmtTime(ts: number) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

export default function LogsPage() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [stats, setStats] = useState({ total: 0, byLevel: { INFO: 0, WARN: 0, ERROR: 0 }, startTs: Date.now() });
  const [conn, setConn] = useState<'connecting' | 'live' | 'error'>('connecting');

  // 过滤状态
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('ALL');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('ALL');
  const [keyword, setKeyword] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  // SSE 订阅
  useEffect(() => {
    let alive = true;
    const es = new EventSource('/api/admin/logs/stream');
    es.onopen = () => { if (alive) setConn('live'); };
    es.onerror = () => { if (alive) setConn('error'); };
    es.onmessage = (e) => {
      if (!alive) return;
      try {
        const msg = JSON.parse((e as MessageEvent).data) as { type: string; data: any };
        if (msg.type === 'snapshot') {
          const s = msg.data as Snapshot;
          setLines(s.lines);
          setStats(s.stats);
        } else if (msg.type === 'log') {
          if (pausedRef.current) return;
          const l = msg.data as LogLine;
          setLines((prev) => {
            const next = [...prev, l];
            // 客户端只保留最近 1000 条（与服务端环形缓冲对齐）
            return next.length > 1000 ? next.slice(next.length - 1000) : next;
          });
        } else if (msg.type === 'stats') {
          setStats((prev) => ({ ...prev, ...msg.data }));
        }
      } catch {}
    };
    return () => { alive = false; es.close(); };
  }, []);

  // 自动滚动到底
  useEffect(() => {
    if (!autoScroll || pausedRef.current) return;
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [lines, autoScroll]);

  // 过滤
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return lines.filter((l) => {
      if (levelFilter !== 'ALL' && l.level !== levelFilter) return false;
      if (sourceFilter !== 'ALL' && l.source !== sourceFilter) return false;
      if (kw && !(`${l.message} ${l.source}`.toLowerCase().includes(kw))) return false;
      return true;
    });
  }, [lines, levelFilter, sourceFilter, keyword]);

  // 清空
  const localClear = () => setLines([]);
  const serverClear = async () => {
    try {
      await fetch('/api/admin/logs/clear', { method: 'POST', credentials: 'include' });
      setLines([]);
    } catch {}
  };

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="实时日志 · 数据库 / Redis / 控制台"
        subtitle="PG / Redis 事件 + console.warn·error 统一采集 · admin 鉴权 · SSE 推送 · 仅管理员可见"
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

      {/* 3 个级别统计卡 */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard
          label="INFO"
          value={String(stats.byLevel.INFO)}
          icon={<Info className="size-4" />}
        />
        <StatCard
          label="WARN"
          value={String(stats.byLevel.WARN)}
          icon={<AlertTriangle className="size-4" />}
        />
        <StatCard
          label="ERROR"
          value={String(stats.byLevel.ERROR)}
          icon={<XCircle className="size-4" />}
        />
      </div>

      {/* 实时日志流 */}
      <SectionCard
        title="日志流"
        subtitle={`共 ${filtered.length} 条显示 · 服务端缓冲 1000 条 · 累计 ${stats.total} (启动至今)`}
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

            {/* 级别筛选 */}
            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value as LevelFilter)}
              className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none border border-zinc-700"
            >
              {LEVEL_OPTIONS.map((m) => (
                <option key={m} value={m}>{m === 'ALL' ? '全部级别' : m}</option>
              ))}
            </select>

            {/* 来源筛选 */}
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
              className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none border border-zinc-700"
            >
              {SOURCE_OPTIONS.map((m) => (
                <option key={m} value={m}>{m === 'ALL' ? '全部来源' : m}</option>
              ))}
            </select>

            {/* 关键字搜索 */}
            <div className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-2 py-1 text-xs">
              <Search className="size-3 text-zinc-500" />
              <input
                type="text"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="关键字"
                className="w-28 bg-transparent text-zinc-200 placeholder:text-zinc-600 outline-none"
              />
            </div>

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
          ref={scrollRef}
          className="max-h-[560px] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950/60 font-mono text-xs"
        >
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-zinc-600">等待日志事件…</div>
          ) : (
            filtered.slice().reverse().map((l) => {
              const isError = l.level === 'ERROR';
              const isWarn = l.level === 'WARN';
              return (
                <div
                  key={l.id}
                  className={cn(
                    'flex items-start gap-2 border-b border-zinc-800/50 px-3 py-1.5 leading-relaxed',
                    isError ? 'bg-rose-500/5' : isWarn ? 'bg-amber-500/5' : 'hover:bg-zinc-900/40',
                    'transition-colors',
                  )}
                >
                  <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', LEVEL_DOT[l.level])} />
                  <span className="shrink-0 text-zinc-500 tabular-nums">{fmtTime(l.ts)}</span>
                  <span className={cn('shrink-0 font-semibold', LEVEL_STYLE[l.level])}>{l.level}</span>
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1',
                      SOURCE_STYLE[l.source] || SOURCE_STYLE.app,
                    )}
                  >
                    {l.source}
                  </span>
                  <span className={cn('min-w-0 flex-1 whitespace-pre-wrap break-words', isError ? 'text-rose-200' : isWarn ? 'text-amber-200' : 'text-zinc-300')}>
                    {l.message}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </SectionCard>

      {/* 说明 */}
      <div className="flex items-start gap-2 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-xs text-zinc-500">
        <Filter className="mt-0.5 size-3.5 shrink-0" />
        <span>
          来源说明：<span className="text-sky-300">pg</span> = PostgreSQL 连接池事件；
          <span className="text-rose-300">redis</span> = Redis 连接/重连事件；
          <span className="text-zinc-300">console</span> = 服务端 console.warn/error（已保留原行为并去重）；
          <span className="text-emerald-300">app</span> = 业务显式日志。点击「清空」仅清缓冲，累计计数保留。
        </span>
      </div>
    </div>
  );
}
