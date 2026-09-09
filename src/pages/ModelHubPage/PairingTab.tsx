// 配套关系 Tab —— 管理模型间配套：
//   - 视频模型 → 底图/首帧生成模型（图片模型 asFirstFrame）
//   - 推理模型 → 视觉输入模型（多模态模型 vision+asVisionInput）

import { useState, useMemo } from 'react';
import { Link2, Video, Image as ImageIcon, MessageSquare, ArrowRight, X, Sparkles, AlertTriangle, ListChecks } from 'lucide-react';
import { toast } from 'sonner';
import type { IModelProvider, IAiModel, ModelType, IModelPaired } from '@/data/models';

interface Props {
  providers: IModelProvider[];
  models: IAiModel[];
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

export default function PairingTab({ providers, models, getProviderName }: Props) {
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

  const setPaired = (_sourceId: string, _targetId: string | undefined) => {
    toast.info('模型协作仍是预览功能，尚未接入可持久化的执行链路');
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-3 lg:grid-cols-[1fr_360px]">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/35 p-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-300"><Link2 className="size-4" /></div>
            <div>
              <div className="flex items-center gap-2"><h3 className="text-sm font-bold text-white">模型协作</h3><span className="rounded border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[9px] text-amber-300">实验配置</span></div>
              <p className="mt-1 text-[11px] leading-5 text-zinc-500">为一个模型指定前置辅助模型，例如先生成视频首帧，或先读取图片再交给推理模型。</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-zinc-600"><span>1. 在模型页标记能力</span><span>2. 选择协作场景</span><span>3. 为源模型选择辅助模型</span></div>
            </div>
          </div>
        </div>
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4">
          <div className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-300" /><p className="text-[10px] leading-5 text-amber-100/65">当前是能力关系预览：后端尚未提供关系字段的持久化和执行器接线，因此暂不能保存，也不会改变线上生成链路。</p></div>
        </div>
      </div>

      {/* 类型切换 */}
      <div className="grid gap-2 sm:grid-cols-2">
        {(['video-baseImage', 'text-vision'] as const).map((k) => {
          const Icon = k === 'video-baseImage' ? Video : MessageSquare;
          const m = KIND_META[k];
          return (
            <button
              key={k}
              onClick={() => setActiveKind(k)}
              className={`flex items-start gap-3 rounded-xl px-4 py-3 text-left transition-colors ${
                activeKind === k
                  ? 'border border-emerald-500/30 bg-emerald-500/10 text-white'
                  : 'border border-zinc-800 bg-zinc-900/30 text-zinc-400 hover:border-zinc-700 hover:text-white'
              }`}
            >
              <Icon className={`mt-0.5 size-4 shrink-0 ${activeKind === k ? 'text-emerald-400' : 'text-zinc-600'}`} />
              <span><span className="block text-xs font-semibold">{m.title}</span><span className="mt-0.5 block text-[10px] font-normal text-zinc-500">{m.desc}</span></span>
            </button>
          );
        })}
      </div>

      {/* 当前场景摘要 */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 px-4 py-3 flex items-center gap-3">
        <ListChecks className="size-4 shrink-0 text-zinc-500" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-zinc-200">{meta.title}</div>
          <div className="mt-0.5 text-[10px] text-zinc-600">源模型需启用 {meta.sourceCap}；辅助模型需启用 {meta.targetCap}</div>
        </div>
        <div className="flex shrink-0 items-center gap-4 text-[10px] text-zinc-500"><span>源模型 <b className="text-zinc-200">{sourceModels.length}</b></span><span>辅助模型 <b className="text-zinc-200">{targetModels.length}</b></span></div>
      </div>

      {/* 源模型列表 + 配套 */}
      <div className="space-y-2">
        {sourceModels.length === 0 && (
          <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/30 p-8 text-center">
            <Sparkles className="mx-auto mb-2 size-8 text-zinc-600" />
            <p className="text-sm text-zinc-500">没有可配对的源模型</p>
            <p className="text-[11px] text-zinc-600 mt-1">
              请先在「模型」中编辑能力：源模型打开 {meta.sourceCap}，辅助模型打开 {meta.targetCap}
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