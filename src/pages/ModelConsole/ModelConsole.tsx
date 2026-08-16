import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { apiGetModels, apiGenerate, apiGetGenerationStatus, apiSaveMedia } from '../../services/api';
import { getEffectiveModelName, type IAiModel, type IModelParamTemplate } from '../../data/models';
import { useOssConfig } from '@/hooks/useOssConfig';
import { formatCredits } from '@/utils/format';

type ModelRow = IAiModel & {
  paramTemplate?: IModelParamTemplate & {
    meta?: {
      pricing?: string;
      officialDoc?: string | null;
      verified?: boolean;
      region?: string;
      access?: string;
      async?: boolean;
      openaiCompatible?: boolean;
      sourceDefaults?: Record<string, unknown>;
      notes?: string;
    };
  };
  endpoint?: {
    protocol?: string;
    async?: boolean;
    region?: string;
    access?: string;
    notes?: string;
    officialDoc?: string | null;
  };
};

const TYPE_LABEL: Record<string, string> = { image: '图像', video: '视频', text: '文本' };
const TYPE_ORDER = ['image', 'video', 'text'];

interface FormState {
  prompt: string;
  negative: string;
  quality: string;
  ratio: string;
  resolution: string;
  duration: number;
  count: number;
  videoMode: 't2v' | 'i2v_first' | 'reference_image';
  referenceUrls: string;
}

function initialForm(tpl: IModelParamTemplate | undefined, type: string): FormState {
  const d = tpl?.defaults || {};
  return {
    prompt: '',
    negative: '',
    quality: d.quality || (tpl?.qualities && tpl.qualities[0]) || 'standard',
    ratio: d.ratio || (tpl?.ratios && tpl.ratios[0]) || '1:1',
    resolution:
      type === 'video'
        ? (tpl?.videoResolutions && tpl.videoResolutions[0]) || '720p'
        : (tpl?.resolutions && tpl.resolutions[0]) || '1k',
    duration: d.duration || (tpl?.durations && tpl.durations[0]) || 8,
    count: 1,
    videoMode: 't2v',
    referenceUrls: '',
  };
}

