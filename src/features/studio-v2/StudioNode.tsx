// M05-A/B2 — Studio node card (compact).
// Derived entirely from the Node Registry: ports come from NODE_DEFS, no
// per-kind branching. Memoized for 1000-node scale. Asset previews resolve
// through the M04-S Asset API (assetId is the identity; the URL is display
// only and lazy-loaded).
//
// M05-B2: generation node cards show honest result placeholders
// ("Ready to run" / "Invalid configuration" / "Stale") — NEVER fake media.
// Structural (frame) nodes render as pure containers.

import { memo } from 'react';
import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, AlertCircle, User } from 'lucide-react';
import { getNodeDef } from './registry';
import { NodeIcon } from './NodeIcon';
import { v2asset } from '@/shared/api/contract/asset-client';
import type { StudioNode, StudioEdge } from './store';
import { cn } from '@/lib/utils';

const STATUS_META: Record<string, { label: string; className: string }> = {
  IDLE: { label: '待配置', className: 'bg-ml2-surface-3 text-ml2-text-3' },
  READY: { label: '就绪', className: 'bg-emerald-500/15 text-emerald-400' },
  INVALID: { label: '无效', className: 'bg-red-500/15 text-red-400' },
  STALE: { label: '待刷新', className: 'bg-amber-500/15 text-amber-400' },
  QUEUED: { label: '排队中', className: 'bg-ml2-accent/15 text-ml2-accent' },
  RUNNING: { label: '运行中', className: 'bg-ml2-accent/15 text-ml2-accent' },
  SUCCEEDED: { label: '成功', className: 'bg-emerald-500/15 text-emerald-400' },
  FAILED: { label: '失败', className: 'bg-red-500/15 text-red-400' },
  CANCELLED: { label: '已取消', className: 'bg-ml2-surface-3 text-ml2-text-3' },
  idle: { label: '待配置', className: 'bg-ml2-surface-3 text-ml2-text-3' },
  ready: { label: '就绪', className: 'bg-emerald-500/15 text-emerald-400' },
  generating: { label: '生成中', className: 'bg-ml2-accent/15 text-ml2-accent' },
  error: { label: '错误', className: 'bg-red-500/15 text-red-400' },
  disabled: { label: '禁用', className: 'bg-ml2-surface-3 text-ml2-text-3 opacity-60' },
  stale: { label: '待刷新', className: 'bg-amber-500/15 text-amber-400' },
};

function AssetPreview({ assetId, kind }: { assetId: string; kind: string }) {
  // Lazy, viewport-friendly preview via the M04-S resolver (assetId identity).
  const q = useQuery({
    queryKey: ['v2', 'asset', assetId],
    queryFn: () => v2asset.getAsset(assetId),
    retry: 0,
    staleTime: 60_000,
  });
  const url = q.data?.asset?.thumbnailUrl || q.data?.asset?.url || '';
  if (!url) {
    return (
      <div className="grid h-24 place-items-center bg-ml2-surface-3 text-ml2-text-3">
        {q.isLoading || q.isPending ? <Loader2 className="size-4 animate-spin" /> : <span className="text-[10px]">无预览</span>}
      </div>
    );
  }
  return kind === 'video' ? (
    <video src={url} muted preload="metadata" className="h-24 w-full object-cover" />
  ) : (
    <img src={url} alt="" loading="lazy" className="h-24 w-full object-cover" />
  );
}

function TextPreview({ text, hint }: { text?: string; hint: string }) {
  return (
    <p className="line-clamp-3 whitespace-pre-wrap px-2 py-1.5 text-[11px] leading-relaxed text-ml2-text-2">
      {text?.trim() || <span className="text-ml2-text-3">{hint}</span>}
    </p>
  );
}

/** M05-B2 honest result placeholder for generation nodes — never fake media. */
function AssetPlaceholder({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="grid h-24 place-items-center bg-ml2-surface-3 text-center">
      <span className="px-2 text-[10px] leading-relaxed text-ml2-text-3">
        {label}
        <br />
        {hint}
      </span>
    </div>
  );
}

function GenerationPlaceholder({ status }: { status: string }) {
  const label =
    status === 'STALE' || status === 'stale'
      ? 'Stale — upstream changed'
      : status === 'INVALID' || status === 'error'
        ? 'Invalid configuration'
        : status === 'READY' || status === 'ready'
          ? 'Ready to run'
          : '待配置 (not ready)';
  return (
    <div data-test="generation-placeholder" className="grid h-24 place-items-center bg-ml2-surface-3 text-center">
      <span className="px-2 text-[10px] leading-relaxed text-ml2-text-3">{label}</span>
    </div>
  );
}

