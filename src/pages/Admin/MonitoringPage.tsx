// 后台「全局监控」页面（#monitor · 纯后端接口可视化壳）
// 数据源（admin 鉴权，server/admin.cjs 提供）：
//   GET /api/admin/generations — 跨用户生成列表
//   GET /api/admin/assets      — media 资产链接总览
//   GET /api/admin/issues      — 合并「生成失败 + 系统错误」
// 三个独立 tab，各自筛选 + 游标分页（before=ISO，服务端 created_at < before）。
// 风格复用 @/components/skeleton（黑金玻璃拟态 + TabBar）。
import {
  Search,
  RefreshCw,
  Filter,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Image as ImageIcon,
  Database,
  Activity,
  Hash,
  Clock,
  Copy,
  ExternalLink,
  XCircle,
} from 'lucide-react';
import { PageHeader, StatCard, SectionCard, TabBar, cn } from '@/components/skeleton';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  apiGetGenerations,
  apiGetAssets,
  apiGetIssues,
  type GenerationItem,
  type AssetItem,
  type IssueItem,
} from '@/services/api';

const PAGE_OPTIONS = [50, 100, 500, 1000];
const DEFAULT_PAGE = 50;

// 历史数据兼容：早期 dispatcher 直接把 provider 返回的 b64_json 裸 base64 存进 URL 字段，
// admin 表格需要能正常预览和复制。新数据已统一为 data URI，此兜底仅影响旧行。
function normalizeAssetUrl(url?: string | null): string {
  if (!url) return '';
  const u = url.trim();
  if (u.startsWith('data:') || u.startsWith('http://') || u.startsWith('https://') || u.startsWith('/')) return u;
  if (/^[A-Za-z0-9+/=]{50,}$/.test(u)) return `data:image/png;base64,${u}`;
  return u;
}

function isDataUri(url?: string | null): boolean {
  return !!url && url.trim().startsWith('data:');
}

function LimitSelector({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none border border-zinc-700"
      title="每页加载数量"
    >
      {PAGE_OPTIONS.map((n) => (
        <option key={n} value={n}>每页 {n}</option>
      ))}
    </select>
  );
}

function PopOutButton({ tab }: { tab: 'generations' | 'assets' | 'issues' }) {
  return (
    <button
      onClick={() => window.open(`/monitoring/${tab}`, '_blank', 'noopener,noreferrer')}
      title="跳出单独页面"
      className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
    >
      <ExternalLink className="size-3" />
      单独页面
    </button>
  );
}

/* 通用游标分页 tab 状态机：filters/limit 变化→防抖重载；loadMore→追加下一页 */
function useMonitorTab<T>(apiFn: (p: any) => Promise<{ total: number; items: T[]; nextCursor: string | null }>, filters: any, limit: number) {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const cursorRef = useRef<string | null>(null);
  const reqIdRef = useRef(0);
  const loadingRef = useRef(false);

  const load = useCallback(
    async (reset: boolean) => {
      if (loadingRef.current) return; // 防止并发
      const myId = ++reqIdRef.current;
      loadingRef.current = true;
      setLoading(true);
      try {
        const res = await apiFn({ ...filters, limit, before: reset ? undefined : cursorRef.current ?? undefined });
        if (myId !== reqIdRef.current) return; // 丢弃过期响应
        setTotal(res.total);
        setItems((prev) => (reset ? res.items : [...prev, ...(res.items as T[])]));
        cursorRef.current = res.nextCursor ?? null;
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [filters, apiFn, limit],
  );

  // 仅在 filters 或 limit 真正变化时重置加载；filters 必须由调用方 useMemo 稳定
  useEffect(() => {
    cursorRef.current = null;
    const id = setTimeout(() => load(true), 120);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, limit, apiFn]);

  const loadMore = useCallback(() => load(false), [load]);
  const reset = useCallback(() => load(true), [load]);
  return { items, total, loading, loadMore, reset };
}

/* 表格容器滚动到底自动加载（带 300ms 节流） */
function useScrollLoad(loadMore: () => void, hasMore: boolean, loading: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const lastRef = useRef(0);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      if (!hasMore || loading) return;
      const now = Date.now();
      if (now - lastRef.current < 300) return;
      const { scrollTop, scrollHeight, clientHeight } = el;
      // 只有内容真正溢出时才触发
      if (scrollHeight <= clientHeight + 2) return;
      if (scrollTop + clientHeight >= scrollHeight - 80) {
        lastRef.current = now;
        loadMoreRef.current();
      }
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [hasMore, loading]);
  return ref;
}

function fmtDateTime(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtDuration(ms?: number | null) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
async function copyText(t: string) {
  try { await navigator.clipboard.writeText(t); } catch { /* 忽略 */ }
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    done: 'text-emerald-300 bg-emerald-500/15 ring-emerald-500/30',
    failed: 'text-rose-300 bg-rose-500/15 ring-rose-500/30',
    running: 'text-amber-300 bg-amber-500/15 ring-amber-500/30',
  };
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium ring-1', map[status] || 'text-zinc-300 bg-zinc-500/15 ring-zinc-500/30')}>
      {status}
    </span>
  );
}

