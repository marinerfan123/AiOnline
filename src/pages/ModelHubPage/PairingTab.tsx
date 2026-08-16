// 配套关系 Tab —— 管理模型间配套：
//   - 视频模型 → 底图/首帧生成模型（图片模型 asFirstFrame）
//   - 推理模型 → 视觉输入模型（多模态模型 vision+asVisionInput）

import { useState, useMemo } from 'react';
import { Link2, Video, Image as ImageIcon, MessageSquare, ArrowRight, X, Plus, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { IModelProvider, IAiModel, ModelType, IModelPaired } from '@/data/models';

interface Props {
  providers: IModelProvider[];
  models: IAiModel[];
  setModels: (updater: (prev: IAiModel[]) => IAiModel[]) => void;
  getProviderName: (id: string) => string;
}

type PairingKind = 'video-baseImage' | 'text-vision';

const KIND_META: Record<PairingKind, { title: string; desc: string; sourceType: ModelType; targetType: ModelType; sourceCap: keyof import('@/data/models').IModelCapabilities; targetCap: keyof import('@/data/models').IModelCapabilities; pairedKey: keyof IModelPaired }> = {
  'video-baseImage': {
    title: '视频 → 底图/首帧',
    desc: '视频生成时自动调用配套图片模型生成首帧图',
    sourceType: 'video',
    targetType: 'image',
    sourceCap: 'imageInput',
    targetCap: 'asFirstFrame',
    pairedKey: 'baseImageModelId',
  },
  'text-vision': {
    title: '推理 → 视觉输入',
    desc: '推理模型收到图片时自动调视觉模型先看图（多模态）',
    sourceType: 'text',
    targetType: 'text',
    sourceCap: 'vision',
    targetCap: 'asVisionInput',
    pairedKey: 'visionModelId',
  },
};

export default function PairingTab({ providers, models, setModels, getProviderName }: Props) {
  const [activeKind, setActiveKind] = useState<PairingKind>('video-baseImage');
  const meta = KIND_META[activeKind];

  // 源模型列表
  const sourceModels = useMemo(
    () => models.filter((m) => m.type === meta.sourceType && m.capabilities?.[meta.sourceCap]),
    [models, meta],
  );
  // 候选目标模型
  const targetModels = useMemo(
    () => models.filter((m) => m.type === meta.targetType && m.capabilities?.[meta.targetCap]),
    [models, meta],
  );

  const setPaired = (sourceId: string, targetId: string | undefined) => {
    setModels((prev) =>
      prev.map((m) =>
        m.id === sourceId
          ? { ...m, paired: { ...(m.paired || {}), [meta.pairedKey]: targetId || undefined } }
          : m,
      ),
    );
    if (targetId) toast.success('配套关系已建立');
    else toast.success('已解除配套');
  };

  return (
    <div className="space-y-6">
      {/* 类型切换 */}
      <div className="flex items-center gap-2">
        {(['video-baseImage', 'text-vision'] as const).map((k) => {
          const Icon = k === 'video-baseImage' ? Video : MessageSquare;
          const m = KIND_META[k];
          return (
            <button
              key={k}
              onClick={() => setActiveKind(k)}
              className={`flex items-center gap-2 rounded-2xl px-4 py-2 text-xs transition-colors ${
                activeKind === k
                  ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                  : 'bg-zinc-900/40 text-zinc-400 border border-zinc-800 hover:text-white'
              }`}
            >
              <Icon className="size-3.5" />
              {m.title}
            </button>
          );
        })}
      </div>

      {/* 顶部说明 */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-400">
          <Link2 className="size-5" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-bold text-white">{meta.title}</div>
          <div className="text-xs text-zinc-500 mt-0.5">{meta.desc}</div>
          <div className="mt-2 text-[10px] text-zinc-600">
            已启用 {meta.sourceCap} 的源模型：<span className="text-emerald-400 font-semibold">{sourceModels.length}</span>
            ；可作为目标的 {meta.targetCap} 模型：<span className="text-emerald-400 font-semibold">{targetModels.length}</span>
          </div>
        </div>
      </div>

      {/* 源模型列表 + 配套 */}
      <div className="space-y-2">
        {sourceModels.length === 0 && (
          <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/30 p-8 text-center">
            <Sparkles className="mx-auto mb-2 size-8 text-zinc-600" />
            <p className="text-sm text-zinc-500">没有可配对的源模型</p>
            <p className="text-[11px] text-zinc-600 mt-1">
              请先在「模型列表」Tab 把模型的「能力」标志打开（imageInput / vision）
            </p>
          </div>
        )}
        {sourceModels.map((source) => {
          const currentTarget = source.paired?.[meta.pairedKey];
          return (
            <div key={source.id} className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-zinc-800 text-zinc-400">
                  {source.type === 'video' && <Video className="size-4" />}
                  {source.type === 'image' && <ImageIcon className="size-4" />}
                  {source.type === 'text' && <MessageSquare className="size-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-bold text-white">{source.displayName}</div>
                  <div className="text-[10px] text-zinc-500">
                    {getProviderName(source.providerId)} · {source.modelId}
                  </div>
                </div>
                <ArrowRight className="size-4 text-zinc-600" />
                {/* 目标选择 */}
                {currentTarget ? (
                  <div className="flex items-center gap-2 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 px-3 py-1.5">
                    <span className="text-xs font-bold text-emerald-400">
                      {targetModels.find((t) => t.id === currentTarget)?.displayName || '已删除'}
                    </span>
                    <button
                      onClick={() => setPaired(source.id, undefined)}
                      className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-emerald-500/20 transition-colors"
                    >
                      <X className="size-3 text-emerald-400" />
                    </button>
                  </div>
                ) : (
                  <select
                    onChange={(e) => e.target.value && setPaired(source.id, e.target.value)}
                    className="rounded-2xl bg-zinc-800/50 px-3 py-1.5 text-xs text-white border border-zinc-700 focus:outline-none focus:border-emerald-500/50"
                    defaultValue=""
                  >
                    <option value="" disabled>选择配套模型...</option>
                    {targetModels.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.displayName}（{getProviderName(t.providerId)}）
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}