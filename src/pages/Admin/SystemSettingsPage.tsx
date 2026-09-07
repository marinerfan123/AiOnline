// 后台「系统设置」：平台级配置聚合。
// 承载：工作台模型排序、生成限流、全局生成并发、单服务商聚合并发硬顶、
// ffmpeg 并发、上传 finalize 并发、媒体最终化模式、媒体归一化运行位置。
// 存储：settings 表 key='app' 的 value JSON；后端 PUT /api/settings 合并写入（局部保存不覆盖其它配置）。
import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Settings2, Save, Loader2, ArrowDownWideNarrow, Gauge, Clock, Cpu, Layers, Server, Waypoints, Image } from 'lucide-react';
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
function toInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

type FinalizeMode = 'buffer' | 'stream';
type Placement = 'api' | 'worker' | 'off';

const FINALIZE_OPTIONS: { value: FinalizeMode; label: string; desc: string }[] = [
  { value: 'buffer', label: '整文件缓冲 + MD5 校验', desc: '上传前整文件读入内存计算 MD5 做完整性校验。内存/CPU 占用高，数据最稳。' },
  { value: 'stream', label: '纯流式直传', desc: '边下边传，不整文件缓冲、不计算 MD5。省内存/CPU，牺牲上传 MD5 校验；适合大批量、大文件。' },
];

const PLACEMENT_OPTIONS: { value: Placement; label: string; desc: string }[] = [
  { value: 'api', label: 'API 进程内（默认）', desc: 'ffmpeg 归一化与 HTTP 同进程，与前台请求抢 CPU。' },
  { value: 'worker', label: '独立 media-worker 进程', desc: '归一化挪到独立进程/容器，与 HTTP 隔离。需在部署侧启动 media-worker 服务，可随时切回。' },
  { value: 'off', label: '关闭', desc: '完全关闭媒体归一化（探针/缩略图/转码），仅保留原始上传。' },
];