/* ───────────────── 生成监控 ───────────────── */
export function GenerationsTab() {
  const [status, setStatus] = useState('');
  const [contentType, setContentType] = useState('');
  const [model, setModel] = useState('');
  const [user, setUser] = useState('');
  const [limit, setLimit] = useState(DEFAULT_PAGE);
  const filters = useMemo(() => ({ status, content_type: contentType, model, user }), [status, contentType, model, user]);
  const { items, total, loading, loadMore } = useMonitorTab<GenerationItem>(apiGetGenerations, filters, limit);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const scrollRef = useScrollLoad(loadMore, items.length < total, loading);

  const failedOnPage = items.filter((i) => i.status === 'failed').length;

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="shrink-0 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="总生成" value={total} icon={<Hash className="size-4" />} />
        <StatCard label="已加载" value={items.length} icon={<Database className="size-4" />} />
        <StatCard label="本页失败" value={failedOnPage} icon={<AlertTriangle className="size-4" />} />
        <StatCard label="筛选" value={status || contentType || model || user ? '已启用' : '无'} icon={<Filter className="size-4" />} />
      </div>

      <SectionCard
        className="flex-1 flex flex-col min-h-0"
        bodyClassName="flex-1 flex flex-col min-h-0"
        title="跨用户生成"
        hint={`命中 ${total} 条 · 已加载 ${items.length}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none border border-zinc-700">
              <option value="">全部状态</option>
              <option value="running">running</option>
              <option value="done">done</option>
              <option value="failed">failed</option>
            </select>
            <select value={contentType} onChange={(e) => setContentType(e.target.value)} className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none border border-zinc-700">
              <option value="">全部类型</option>
              <option value="image">image</option>
              <option value="video">video</option>
            </select>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型(模糊)" className="w-32 rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none border border-zinc-700" />
            <div className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-2 py-1 text-xs">
              <Search className="size-3 text-zinc-500" />
              <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="用户(昵称)" className="w-28 bg-transparent text-zinc-200 placeholder:text-zinc-600 outline-none" />
            </div>
            <LimitSelector value={limit} onChange={setLimit} />
            <PopOutButton tab="generations" />
          </div>
        }
      >
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto rounded-2xl border border-zinc-800 bg-zinc-950/60">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-zinc-900 text-zinc-400">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>时间</th><th>用户</th><th>模型</th><th>类型</th><th>状态</th><th>积分</th><th>耗时</th><th>提示词</th><th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const open = expanded.has(it.taskId);
                return (
                  <tr key={it.taskId} className="border-t border-zinc-800/60 align-top hover:bg-zinc-900/40">
                    <td className="whitespace-nowrap px-3 py-2 text-zinc-500 tabular-nums">{fmtDateTime(it.createdAt)}</td>
                    <td className="px-3 py-2 text-zinc-300">{it.user || <span className="text-zinc-600">匿名</span>}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-zinc-400">{it.model || '—'}</td>
                    <td className="px-3 py-2 text-zinc-400">{it.contentType}</td>
                    <td className="px-3 py-2"><StatusBadge status={it.status} /></td>
                    <td className="px-3 py-2 text-zinc-300 tabular-nums">{it.cost}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-zinc-400 tabular-nums">{fmtDuration(it.latencyMs)}</td>
                    <td className="max-w-[240px] px-3 py-2 text-zinc-400">
                      <span className="line-clamp-2">{it.prompt || '—'}</span>
                    </td>
                    <td className="px-3 py-2">
                      {it.status === 'failed' && it.error ? (
                        <button onClick={() => setExpanded((p) => { const n = new Set(p); n.has(it.taskId) ? n.delete(it.taskId) : n.add(it.taskId); return n; })} className="text-rose-300 hover:text-rose-200">
                          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {items.length === 0 && <div className="px-3 py-10 text-center text-zinc-600">{loading ? '加载中…' : '暂无生成记录'}</div>}
          {expanded.size > 0 && (
            <div className="border-t border-zinc-800 px-3 py-2 text-xs text-rose-200">
              {items.filter((i) => expanded.has(i.taskId)).map((i) => (
                <div key={i.taskId} className="mb-1 break-words"><span className="text-zinc-500">错误：</span>{i.error}</div>
              ))}
            </div>
          )}
        </div>
        <div className="mt-3 flex shrink-0 items-center justify-between">
          <span className="text-xs text-zinc-500">已加载 {items.length} / {total}</span>
          {items.length < total && (
            <button onClick={loadMore} disabled={loading} className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50">
              <Filter className="size-3" /> {loading ? '加载中…' : '加载更多'}
            </button>
          )}
        </div>
      </SectionCard>
    </div>
  );
}

/* ───────────────── 资产链接 ───────────────── */
export function AssetsTab() {
  const [type, setType] = useState('');
  const [user, setUser] = useState('');
  const [q, setQ] = useState('');
  const [isDeleted, setIsDeleted] = useState('');
  const [limit, setLimit] = useState(DEFAULT_PAGE);
  const filters = useMemo(() => ({ type, user, q, is_deleted: isDeleted }), [type, user, q, isDeleted]);
  const { items, total, loading, loadMore } = useMonitorTab<AssetItem>(apiGetAssets, filters, limit);
  const deletedOnPage = items.filter((i) => i.isDeleted).length;
  const scrollRef = useScrollLoad(loadMore, items.length < total, loading);

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="shrink-0 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="总资产" value={total} icon={<ImageIcon className="size-4" />} />
        <StatCard label="已加载" value={items.length} icon={<Database className="size-4" />} />
        <StatCard label="本页已删" value={deletedOnPage} icon={<XCircle className="size-4" />} />
        <StatCard label="筛选" value={type || user || q || isDeleted ? '已启用' : '无'} icon={<Filter className="size-4" />} />
      </div>

      <SectionCard
        className="flex-1 flex flex-col min-h-0"
        bodyClassName="flex-1 flex flex-col min-h-0"
        title="资产链接总览"
        hint={`命中 ${total} 条 · 已加载 ${items.length}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none border border-zinc-700">
              <option value="">全部类型</option>
              <option value="image">image</option>
              <option value="video">video</option>
            </select>
            <select value={isDeleted} onChange={(e) => setIsDeleted(e.target.value)} className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none border border-zinc-700">
              <option value="">删除状态(全部)</option>
              <option value="false">未删除</option>
              <option value="true">已删除</option>
            </select>
            <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="归属(昵称)" className="w-28 rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none border border-zinc-700" />
            <div className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-2 py-1 text-xs">
              <Search className="size-3 text-zinc-500" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="标题/URL" className="w-32 bg-transparent text-zinc-200 placeholder:text-zinc-600 outline-none" />
            </div>
            <LimitSelector value={limit} onChange={setLimit} />
            <PopOutButton tab="assets" />
          </div>
        }
      >
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto rounded-2xl border border-zinc-800 bg-zinc-950/60">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-zinc-900 text-zinc-400">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>预览</th><th>标题</th><th>类型</th><th>归属</th><th>状态</th><th>链接</th><th>时间</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const displayUrl = normalizeAssetUrl(it.url);
                return (
                <tr key={it.id} className="border-t border-zinc-800/60 align-middle hover:bg-zinc-900/40">
                  <td className="px-3 py-2">
                    {displayUrl ? (
                      <img src={displayUrl} alt="" className="size-10 rounded-lg object-cover bg-zinc-800" loading="lazy" />
                    ) : (
                      <div className="size-10 rounded-lg bg-zinc-800 grid place-items-center text-zinc-600">∅</div>
                    )}
                  </td>
                  <td className="max-w-[160px] px-3 py-2 text-zinc-300"><span className="line-clamp-2">{it.title || '—'}</span></td>
                  <td className="px-3 py-2 text-zinc-400">{it.type}</td>
                  <td className="px-3 py-2 text-zinc-300">{it.user || <span className="text-zinc-600">匿名</span>}</td>
                  <td className="px-3 py-2">{it.isDeleted ? <span className="text-rose-300">已删</span> : <span className="text-emerald-300">正常</span>}</td>
                  <td className="max-w-[260px] px-3 py-2">
                    {displayUrl ? (
                      <div className="flex items-center gap-1">
                        <a href={displayUrl} target="_blank" rel="noreferrer" title={displayUrl} className="line-clamp-1 break-all text-sky-300 hover:text-sky-200">
                          {isDataUri(displayUrl) ? '[Base64 内联图片]' : displayUrl}
                        </a>
                        <button onClick={() => copyText(displayUrl)} title="复制" className="shrink-0 text-zinc-500 hover:text-zinc-300"><Copy className="size-3" /></button>
                        <a href={displayUrl} target="_blank" rel="noreferrer" className="shrink-0 text-zinc-500 hover:text-zinc-300"><ExternalLink className="size-3" /></a>
                      </div>
                    ) : <span className="text-rose-400">死链(无 URL)</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-zinc-500 tabular-nums">{fmtDateTime(it.createdAt)}</td>
                </tr>
              )})}
            </tbody>
          </table>
          {items.length === 0 && <div className="px-3 py-10 text-center text-zinc-600">{loading ? '加载中…' : '暂无资产'}</div>}
        </div>
        <div className="mt-3 flex shrink-0 items-center justify-between">
          <span className="text-xs text-zinc-500">已加载 {items.length} / {total}</span>
          {items.length < total && (
            <button onClick={loadMore} disabled={loading} className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50">
              <Filter className="size-3" /> {loading ? '加载中…' : '加载更多'}
            </button>
          )}
        </div>
      </SectionCard>
    </div>
  );
}