export default function ModelConsole() {
  const navigate = useNavigate();
  const [models, setModels] = useState<ModelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [selectedId, setSelectedId] = useState<string>('');
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [taskId, setTaskId] = useState('');
  const [pollStatus, setPollStatus] = useState('');
  const [result, setResult] = useState<{ images: string[] } | null>(null);
  const [runError, setRunError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const list = (await apiGetModels()) as ModelRow[];
      setModels(list || []);
      const firstEnabled = (list || []).find((m) => m.enabled);
      const first = firstEnabled || (list || [])[0];
      if (first) {
        setSelectedId(first.id);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleModels = useMemo(
    () => (showAll ? models : models.filter((m) => m.enabled)),
    [models, showAll],
  );

  const grouped = useMemo(() => {
    const g: Record<string, ModelRow[]> = { image: [], video: [], text: [] };
    for (const m of visibleModels) {
      const t = m.type || 'image';
      (g[t] || (g[t] = [])).push(m);
    }
    return g;
  }, [visibleModels]);

  const selected = useMemo(
    () => models.find((m) => m.id === selectedId) || null,
    [models, selectedId],
  );

  // 切换模型时重置表单（用该模型的 param_template 派生默认值）
  useEffect(() => {
    if (selected) setForm(initialForm(selected.paramTemplate as IModelParamTemplate | undefined, selected.type));
    setResult(null);
    setRunError('');
    setPollStatus('');
    setTaskId('');
  }, [selected]);

  const tpl = selected?.paramTemplate as IModelParamTemplate | undefined;
  const isVideo = selected?.type === 'video';
  const isText = selected?.type === 'text';

  // OSS 后端接管上传：开启后浏览器把来源交给后端，后端拉字节 + PUT 到 OSS，链接变成永久 https 地址
  const { config: ossConfig, ingestFile } = useOssConfig();

  // 生成结果落库：开启 OSS 则先上传拿永久地址，再写 media；关闭则保留原始链接（data URI / 服务商临时 URL）
  const persistResults = useCallback(
    async (imgs: string[], prompt: string, modelName: string): Promise<string[]> => {
      const saved: any[] = [];
      const out: string[] = [];
      for (let i = 0; i < imgs.length; i++) {
        const src = imgs[i];
        let persistentUrl = src;
        let ossUrl = '';
        let ossObjectKey = '';
        let ossUploaded = false;
        try {
          if (ossConfig.enabled && (src.startsWith('data:') || src.startsWith('http'))) {
            let file: File;
            if (src.startsWith('data:')) {
              const [meta, b64] = src.split(',');
              const mimeMatch = meta.match(/data:([^;]*);base64/);
              const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
              const byteChars = atob(b64);
              const arr = new Uint8Array(byteChars.length);
              for (let k = 0; k < byteChars.length; k++) arr[k] = byteChars.charCodeAt(k);
              file = new File([arr], `mc-${Date.now()}-${i}.jpg`, { type: mime });
            } else {
              const r = await fetch(src);
              file = new File([await r.blob()], `mc-${Date.now()}-${i}.jpg`, { type: 'image/jpeg' });
            }
            const up = await ingestFile(file, `mc-${Date.now()}-${i}.jpg`);
            if (up.success && up.url) {
              persistentUrl = up.url;
              ossUrl = up.url;
              ossObjectKey = up.objectKey;
              ossUploaded = true;
            }
          }
        } catch {
          /* 上传失败保留原始链接 */
        }
        out.push(persistentUrl);
        saved.push({
          id: `mc-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
          title: prompt.slice(0, 20) || '控制台生成',
          type: isVideo ? 'video' : 'image',
          thumbnail: persistentUrl,
          fullUrl: persistentUrl,
          prompt,
          model: modelName,
          ratio: form?.ratio || '1:1',
          source: 'user',
          ossUrl,
          ossObjectKey,
          ossUploaded,
          createdAt: new Date().toISOString(),
        });
      }
      if (saved.length) {
        try { await apiSaveMedia(saved); } catch { /* 落库失败不阻塞前端展示 */ }
      }
      return out;
    },
    [ossConfig, ingestFile, isVideo, form],
  );

  const update = (patch: Partial<FormState>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const refArray = useMemo(
    () => (form ? form.referenceUrls.split('\n').map((s) => s.trim()).filter(Boolean) : []),
    [form],
  );

  const canGenerate =
    !!form && !!selected && !isText && form.prompt.trim().length > 0 && !busy;

  const run = useCallback(async () => {
    if (!selected || !form || isText) return;
    if (form.prompt.trim().length === 0) {
      toast.error('请填写提示词');
      return;
    }
    setBusy(true);
    setRunError('');
    setResult(null);
    setPollStatus('提交中…');
    let key = 'idem-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    try {
      const cryptoObj = (globalThis as any).crypto;
      if (cryptoObj?.randomUUID) key = cryptoObj.randomUUID();
    } catch {}
    try {
      const resp = await apiGenerate({
        model: selected.id,
        prompt: form.prompt.trim(),
        ratio: form.ratio,
        resolution: form.resolution,
        quality: form.quality as 'low' | 'standard' | 'high',
        count: isVideo ? 1 : form.count,
        contentType: isVideo ? 'video' : 'image',
        referenceImages: selected.paramTemplate?.supportsReference && refArray.length ? refArray : undefined,
        negative: form.negative.trim() || undefined,
        duration: isVideo ? form.duration : undefined,
        videoMode: isVideo ? form.videoMode : undefined,
        idempotencyKey: key,
      });

      if (resp.status === 'failed') {
        setRunError(resp.error || '生成失败');
        setPollStatus('');
        setBusy(false);
        return;
      }
      if ('taskId' in resp && resp.taskId && resp.status === 'pending') {
        setTaskId(resp.taskId);
        await poll(resp.taskId);
        return;
      }
      // 老同步通道
      const imgs = (resp as { images?: string[] }).images || [];
      if (imgs.length) {
        const urls = await persistResults(imgs, form.prompt.trim(), getEffectiveModelName(selected));
        setResult({ images: urls });
        setPollStatus('完成');
      } else {
        setRunError((resp as { error?: string }).error || '生成失败：服务商返回异常');
      }
      setBusy(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setRunError(msg.slice(0, 300));
      setPollStatus('');
      setBusy(false);
    }
  }, [selected, form, isVideo, isText, refArray, persistResults]);

  const poll = useCallback(
    async (tid: string) => {
      const max = 120;
      for (let i = 0; i < max; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const st = await apiGetGenerationStatus(tid);
        if (st.status === 'done') {
          const imgs = st.result?.images || [];
          const urls = await persistResults(imgs, form.prompt.trim(), getEffectiveModelName(selected));
          setResult({ images: urls });
          setPollStatus('完成');
          setBusy(false);
          return;
        }
        if (st.status === 'failed' || st.status === 'not_found') {
          setRunError(st.error || '生成失败');
          setPollStatus('');
          setBusy(false);
          return;
        }
        setPollStatus(`生成中…（${(i + 1) * 1.5}s）`);
      }
      setRunError('轮询超时，请稍后在任务列表查看');
      setBusy(false);
    },
    [persistResults, form, selected],
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">模型控制台</h1>
          <p className="mt-1 text-sm text-white/50">
            后端配置的模型自动在此渲染参数表单，可直接发起生成。共 {models.length} 个模型（图像 {grouped.image.length} · 视频 {grouped.video.length} · 文本 {grouped.text.length}）
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-white/60">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            显示已停用
          </label>
          <button
            onClick={load}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white/80 hover:bg-white/10"
          >
            刷新列表
          </button>
        </div>
      </div>

      {loading && <div className="rounded-xl border border-white/10 bg-white/5 p-8 text-center text-white/60">加载模型中…</div>}
      {loadError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">加载失败：{loadError}</div>
      )}

      {!loading && !loadError && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_1fr]">
          {/* 左：模型列表 */}
          <aside className="space-y-4">
            {TYPE_ORDER.map((t) =>
              grouped[t]?.length ? (
                <div key={t}>
                  <div className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-white/40">{TYPE_LABEL[t]}</div>
                  <div className="space-y-1.5">
                    {grouped[t].map((m) => {
                      const meta = (m.paramTemplate as any)?.meta;
                      const active = m.id === selectedId;
                      return (
                        <button
                          key={m.id}
                          onClick={() => setSelectedId(m.id)}
                          className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition ${
                            active
                              ? 'border-indigo-400/50 bg-indigo-500/15 text-white'
                              : 'border-white/10 bg-white/5 text-white/80 hover:bg-white/10'
                          }`}
                        >
                          <span className="truncate text-sm font-medium">{getEffectiveModelName(m)}</span>
                          <span className="ml-2 flex shrink-0 items-center gap-1">
                            {meta?.verified === false && (
                              <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">未核实</span>
                            )}
                            {!m.enabled && <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/50">停用</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null,
            )}
          </aside>

          {/* 右：模型详情 + 表单 */}
          <section>
            {!selected && <div className="rounded-xl border border-white/10 bg-white/5 p-8 text-center text-white/60">请选择一个模型</div>}
            {selected && (
              <div className="space-y-5">
                {/* 头部信息卡 */}
                <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-xl font-semibold text-white">{getEffectiveModelName(selected)}</h2>
                        <span className="rounded bg-white/10 px-2 py-0.5 text-xs text-white/60">{TYPE_LABEL[selected.type]}</span>
                        {selected.creator?.name && (
                          <span className="rounded bg-white/10 px-2 py-0.5 text-xs text-white/60">{selected.creator.name}</span>
                        )}
                      </div>
                      <div className="mt-1 text-sm text-white/50">
                        {selected.endpoint?.region === 'overseas' ? '海外' : selected.endpoint?.region === 'domestic' ? '国内' : selected.endpoint?.region || ''}
                        {selected.endpoint?.protocol && ` · ${selected.endpoint.protocol}`}
                        {selected.endpoint?.async ? ' · 异步' : ' · 同步'}
                      </div>
                    </div>
                    {(selected.paramTemplate as any)?.meta?.officialDoc && (
                      <a
                        href={(selected.paramTemplate as any).meta.officialDoc}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-indigo-300 hover:bg-white/10"
                      >
                        官方文档 ↗
                      </a>
                    )}
                  </div>
                  {(selected.paramTemplate as any)?.meta?.pricing && (
                    <div className="mt-3 rounded-lg bg-black/20 px-3 py-2 text-xs text-white/60">
                      计费参考：{(selected.paramTemplate as any).meta.pricing}
                    </div>
                  )}
                  {selected.creditCost ? (
                    <div className="mt-2 text-xs text-white/50">单次消耗积分：{formatCredits(selected.creditCost)}</div>
                  ) : (
                    <div className="mt-2 text-xs text-white/40">单次积分：未设置（后台 ModelHub 可配置）</div>
                  )}
                </div>

                {/* 文本模型：仅展示能力，引导到对话/智能体 */}
                {isText && (
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-center">
                    <p className="text-white/70">文本模型用于对话 / 智能体推理，不在本控制台直接生成图像或视频。</p>
                    <div className="mt-3 flex justify-center gap-3">
                      <button
                        onClick={() => navigate('/workspace')}
                        className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm text-white/80 hover:bg-white/10"
                      >
                        去工作台
                      </button>
                    </div>
                    {(selected.paramTemplate as any)?.meta?.notes && (
                      <p className="mt-4 whitespace-pre-wrap text-left text-xs leading-relaxed text-white/40">
                        {(selected.paramTemplate as any).meta.notes}
                      </p>
                    )}
                  </div>
                )}

                {/* 图像 / 视频：动态参数表单 */}
                {!isText && tpl && form && (
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-5 backdrop-blur">
                    <div className="space-y-4">
                      <div>
                        <label className="mb-1 block text-sm font-medium text-white/80">提示词 *</label>
                        <textarea
                          value={form.prompt}
                          onChange={(e) => update({ prompt: e.target.value })}
                          rows={3}
                          placeholder="描述你想生成的内容…"
                          className="w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-indigo-400/50"
                        />
                      </div>

                      {tpl.supportsNegative && (
                        <div>
                          <label className="mb-1 block text-sm font-medium text-white/80">反向提示词</label>
                          <input
                            value={form.negative}
                            onChange={(e) => update({ negative: e.target.value })}
                            placeholder="不希望出现的内容（可选）"
                            className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-indigo-400/50"
                          />
                        </div>
                      )}

                      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
                        {tpl.qualities && tpl.qualities.length > 0 && (
                          <Field label="质量">
                            <Select value={form.quality} onChange={(v) => update({ quality: v })} options={tpl.qualities.map((q) => ({ v: q, l: q }))} />
                          </Field>
                        )}
                        {tpl.ratios && tpl.ratios.length > 0 && (
                          <Field label="比例">
                            <Select value={form.ratio} onChange={(v) => update({ ratio: v })} options={tpl.ratios.map((r) => ({ v: r, l: r }))} />
                          </Field>
                        )}
                        {isVideo
                          ? tpl.videoResolutions && tpl.videoResolutions.length > 0 && (
                              <Field label="分辨率">
                                <Select
                                  value={form.resolution}
                                  onChange={(v) => update({ resolution: v })}
                                  options={tpl.videoResolutions.map((r) => ({ v: r, l: r }))}
                                />
                              </Field>
                            )
                          : tpl.resolutions && tpl.resolutions.length > 0 && (
                              <Field label="分辨率">
                                <Select
                                  value={form.resolution}
                                  onChange={(v) => update({ resolution: v })}
                                  options={tpl.resolutions.map((r) => ({ v: r, l: r.toUpperCase() }))}
                                />
                              </Field>
                            )}
                        {isVideo && tpl.durations && tpl.durations.length > 0 && (
                          <Field label="时长(秒)">
                            <Select
                              value={String(form.duration)}
                              onChange={(v) => update({ duration: Number(v) })}
                              options={tpl.durations.map((d) => ({ v: String(d), l: String(d) }))}
                            />
                          </Field>
                        )}
                        {!isVideo && tpl.allowCount && (
                          <Field label="数量">
                            <Select
                              value={String(form.count)}
                              onChange={(v) => update({ count: Number(v) })}
                              options={[1, 2, 3, 4].map((n) => ({ v: String(n), l: String(n) }))}
                            />
                          </Field>
                        )}
                      </div>

                      {isVideo && tpl.supportsReference && (
                        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                          <Field label="视频模式">
                            <Select
                              value={form.videoMode}
                              onChange={(v) => update({ videoMode: v as FormState['videoMode'] })}
                              options={[
                                { v: 't2v', l: '文生视频' },
                                { v: 'i2v_first', l: '图生视频(首帧)' },
                                { v: 'reference_image', l: '参考图' },
                              ]}
                            />
                          </Field>
                          <Field label="参考图 URL（每行一个）">
                            <textarea
                              value={form.referenceUrls}
                              onChange={(e) => update({ referenceUrls: e.target.value })}
                              rows={2}
                              placeholder="https://… （图生视频/参考图时填写）"
                              className="w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-indigo-400/50"
                            />
                          </Field>
                        </div>
                      )}

                      {!isVideo && tpl.supportsReference && (
                        <Field label="参考图 URL（图生图，每行一个）">
                          <textarea
                            value={form.referenceUrls}
                            onChange={(e) => update({ referenceUrls: e.target.value })}
                            rows={2}
                            placeholder="https://… （可选）"
                            className="w-full resize-y rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-indigo-400/50"
                          />
                        </Field>
                      )}

                      {tpl.rules && tpl.rules.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {tpl.rules.map((r, i) => (
                            <span key={i} className="rounded-full bg-white/5 px-3 py-1 text-xs text-white/50">
                              {r.label}：{r.description}
                            </span>
                          ))}
                        </div>
                      )}

                      <div className="flex items-center gap-3 pt-1">
                        <button
                          onClick={run}
                          disabled={!canGenerate}
                          className="rounded-lg bg-indigo-500 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40"
                        >
                          {busy ? '生成中…' : '生成'}
                        </button>
                        {busy && taskId && <span className="text-sm text-white/60">{pollStatus}</span>}
                        {!busy && pollStatus && <span className="text-sm text-emerald-300">{pollStatus}</span>}
                      </div>

                      {runError && (
                        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                          {runError}
                          <div className="mt-1 text-xs text-red-200/70">
                            提示：若报错含密钥/401/鉴权，请到后台 ModelHub 为该服务商填写 API Key。
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* 结果画廊 */}
                {result && result.images.length > 0 && (
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                    <div className="mb-3 text-sm font-medium text-white/80">生成结果（{result.images.length}）</div>
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                      {result.images.map((src, i) => (
                        <a key={i} href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-white/10">
                          <img src={src} alt={`result-${i}`} className="h-full w-full object-cover" loading="lazy" />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-white/60">{label}</label>
      {children}
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { v: string; l: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ colorScheme: 'dark' }}
      className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-white outline-none focus:border-indigo-400/50"
    >
      {options.map((o) => (
        <option key={o.v} value={o.v} className="bg-zinc-900">
          {o.l}
        </option>
      ))}
    </select>
  );
}
