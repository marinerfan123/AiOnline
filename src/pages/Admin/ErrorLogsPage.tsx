// 后台「核心错误日志 · 历史持久化」页面（#449–#453）
// 数据源：GET /api/admin/errors（admin 鉴权，由 server/syslog.cjs 提供）
// 写入链路：server/logbus.cjs 在 emit('ERROR') 时统一调 persistError → syslog.insertError
//          落库 system_error_logs；叠加进程级 uncaughtException/unhandledRejection 兜底。
// 内容：
//   - 4 个 KPI 卡：累计 / 今日 / 近24h / TOP 类别（按系统历史统计，不受筛选影响）
//   - 历史错误流：category 徽标 + source + message + 可展开 meta/stack
//   - 筛选：按类别（服务端）/ 关键字（服务端）/ 时间窗（客户端）
//   - 分页（LOAD MORE，服务端 limit 游标）/ 手动刷新 / 自动轮询
//   - 清空历史（按类别或全量，DELETE /api/admin/errors）
import {
  XCircle,
  Search,
  Trash2,
  RefreshCw,
  Filter,
  ChevronDown,
  ChevronRight,
  Hash,
  Clock,
  AlertOctagon,
} from 'lucide-react';
import { PageHeader, StatCard, SectionCard, cn } from '@/components/skeleton';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGetErrors, apiClearErrors, type SystemErrorItem, type SystemErrorsResponse } from '@/services/api';

// category → 徽标（与后端写入来源对齐：console/pg/redis/app/billing/uncaughtException/unhandledRejection/process）
const CATEGORY_STYLE: Record<string, string> = {
  uncaughtException: 'text-rose-300 bg-rose-500/15 ring-rose-500/30',
  unhandledRejection: 'text-orange-300 bg-orange-500/15 ring-orange-500/30',
  console: 'text-zinc-300 bg-zinc-500/15 ring-zinc-500/30',
  pg: 'text-sky-300 bg-sky-500/15 ring-sky-500/30',
  redis: 'text-rose-300 bg-rose-500/15 ring-rose-500/30',
  billing: 'text-amber-300 bg-amber-500/15 ring-amber-500/30',
  app: 'text-emerald-300 bg-emerald-500/15 ring-emerald-500/30',
  process: 'text-fuchsia-300 bg-fuchsia-500/15 ring-fuchsia-500/30',
};