function StudioNodeInner({ id, data, selected, width }: NodeProps<StudioNode>) {
  void id;
  const def = getNodeDef(data.nodeKind);
  if (!def) {
    // Unknown node kind — isolated error card, never crash the whole canvas.
    return (
      <div className="w-56 rounded-lg border border-red-500/40 bg-ml2-surface-1 p-3 text-xs text-red-400">
        <AlertCircle className="mb-1 size-4" />
        未知节点类型：{String(data.nodeKind)}
      </div>
    );
  }
  const status = STATUS_META[data.status] ?? STATUS_META.idle;
  const isFrame = def.executionKind === 'STRUCTURAL';
  const params = (data.parameters ?? {}) as Record<string, unknown>;
  const text = (params.prompt ?? params.scriptText ?? params.name ?? params.description ?? params.content ?? data.prompt) as string | undefined;

  return (
    <div
      data-test="studio-node-card"
      data-node-kind={def.id}
      className={cn(
        'flex flex-col overflow-hidden rounded-lg border bg-ml2-surface-1 shadow-md transition-shadow',
        selected ? 'border-ml2-accent ring-2 ring-ml2-accent/40 shadow-lg' : 'border-ml2-border hover:border-ml2-border-strong',
        data.status === 'disabled' && 'opacity-60',
        isFrame && 'w-full',
      )}
      style={isFrame ? undefined : { width: width ?? def.width }}
    >
      {!isFrame && <NodeResizer isVisible={selected} minWidth={240} minHeight={90} />}
      <div className="flex items-center gap-1.5 border-b border-ml2-border bg-ml2-surface-2 px-2 py-1.5">
        <NodeIcon name={def.icon} className="size-3.5 shrink-0 text-ml2-text-2" />
        <span className="truncate text-[11px] font-medium text-ml2-text">{data.title}</span>
        <span className={cn('ml-auto shrink-0 rounded-full px-1.5 py-px text-[9px] font-medium', status.className)}>
          {status.label}
        </span>
      </div>

      <div className="p-1.5">
        {def.id === 'prompt' && <TextPreview text={text} hint="在右侧 Inspector 编辑提示词" />}
        {def.id === 'script' && <TextPreview text={text} hint="在右侧 Inspector 编辑脚本" />}
        {def.id === 'character' && (
          <>
            <div className="flex items-center gap-2 px-2 py-1.5">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-ml2-surface-3 text-ml2-accent">
                <User className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[11px] text-ml2-text">{String(params.name ?? '未命名角色')}</span>
                {params.assetId ? (
                  <AssetPreview assetId={String(params.assetId)} kind="image" />
                ) : (
                  <span className="block truncate text-[10px] text-ml2-text-3">{String(params.description ?? '') || '可选素材 / 描述'}</span>
                )}
              </span>
            </div>
          </>
        )}
        {(def.id === 'reference' || def.id === 'video') &&
          (data.assetId ? (
            <AssetPreview assetId={data.assetId} kind={def.id === 'video' ? 'video' : 'image'} />
          ) : (
            <div className="grid h-24 place-items-center bg-ml2-surface-3 text-center">
              <span className="px-2 text-[10px] leading-relaxed text-ml2-text-3">
                未选择素材
                <br />
                在 Inspector 中打开素材库
              </span>
            </div>
          ))}
        {def.id === 'image-generation' && (
          data.assetId
            ? <AssetPreview assetId={data.assetId} kind="image" />
            : <GenerationPlaceholder status={data.status} />
        )}
        {(def.id === 'image-to-video' || def.id === 'text-to-video') && (
          data.assetId
            ? <AssetPreview assetId={data.assetId} kind="video" />
            : <GenerationPlaceholder status={data.status} />
        )}
        {def.id === 'text' && <TextPreview text={text} hint="在右侧 Inspector 编辑文本" />}
        {def.id === 'image' && (
          data.assetId
            ? <AssetPreview assetId={data.assetId} kind="image" />
            : <AssetPlaceholder label="未选择图片素材" hint="在 Inspector 中绑定图片资产 (active version)" />
        )}
        {def.id === 'audio' && (
          <AssetPlaceholder label={data.assetId ? '音频素材' : '未选择音频素材'} hint={data.assetId ? String(params.voiceId || 'waveform 于 G06') : '在 Inspector 中绑定音频资产'} />
        )}
        {def.id === 'video-clip' && (
          data.assetId
            ? <AssetPreview assetId={data.assetId} kind="video" />
            : <AssetPlaceholder label="未选择视频片段" hint="在 Inspector 中绑定视频资产" />
        )}
        {def.id === 'storyboard' && (
          data.assetId
            ? <AssetPreview assetId={data.assetId} kind="image" />
            : <AssetPlaceholder label={params.shotId ? `Shot ${String(params.shotId)} 候选待生成` : '分镜候选板'} hint="绑定 Shot 或先生成候选图 (G13)" />
        )}
        {def.id === 'output' && (
          <div className="grid h-24 place-items-center bg-ml2-surface-3">
            <span className="text-[10px] text-ml2-text-3">产出边界（M05-C+ 接入 Run / Export）</span>
          </div>
        )}
        {isFrame && (
          <div className="grid h-16 place-items-center rounded-md border border-dashed border-ml2-border bg-ml2-surface-0">
            <span className="text-[10px] text-ml2-text-3">{data.frameLabel || 'Frame / Group'}</span>
          </div>
        )}
      </div>

      {def.inputPorts.map((p, i) => (
        <Handle
          key={p.id}
          id={p.id}
          type="target"
          position={Position.Left}
          title={p.label}
          // M05-B2: distribute multiple input ports down the left edge so each
          // handle is individually reachable (stacked handles would overlap and
          // make the drop land on the wrong port).
          style={{ top: `${((i + 1) * 100) / (def.inputPorts.length + 1)}%` }}
          className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-ml2-surface-0 !bg-ml2-accent"
        />
      ))}
      {def.outputPorts.map((p, i) => (
        <Handle
          key={p.id}
          id={p.id}
          type="source"
          position={Position.Right}
          title={p.label}
          style={{ top: `${((i + 1) * 100) / (def.outputPorts.length + 1)}%` }}
          className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-ml2-surface-0 !bg-ml2-accent"
        />
      ))}
    </div>
  );
}

export const StudioNodeComponent = memo(StudioNodeInner);
export type { StudioEdge };