export default function SystemSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // 工作台模型排序
  const [sortMode, setSortMode] = useState<ModelSortMode>('manual');
  const [loadedSort, setLoadedSort] = useState<ModelSortMode>('manual');

  // 生成限流（按客户端 IP）
  const [genLimit, setGenLimit] = useState(30);
  const [genWindow, setGenWindow] = useState(60);

  // 全局生成并发数
  const [maxThreads, setMaxThreads] = useState(10);

  // 单服务商聚合并发硬顶
  const [aggCap, setAggCap] = useState(24);

  // ffmpeg/ffprobe 并发
  const [ffmpegConc, setFfmpegConc] = useState(2);

  // 上传 finalize 并发
  const [finalizeConc, setFinalizeConc] = useState(4);

  // 媒体最终化模式
  const [finalizeMode, setFinalizeMode] = useState<FinalizeMode>('buffer');

  // 媒体归一化位置
  const [placement, setPlacement] = useState<Placement>('api');

  // 已加载基线（用于 dirty 判定）
  const [loaded, setLoaded] = useState<Record<string, unknown>>({});

  const snapshot = (): Record<string, unknown> => ({
    workspaceModelSort: sortMode,
    genRateLimit: { limit: genLimit, windowSec: genWindow },
    maxThreads,
    providerAggregateConcCap: aggCap,
    ffmpegConcurrency: ffmpegConc,
    uploadFinalizeConcurrency: finalizeConc,
    mediaFinalizeMode: finalizeMode,
    mediaNormalizationPlacement: placement,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = (await apiGetSettings().catch(() => ({}))) || {};
        if (cancelled) return;
        const m = normalizeSort(s.workspaceModelSort);
        setSortMode(m);
        const rl = (s.genRateLimit && typeof s.genRateLimit === 'object') ? s.genRateLimit : {};
        const lim = toInt(rl.limit, 30, 1, 1000);
        const win = toInt(rl.windowSec, 60, 10, 3600);
        setGenLimit(lim);
        setGenWindow(win);
        setMaxThreads(toInt(s.maxThreads, 10, 1, 1000));
        setAggCap(toInt(s.providerAggregateConcCap, 24, 1, 1000));
        setFfmpegConc(toInt(s.ffmpegConcurrency, 2, 1, 16));
        setFinalizeConc(toInt(s.uploadFinalizeConcurrency, 4, 1, 32));
        setFinalizeMode(s.mediaFinalizeMode === 'stream' ? 'stream' : 'buffer');
        setPlacement(['api', 'worker', 'off'].includes(s.mediaNormalizationPlacement) ? s.mediaNormalizationPlacement : 'api');
        setLoaded({ ...s, workspaceModelSort: m, genRateLimit: { limit: lim, windowSec: win }, maxThreads: toInt(s.maxThreads, 10, 1, 1000), providerAggregateConcCap: toInt(s.providerAggregateConcCap, 24, 1, 1000), ffmpegConcurrency: toInt(s.ffmpegConcurrency, 2, 1, 16), uploadFinalizeConcurrency: toInt(s.uploadFinalizeConcurrency, 4, 1, 32), mediaFinalizeMode: s.mediaFinalizeMode === 'stream' ? 'stream' : 'buffer', mediaNormalizationPlacement: ['api', 'worker', 'off'].includes(s.mediaNormalizationPlacement) ? s.mediaNormalizationPlacement : 'api' });
      } catch {
        // 读不到配置不阻断
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const dirty = JSON.stringify(snapshot()) !== JSON.stringify({
    workspaceModelSort: loaded.workspaceModelSort,
    genRateLimit: { limit: (loaded.genRateLimit as { limit?: number })?.limit ?? 30, windowSec: (loaded.genRateLimit as { windowSec?: number })?.windowSec ?? 60 },
    maxThreads: loaded.maxThreads ?? 10,
    providerAggregateConcCap: loaded.providerAggregateConcCap ?? 24,
    ffmpegConcurrency: loaded.ffmpegConcurrency ?? 2,
    uploadFinalizeConcurrency: loaded.uploadFinalizeConcurrency ?? 4,
    mediaFinalizeMode: loaded.mediaFinalizeMode ?? 'buffer',
    mediaNormalizationPlacement: loaded.mediaNormalizationPlacement ?? 'api',
  });

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const cur = (await apiGetSettings().catch(() => ({}))) || {};
      const next = snapshot();
      await apiSaveSettings({ ...cur, ...next });
      setLoaded({ ...loaded, ...next });
      setLoadedSort(sortMode);
      toast.success('已保存系统设置');
    } catch (e) {
      toast.error('保存失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  }, [snapshot, loaded, sortMode]);

  const numInput = (value: number, set: (n: number) => void, min: number, max: number) => (
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      disabled={loading}
      onChange={(e) => set(Math.max(min, Math.min(max, Math.floor(Number(e.target.value) || min))))}
      className="w-full rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500/60"
    />
  );

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      {/* 页头 */}
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-800/70">
          <Settings2 className="h-5 w-5 text-emerald-400" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">系统设置</h1>
          <p className="text-xs text-zinc-500">平台级配置聚合，影响前台工作台与生成体验。保存后 30 秒内生效，无需重启（归一化位置需重启/部署生效）。</p>
        </div>
      </div>

      {/* 工作台模型排序 */}
      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="mb-1 flex items-center gap-2">
          <ArrowDownWideNarrow className="h-4 w-4 text-emerald-400" />
          <h2 className="text-sm font-medium text-zinc-100">工作台模型排序</h2>
        </div>
        <p className="mb-4 text-xs text-zinc-500">控制工作台底部生成栏「模型」下拉里，各模型的排列顺序。</p>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-xs text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> 正在加载配置…</div>
        ) : (
          <div className="space-y-2">
            {SORT_OPTIONS.map((opt) => {
              const active = sortMode === opt.value;
              return (
                <button key={opt.value} type="button" onClick={() => setSortMode(opt.value)}
                  className={cn('flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-all duration-200',
                    active ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-800/40')}>
                  <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', active ? 'border-emerald-400' : 'border-zinc-600')}>
                    {active && <span className="h-2 w-2 rounded-full bg-emerald-400" />}
                  </span>
                  <span className="flex-1">
                    <span className={cn('block text-sm', active ? 'text-emerald-300 font-medium' : 'text-zinc-200')}>{opt.label}</span>
                    <span className="mt-0.5 block text-xs text-zinc-500">{opt.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* 生成限流 */}
      <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="mb-1 flex items-center gap-2"><Gauge className="h-4 w-4 text-emerald-400" /><h2 className="text-sm font-medium text-zinc-100">生成限流</h2></div>
        <p className="mb-4 text-xs text-zinc-500">限制同一客户端 IP 在指定时间窗口内可提交的最大生成次数，防止刷爆供应商配额或积分滥用。后端读取后 30 秒内缓存同步生效。</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-300"><Gauge className="h-3.5 w-3.5 text-zinc-500" />每窗口最大次数</label>
            {numInput(genLimit, setGenLimit, 1, 1000)}
            <p className="mt-1 text-[11px] text-zinc-600">取值范围 1 – 1000，默认 30</p>
          </div>
          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-300"><Clock className="h-3.5 w-3.5 text-zinc-500" />时间窗口（秒）</label>
            {numInput(genWindow, setGenWindow, 10, 3600)}
            <p className="mt-1 text-[11px] text-zinc-600">取值范围 10 – 3600，默认 60</p>
          </div>
        </div>
        <div className="mt-3 rounded-lg border border-zinc-800/80 bg-zinc-950/40 px-3 py-2 text-[11px] text-zinc-500">
          等效规则：同一 IP 每 <span className="text-zinc-300">{genWindow}</span> 秒最多提交 <span className="text-zinc-300">{genLimit}</span> 次生成。超过返回「生成请求过于频繁」。
        </div>
      </section>

      {/* 全局生成并发数 */}
      <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="mb-1 flex items-center gap-2"><Gauge className="h-4 w-4 text-emerald-400" /><h2 className="text-sm font-medium text-zinc-100">全局生成并发数</h2></div>
        <p className="mb-4 text-xs text-zinc-500">
          <span className="text-zinc-300">功能：</span>调度器同时进行的生成任务数量上限。<br />
          <span className="text-zinc-300">作用：</span>这是全局总闸。数值过大（如 1000）会失去保护，一次批量即可堆数百并发、连带 finalize/ffmpeg 打满 CPU 导致「卡前后台甚至宕机」。2 核机器建议 ≤16。修改后立即生效。
        </p>
        <div>
          <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-300"><Gauge className="h-3.5 w-3.5 text-zinc-500" />最大并发任务数（maxThreads）</label>
          {numInput(maxThreads, setMaxThreads, 1, 1000)}
          <p className="mt-1 text-[11px] text-zinc-600">取值范围 1 – 1000，默认 10</p>
        </div>
      </section>

      {/* 单服务商聚合并发硬顶 */}
      <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="mb-1 flex items-center gap-2"><Waypoints className="h-4 w-4 text-emerald-400" /><h2 className="text-sm font-medium text-zinc-100">单服务商聚合并发硬顶</h2></div>
        <p className="mb-4 text-xs text-zinc-500">
          <span className="text-zinc-300">功能：</span>限制单个服务商（如 agnes）同一时刻可同时进行的生成请求总数。<br />
          <span className="text-zinc-300">作用：</span>多 key 服务商总并发按「每 key 并发 × key 数」线性放大，476 把 key 会放大到 ~950 并发，一次批量就能把同一服务商打爆、并连带 finalize/ffmpeg 打满 CPU。此硬顶钳制该放大，是「量大不宕机」的关键闸。调大提吞吐、调小更稳。
        </p>
        <div>
          <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-300"><Waypoints className="h-3.5 w-3.5 text-zinc-500" />服务商聚合并发上限</label>
          {numInput(aggCap, setAggCap, 1, 1000)}
          <p className="mt-1 text-[11px] text-zinc-600">取值范围 1 – 1000，默认 24</p>
        </div>
      </section>

      {/* ffmpeg 并发 */}
      <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="mb-1 flex items-center gap-2"><Cpu className="h-4 w-4 text-emerald-400" /><h2 className="text-sm font-medium text-zinc-100">ffmpeg / ffprobe 并发数</h2></div>
        <p className="mb-4 text-xs text-zinc-500">
          <span className="text-zinc-300">功能：</span>媒体归一化（探针 / 缩略图 / 转码 / 波形）同时运行的 ffmpeg/ffprobe 子进程上限。<br />
          <span className="text-zinc-300">作用：</span>ffmpeg 是 CPU 密集，并发过高会占满 CPU、饿死 HTTP/SSE（「卡前后台」根因之一）。2 核机器建议 ≤2。修改后 30 秒内生效。
        </p>
        <div>
          <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-300"><Cpu className="h-3.5 w-3.5 text-zinc-500" />ffmpeg 并发上限</label>
          {numInput(ffmpegConc, setFfmpegConc, 1, 16)}
          <p className="mt-1 text-[11px] text-zinc-600">取值范围 1 – 16，默认 2</p>
        </div>
      </section>

      {/* 上传 finalize 并发 */}
      <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="mb-1 flex items-center gap-2"><Layers className="h-4 w-4 text-emerald-400" /><h2 className="text-sm font-medium text-zinc-100">上传最终化并发数</h2></div>
        <p className="mb-4 text-xs text-zinc-500">
          <span className="text-zinc-300">功能：</span>生成产物「拉取 → 校验 → 上传 OSS」这一最终化步骤的同时处理数。<br />
          <span className="text-zinc-300">作用：</span>此步骤会把文件读入内存算 MD5/哈希，并发越高越吃内存与 CPU。调低更稳、调高更快。修改后 30 秒内生效。
        </p>
        <div>
          <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-zinc-300"><Layers className="h-3.5 w-3.5 text-zinc-500" />finalize 并发上限</label>
          {numInput(finalizeConc, setFinalizeConc, 1, 32)}
          <p className="mt-1 text-[11px] text-zinc-600">取值范围 1 – 32，默认 4</p>
        </div>
      </section>

      {/* 媒体最终化模式 */}
      <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="mb-1 flex items-center gap-2"><Image className="h-4 w-4 text-emerald-400" /><h2 className="text-sm font-medium text-zinc-100">媒体最终化模式</h2></div>
        <p className="mb-4 text-xs text-zinc-500">
          <span className="text-zinc-300">功能：</span>产物上传 OSS 前是否整文件缓冲计算 MD5。<br />
          <span className="text-zinc-300">作用：</span>「整文件缓冲」带 MD5 完整性校验但吃内存/CPU；「纯流式」省内存/CPU、牺牲 MD5 校验。客户可按批量和文件大小自行切换，修改后 30 秒内生效。
        </p>
        <div className="space-y-2">
          {FINALIZE_OPTIONS.map((opt) => {
            const active = finalizeMode === opt.value;
            return (
              <button key={opt.value} type="button" onClick={() => setFinalizeMode(opt.value)}
                className={cn('flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-all duration-200',
                  active ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-800/40')}>
                <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', active ? 'border-emerald-400' : 'border-zinc-600')}>
                  {active && <span className="h-2 w-2 rounded-full bg-emerald-400" />}
                </span>
                <span className="flex-1">
                  <span className={cn('block text-sm', active ? 'text-emerald-300 font-medium' : 'text-zinc-200')}>{opt.label}</span>
                  <span className="mt-0.5 block text-xs text-zinc-500">{opt.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* 媒体归一化运行位置 */}
      <section className="mt-6 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="mb-1 flex items-center gap-2"><Server className="h-4 w-4 text-emerald-400" /><h2 className="text-sm font-medium text-zinc-100">媒体归一化运行位置</h2></div>
        <p className="mb-4 text-xs text-zinc-500">
          <span className="text-zinc-300">功能：</span>决定 ffmpeg 归一化 worker 跑在哪个进程/容器。<br />
          <span className="text-zinc-300">作用：</span>默认在 API 进程内（与 HTTP 抢 CPU）；可切到独立 media-worker 进程隔离 CPU（需部署侧启动对应容器），或关闭归一化。此设置需重启进程/部署后生效。
        </p>
        <div className="space-y-2">
          {PLACEMENT_OPTIONS.map((opt) => {
            const active = placement === opt.value;
            return (
              <button key={opt.value} type="button" onClick={() => setPlacement(opt.value)}
                className={cn('flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-all duration-200',
                  active ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-800/40')}>
                <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', active ? 'border-emerald-400' : 'border-zinc-600')}>
                  {active && <span className="h-2 w-2 rounded-full bg-emerald-400" />}
                </span>
                <span className="flex-1">
                  <span className={cn('block text-sm', active ? 'text-emerald-300 font-medium' : 'text-zinc-200')}>{opt.label}</span>
                  <span className="mt-0.5 block text-xs text-zinc-500">{opt.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* 保存栏 */}
      <div className="mt-6 flex items-center justify-between rounded-2xl border border-zinc-800 bg-zinc-900/40 p-5">
        <span className="text-xs text-zinc-500">{dirty ? '有未保存的修改' : '已保存'}</span>
        <button type="button" disabled={loading || saving || !dirty} onClick={handleSave}
          className={cn('flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-medium transition-all duration-200',
            loading || saving || !dirty ? 'cursor-not-allowed bg-zinc-800 text-zinc-500' : 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400')}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          保存设置
        </button>
      </div>
    </div>
  );
}
