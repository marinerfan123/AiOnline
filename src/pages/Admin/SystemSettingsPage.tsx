// 后台「系统设置」：平台级配置聚合。
// 当前承载「工作台模型下拉排序方式」，供 GenerationBar 渲染模型下拉时读取，
// 让用户/运营按需切换排序逻辑（手动权重 / 名称 / 积分），无需改代码。
//
// 存储：settings 表 key='app' 的 value JSON 中的 workspaceModelSort 字段；
// 后端 PUT /api/settings 已做合并写入（局部保存不会覆盖后台其它配置）。
import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Settings2, Save, Loader2, ArrowDownWideNarrow, Gauge, Clock } from 'lucide-react';
import { apiGetSettings, apiSaveSettings } from '@/services/api';
import type { ModelSortMode } from '@/utils/groupModels';

/** 工作台模型下拉的排序选项（与 groupModels.ts 的 ModelSortMode 对应） */
const SORT_OPTIONS: { value: ModelSortMode; label: string; desc: string }[] = [
  { value: 'manual', label: '手动排序', desc: '按后台「模型价格」页设置的排序权重（sort_order）排列，最精确、可逐模型微调' },
  { value: 'name', label: '按名称', desc: '按模型展示名的中文拼音 / 字母顺序排序' },
  { value: 'credits', label: '按积分', desc: '按消耗积分数升序排列，便宜的模型排在前面' },
];

const cn = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

function normalizeSort(v: unknown): ModelSortMode {
  return v === 'name' || v === 'credits' ? v : 'manual';
}