/* ───────────────── 生成报错 ───────────────── */
export function IssuesTab() {
  const [scope, setScope] = useState('all');
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('');
  const [limit, setLimit] = useState(DEFAULT_PAGE);
  const filters = useMemo(() => ({ scope, keyword, category }), [scope, keyword, category]);
  const { items, total, loading, loadMore } = useMonitorTab<IssueItem>(apiGetIssues, filters, limit);
  const [expanded, setExpanded] = useState<Set<string | number>>(new Set());
  const scrollRef = useScrollLoad(loadMore, items.length < total, loading);

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="shrink-0 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="总报错" value={total} icon={<AlertTriangle className="size-4" />} />
        <StatCard label="已加载" value={items.length} icon={<Database className="size-4" />} />
        <StatCard label="生成失败" value={items.filter((i) => i.kind === 'generation').length} icon={<XCircle className="size-4" />} />
        <StatCard label="系统错误" value={items.filter((i) => i.kind === 'system').length} icon={<Activity className="size-4" />} />
      </div>

      <SectionCard
        className="flex-1 flex flex-col min-h-0"
        bodyClassName="flex-1 flex flex-col min-h-0"
        title="生成报错 + 系统错误（合并）"
        hint={`命中 ${total} 条 · 已加载 ${items.length} · 按时间归并`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select value={scope} onChange={(e) => setScope(e.target.value)} className="rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none border border-zinc-700">
              <option value="all">全部来源</option>
              <option value="generation">仅生成失败</option>
              <option value="system">仅系统错误</option>
            </select>
            <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="类别(系统,模糊)" className="w-32 rounded-lg bg-zinc-800 px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none border border-zinc-700" />
            <div className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-2 py-1 text-xs">
              <Search className="size-3 text-zinc-500" />
              <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="关键字" className="w-32 bg-transparent text-zinc-200 placeholder:text-zinc-600 outline-none" />
            </div>
            <LimitSelector value={limit} onChange={setLimit} />
            <PopOutButton tab="issues" />
          </div>
        }
      >
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto rounded-2xl border border-zinc-800 bg-zinc-950/60">
          {items.map((it) => {
            const open = expanded.has(it.id);
            const isGen = it.kind === 'generation';
            return (
              <div key={`${it.kind}-${it.id}`} className={cn('border-b border-zinc-800/60', open && (isGen ? 'bg-rose-500/5' : 'bg-amber-500/5'))}>
                <button onClick={() => setExpanded((p) => { const n = new Set(p); n.has(it.id) ? n.delete(it.id) : n.add(it.id); return n; })} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-zinc-900/40">
                  <span className="mt-0.5 shrink-0 text-zinc-500">{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</span>
                  <span className="shrink-0 text-zinc-500 tabular-nums text-xs">{fmtDateTime(it.createdAt)}</span>
                  <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1', isGen ? 'text-rose-300 bg-rose-500/15 ring-rose-500/30' : 'text-amber-300 bg-amber-500/15 ring-amber-500/30')}>
                    {isGen ? '生成失败' : '系统'}
                  </span>
                  {isGen ? (
                    <span className="shrink-0 text-zinc-500 text-xs">{it.model || ''}</span>
                  ) : (
                    <span className="shrink-0 rounded bg-zinc-700/40 px-1.5 py-0.5 text-[10px] text-zinc-300">{it.category}</span>
                  )}
                  <span className={cn('min-w-0 flex-1 whitespace-pre-wrap break-words text-xs', isGen ? 'text-rose-200' : 'text-zinc-300')}>
                    {isGen && it.user ? <span className="text-zinc-500">[{it.user}] </span> : null}
                    {it.error}
                  </span>
                </button>
                {open && (
                  <div className="space-y-1 px-9 pb-3 text-xs text-zinc-500">
                    <div>id: <span className="text-zinc-400">{String(it.id)}</span>{isGen ? '' : ` · category: ${it.category} · source: ${it.source}`}</div>
                    {!isGen && it.meta && Object.keys(it.meta).length > 0 && (
                      <pre className="max-h-48 overflow-auto rounded-lg border border-zinc-800 bg-zinc-900/70 p-2 text-[11px] text-sky-200 whitespace-pre-wrap break-words">{JSON.stringify(it.meta, null, 2)}</pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {items.length === 0 && <div className="px-3 py-10 text-center text-zinc-600">{loading ? '加载中…' : '暂无报错 🎉'}</div>}
        </div>
        <div className="mt-3 flex shrink-0 items-center justify-between">
          <span className="text-xs text-zinc-500">已加载 {items.length} / {total}</span>
          {items.length < total && (
            <button onClick={loadMore} disabled={loading} className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50">
              <Filter className="size-3" /> {loading ? '加载中…' : '加载更多'}
            </button>
          )}
        </div>
      </SectionCard>
    </div>
  );
}

/* ───────────────── 父页面 ───────────────── */
type MonitorTab = 'generations' | 'assets' | 'issues';

export default function MonitoringPage() {
  const [tab, setTab] = useState<MonitorTab>('generations');
  return (
    <div className="h-full flex flex-col gap-5 p-6">
      <PageHeader
        className="shrink-0"
        title="全局监控"
        subtitle="跨用户生成 · 资产链接 · 生成报错（合并系统错误） · 仅管理员可见 · 数据来自后端 REST 接口"
        icon={<Database className="size-5" />}
      />
      <TabBar<MonitorTab>
        className="shrink-0"
        tabs={[
          { key: 'generations', label: '用户生成', icon: <Activity className="size-4" /> },
          { key: 'assets', label: '资产链接', icon: <ImageIcon className="size-4" /> },
          { key: 'issues', label: '生成报错', icon: <AlertTriangle className="size-4" /> },
        ]}
        active={tab}
        onChange={setTab}
      />
      {/* 仅渲染当前 tab，避免 hidden tab 的 useEffect 副作用互相干扰 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {tab === 'generations' && <GenerationsTab />}
        {tab === 'assets' && <AssetsTab />}
        {tab === 'issues' && <IssuesTab />}
      </div>
    </div>
  );
}