const TIME_OPTIONS = [
  { key: 'ALL', label: '全部时间' },
  { key: '24h', label: '近 24 小时' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
] as const;
type TimeWindow = typeof TIME_OPTIONS[number]['key'];

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}
function fmtDate(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${mo}-${da} ${fmtTime(iso)}`;
}

function withinWindow(iso: string, win: TimeWindow) {
  if (win === 'ALL') return true;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return true;
  const now = Date.now();
  if (win === '24h') return now - t <= 86400000;
  if (win === '7d') return now - t <= 7 * 86400000;
  if (win === '30d') return now - t <= 30 * 86400000;
  return true;
}

const PAGE_SIZE = 100;

export default function ErrorLogsPage() {
  const [data, setData] = useState<SystemErrorsResponse>({ items: [], total: 0, stats: { total: 0, today: 0, last24h: 0, byCategory: [] } });
  const [loading, setLoading] = useState(true);

  // 筛选状态
  const [category, setCategory] = useState('ALL');
  const [keyword, setKeyword] = useState('');
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('ALL');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const reqIdRef = useRef(0);

  const load = async () => {
    const myId = ++reqIdRef.current;
    setLoading(true);
    const res = await apiGetErrors({
      category: category === 'ALL' ? '' : category,
      keyword: keyword.trim(),
      limit,
    });
    if (myId !== reqIdRef.current) return; // 丢弃过期响应
    setData(res);
    setLoading(false);
  };

  // 初次 + 筛选/分页变化 → 重新拉取
  useEffect(() => {
    setLimit(PAGE_SIZE);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, keyword]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit]);

  // 自动轮询
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(() => load(), 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, category, keyword, limit]);

  // 类别下拉：继承统计里的真实类别 + 常见预设
  const categoryOptions = useMemo(() => {
    const set = new Set<string>(['app', 'console', 'pg', 'redis', 'billing', 'uncaughtException', 'unhandledRejection', 'process']);
    data.stats.byCategory.forEach((c) => set.add(c.category));
    return ['ALL', ...Array.from(set)];
  }, [data.stats.byCategory]);

  const filtered = useMemo(
    () => data.items.filter((it) => withinWindow(it.createdAt, timeWindow)),
    [data.items, timeWindow],
  );

  const hasMore = data.items.length < data.total;

  const loadMore = () => setLimit((l) => Math.min(l + PAGE_SIZE, 500));

  const toggleExpand = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleClear = async () => {
    const scope = category === 'ALL' ? '全部核心错误历史' : `类别「${category}」的历史`;
    if (!window.confirm(`确认清空${scope}？此操作不可恢复。`)) return;
    await apiClearErrors(category === 'ALL' ? undefined : category);
    setLimit(PAGE_SIZE);
    await load();
  };

  const topCategory = data.stats.byCategory[0];

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="核心错误日志 · 历史持久化"
        subtitle="每一次核心错误（console.error + 业务显式 ERROR + 进程级未捕获异常）均落库 system_error_logs · 重启不丢 · 仅管理员可见"
        actions={
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 bg-emerald-500/15 text-emerald-300 ring-emerald-500/30 hover:bg-emerald-500/25 transition-colors"
          >
            <RefreshCw className={cn('size-3', loading && 'animate-spin')} /> 刷新
          </button>
        }
      />

      {/* 4 个 KPI 卡（系统级统计，不受筛选影响） */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="累计错误" value={String(data.stats.total)} icon={<Hash className="size-4" />} />
        <StatCard label="今日" value={String(data.stats.today)} icon={<Clock className="size-4" />} />
        <StatCard label="近 24 小时" value={String(data.stats.last24h)} icon={<AlertOctagon className="size-4" />} />
        <StatCard
          label="TOP 类别"
          value={topCategory ? `${topCategory.category}` : '—'}
          icon={<XCircle className="size-4" />}
          subtitle={topCategory ? `${topCategory.count} 条` : '暂无'}
        />
      </div>

      {/* 历史错误流 */}
      <SectionCard
        title="历史错误"
        subtitle={`服务端命中 ${data.total} 条 · 当前加载 ${data.items.length} 条 · 时间窗过滤后显示 ${filtered.length} 条`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleClear}
              className="inline-flex items-center gap-1 rounded-lg bg-rose-800/40 px-2.5 py-1 text-xs text-rose-200 hover:bg-rose-700/50 transition-colors"
              title="清空历史错误（可仅清当前类别）"
            >
              <Trash2 className="size-3" /> 清空
            </button>

            {/* 类别筛选（服务端） */}
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none border border-zinc-700"
            >
              {categoryOptions.map((m) => (
                <option key={m} value={m}>{m === 'ALL' ? '全部类别' : m}</option>
              ))}
            </select>

            {/* 时间窗筛选（客户端） */}
            <select
              value={timeWindow}
              onChange={(e) => setTimeWindow(e.target.value as TimeWindow)}
              className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none border border-zinc-700"
            >
              {TIME_OPTIONS.map((m) => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </select>

            {/* 关键字搜索 */}
            <div className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-2 py-1 text-xs">
              <Search className="size-3 text-zinc-500" />
              <input
                type="text"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="关键字（message/source）"
                className="w-40 bg-transparent text-zinc-200 placeholder:text-zinc-600 outline-none"
              />
            </div>

            <label className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 cursor-pointer hover:bg-zinc-700 transition-colors">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="size-3 accent-emerald-500"
              />
              <RefreshCw className="size-3" /> 自动轮询
            </label>
          </div>
        }
      >
        <div className="max-h-[560px] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-950/60">
          {filtered.length === 0 ? (
            <div className="px-3 py-10 text-center text-zinc-600">
              {loading ? '加载中…' : '暂无核心错误记录 🎉'}
            </div>
          ) : (
            filtered.map((it: SystemErrorItem) => {
              const open = expanded.has(it.id);
              return (
                <div key={it.id} className={cn('border-b border-zinc-800/60', open && 'bg-rose-500/5')}>
                  <button
                    onClick={() => toggleExpand(it.id)}
                    className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-zinc-900/40 transition-colors"
                  >
                    <span className="mt-0.5 shrink-0 text-zinc-500">
                      {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    </span>
                    <span className="shrink-0 text-zinc-500 tabular-nums text-xs">{fmtDate(it.createdAt)}</span>
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1',
                        CATEGORY_STYLE[it.category] || 'text-zinc-300 bg-zinc-500/15 ring-zinc-500/30',
                      )}
                      title={`source: ${it.source}`}
                    >
                      {it.category}
                    </span>
                    <span className={cn('min-w-0 flex-1 whitespace-pre-wrap break-words text-xs', it.category === 'uncaughtException' ? 'text-rose-200' : 'text-zinc-300')}>
                      {it.message}
                    </span>
                  </button>
                  {open && (
                    <div className="space-y-2 px-9 pb-3 text-xs">
                      <div className="text-zinc-500">
                        id: <span className="text-zinc-400">{it.id}</span> · source: <span className="text-zinc-400">{it.source}</span> · createdAt: <span className="text-zinc-400">{it.createdAt}</span>
                      </div>
                      {it.meta && Object.keys(it.meta).length > 0 && (
                        <div>
                          <div className="mb-1 text-zinc-500">meta（结构化附加信息）：</div>
                          <pre className="max-h-48 overflow-auto rounded-lg border border-zinc-800 bg-zinc-900/70 p-2 text-[11px] text-sky-200 whitespace-pre-wrap break-words">
                            {JSON.stringify(it.meta, null, 2)}
                          </pre>
                        </div>
                      )}
                      {it.stack && (
                        <div>
                          <div className="mb-1 text-zinc-500">stack（错误堆栈）：</div>
                          <pre className="max-h-64 overflow-auto rounded-lg border border-zinc-800 bg-zinc-900/70 p-2 text-[11px] text-rose-200 whitespace-pre-wrap break-words font-mono">
                            {it.stack}
                          </pre>
                        </div>
                      )}
                      {(!it.meta || Object.keys(it.meta).length === 0) && !it.stack && (
                        <div className="text-zinc-600">无附加 meta / stack</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* 分页 / LOAD MORE */}
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-zinc-500">
            已加载 {data.items.length} / {data.total} 条
          </span>
          <div className="flex items-center gap-2">
            {hasMore && (
              <button
                onClick={loadMore}
                disabled={loading}
                className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 transition-colors"
              >
                <Filter className="size-3" /> 加载更多
              </button>
            )}
          </div>
        </div>
      </SectionCard>

      {/* 说明 */}
      <div className="flex items-start gap-2 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-xs text-zinc-500">
        <XCircle className="mt-0.5 size-3.5 shrink-0" />
        <span>
          覆盖范围：① <span className="text-zinc-300">console</span> = 服务端 console.error（由 logbus 采集并去重，统一落库）；
          ② <span className="text-emerald-300">app</span> = 业务显式 ERROR；
          ③ <span className="text-rose-300">uncaughtException</span> / <span className="text-orange-300">unhandledRejection</span> = 进程级未捕获异常兜底（记录后进程将优雅退出 / 仅记录不退出）。
          日志为持久化存储，服务重启不丢失；点击任意行可展开查看 meta 与 stack。
        </span>
      </div>
    </div>
  );
}