export default function SystemSettingsPage() {
  const [sortMode, setSortMode] = useState<ModelSortMode>('manual');
  const [loaded, setLoaded] = useState<ModelSortMode>('manual');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // 生成限流（应用层，按 IP）：每窗口最大次数 + 时间窗口（秒）
  const [genLimit, setGenLimit] = useState<number>(30);
  const [genWindow, setGenWindow] = useState<number>(60);
  const [loadedLimit, setLoadedLimit] = useState<number>(30);
  const [loadedWindow, setLoadedWindow] = useState<number>(60);

  // 全局生成并发数（maxThreads）：调度器同时进行的生成任务上限
  const [maxThreads, setMaxThreads] = useState<number>(10);
  const [loadedThreads, setLoadedThreads] = useState<number>(10);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = (await apiGetSettings().catch(() => ({}))) || {};
        if (!cancelled) {
          const m = normalizeSort(s.workspaceModelSort);
          setSortMode(m);
          setLoaded(m);
          const rl = (s.genRateLimit && typeof s.genRateLimit === 'object') ? s.genRateLimit : {};
          const lim = Number(rl.limit);
          const win = Number(rl.windowSec);
          const safeLimit = Number.isInteger(lim) && lim > 0 ? lim : 30;
          const safeWindow = Number.isInteger(win) && win > 0 ? win : 60;
          setGenLimit(safeLimit);
          setGenWindow(safeWindow);
          setLoadedLimit(safeLimit);
          setLoadedWindow(safeWindow);
          const mt = Number(s.maxThreads);
          const safeThreads = Number.isInteger(mt) && mt >= 1 && mt <= 1000 ? mt : 10;
          setMaxThreads(safeThreads);
          setLoadedThreads(safeThreads);
        }
      } catch {
        // 读不到配置不阻断，回退默认 manual
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const dirty = sortMode !== loaded
    || genLimit !== loadedLimit
    || genWindow !== loadedWindow
    || maxThreads !== loadedThreads;

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const cur = (await apiGetSettings().catch(() => ({}))) || {};
      await apiSaveSettings({
        ...cur,
        workspaceModelSort: sortMode,
        genRateLimit: { limit: genLimit, windowSec: genWindow },
        maxThreads,
      });
      setLoaded(sortMode);
      setLoadedLimit(genLimit);
      setLoadedWindow(genWindow);
      setLoadedThreads(maxThreads);
      toast.success('已保存系统设置');
    } catch (e) {
      toast.error('保存失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  }, [sortMode, genLimit, genWindow, maxThreads]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {/* 页头 */}
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-800/70">
          <Settings2 className="h-5 w-5 text-emerald-400" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">系统设置</h1>
          <p className="text-xs text-zinc-500">平台级配置聚合，影响前台工作台与生成体验。</p>
        </div>
      </div>

      {/* 工作台模型排序 */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="mb-1 flex items-center gap-2">
          <ArrowDownWideNarrow className="h-4 w-4 text-emerald-400" />
          <h2 className="text-sm font-medium text-zinc-100">工作台模型排序</h2>
        </div>
        <p className="mb-4 text-xs text-zinc-500">
          控制工作台底部生成栏「模型」下拉里，各模型的排列顺序。
        </p>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-xs text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> 正在加载配置…
          </div>
        ) : (
          <div className="space-y-2">
            {SORT_OPTIONS.map((opt) => {
              const active = sortMode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setSortMode(opt.value)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-all duration-200',
                    active
                      ? 'border-emerald-500/60 bg-emerald-500/10'
                      : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-800/40'
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                      active ? 'border-emerald-400' : 'border-zinc-600'
                    )}
                  >
                    {active && <span className="h-2 w-2 rounded-full bg-emerald-400" />}
                  </span>
                  <span className="flex-1">
                    <span className={cn('block text-sm', active ? 'text-emerald-300 font-medium' : 'text-zinc-200')}>
                      {opt.label}
                    </span>
                    <span className="mt-0.5 block text-xs text-zinc-500">{opt.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* 保存栏 */}
        <div className="mt-5 flex items-center justify-between border-t border-zinc-800 pt-4">
          <span className="text-xs text-zinc-500">
            {dirty ? '有未保存的修改' : '已保存'}
          </span>
          <button
            type="button"
            disabled={loading || saving || !dirty}
            onClick={handleSave}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium transition-all duration-200',
              loading || saving || !dirty
                ? 'cursor-not-allowed bg-zinc-800 text-zinc-500'
                : 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400'
            )}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            保存设置
          </button>
        </div>
      </section>

      {/* 生成限流（应用层，按客户端 IP） */}
      <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="mb-1 flex items-center gap-2">
          <Gauge className="h-4 w-4 text-emerald-400" />
          <h2 className="text-sm font-medium text-zinc-100">生成限流</h2>
        </div>
        <p className="mb-4 text-xs text-zinc-500">
          限制同一客户端 IP 在指定时间窗口内可提交的最大生成次数，用于防止刷爆供应商配额或积分滥用。
          后端读取此配置后立即生效（30 秒内缓存同步）。
        </p>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* 每窗口最大次数 */}
          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-300">
              <Gauge className="h-3.5 w-3.5 text-zinc-500" />
              每窗口最大次数
            </label>
            <input
              type="number"
              min={1}
              max={1000}
              value={genLimit}
              disabled={loading}
              onChange={(e) => {
                const v = Math.max(1, Math.min(1000, Math.floor(Number(e.target.value) || 1)));
                setGenLimit(v);
              }}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/60"
            />
            <p className="mt-1 text-[11px] text-zinc-600">取值范围 1 – 1000，默认 30</p>
          </div>

          {/* 时间窗口（秒） */}
          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-300">
              <Clock className="h-3.5 w-3.5 text-zinc-500" />
              时间窗口（秒）
            </label>
            <input
              type="number"
              min={10}
              max={3600}
              value={genWindow}
              disabled={loading}
              onChange={(e) => {
                const v = Math.max(10, Math.min(3600, Math.floor(Number(e.target.value) || 60)));
                setGenWindow(v);
              }}
              className="w-full rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/60"
            />
            <p className="mt-1 text-[11px] text-zinc-600">取值范围 10 – 3600，默认 60</p>
          </div>
        </div>

        <div className="mt-3 rounded-lg border border-zinc-800/80 bg-zinc-950/40 px-3 py-2 text-[11px] text-zinc-500">
          等效规则：同一 IP 每 <span className="text-zinc-300">{genWindow}</span> 秒最多提交{' '}
          <span className="text-zinc-300">{genLimit}</span> 次生成。超过后返回「生成请求过于频繁」，需等待窗口重置。
        </div>
      </section>

      {/* 全局生成并发数（maxThreads） */}
      <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="mb-1 flex items-center gap-2">
          <Gauge className="h-4 w-4 text-emerald-400" />
          <h2 className="text-sm font-medium text-zinc-100">全局生成并发数</h2>
        </div>
        <p className="mb-4 text-xs text-zinc-500">
          控制调度器同时进行的生成任务数量上限。数值越大吞吐越高；供应商侧的每密钥/每账号限流会自动兜底，放宽此处不会被上游冲垮。修改后立即生效，无需重启。
        </p>
        <div>
          <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-300">
            <Gauge className="h-3.5 w-3.5 text-zinc-500" />
            最大并发任务数（maxThreads）
          </label>
          <input
            type="number"
            min={1}
            max={1000}
            value={maxThreads}
            disabled={loading}
            onChange={(e) => {
              const v = Math.max(1, Math.min(1000, Math.floor(Number(e.target.value) || 1)));
              setMaxThreads(v);
            }}
            className="w-full rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/60"
          />
          <p className="mt-1 text-[11px] text-zinc-600">取值范围 1 – 1000，默认 10。当前生效值会预填于此。</p>
        </div>
      </section>
    </div>
  );
}
