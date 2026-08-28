// M05-A — Studio node card (compact).
// Derived entirely from the Node Registry: ports come from NODE_DEFS, no
// per-kind branching. Memoized for 1000-node scale. Asset previews resolve
// through the M04-S Asset API (assetId is the identity; the URL is display
// only and lazy-loaded).

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, AlertCircle } from 'lucide-react';
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
  RUNNING: { label: '运行中', className: 'bg-ml2-accent/15 text-ml2-accent' },
  SUCCEEDED: { label: '成功', className: 'bg-emerald-500/15 text-emerald-400' },
  FAILED: { label: '失败', className: 'bg-red-500/15 text-red-400' },
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

function PromptPreview({ prompt }: { prompt?: string }) {
  return (
    <p className="line-clamp-3 whitespace-pre-wrap px-2 py-1.5 text-[11px] leading-relaxed text-ml2-text-2">
      {prompt?.trim() || <span className="text-ml2-text-3">在右侧 Inspector 编辑提示词</span>}
    </p>
  );
}

function StudioNodeInner({ id, data, selected }: NodeProps<StudioNode>) {
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
  const isFrame = def.category === 'Structure';

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
      style={isFrame ? undefined : { width: def.width }}
    >
      <div className="flex items-center gap-1.5 border-b border-ml2-border bg-ml2-surface-2 px-2 py-1.5">
        <NodeIcon name={def.icon} className="size-3.5 shrink-0 text-ml2-text-2" />
        <span className="truncate text-[11px] font-medium text-ml2-text">{data.title}</span>
        <span className={cn('ml-auto shrink-0 rounded-full px-1.5 py-px text-[9px] font-medium', status.className)}>
          {status.label}
        </span>
      </div>

      <div className="p-1.5">
        {def.id === 'prompt' && <PromptPreview prompt={data.prompt} />}
        {(def.id === 'reference' || def.id === 'image' || def.id === 'video') &&
          (data.assetId ? (
            <AssetPreview assetId={data.assetId} kind={def.id} />
          ) : (
            <div className="grid h-24 place-items-center bg-ml2-surface-3 text-center">
              <span className="px-2 text-[10px] leading-relaxed text-ml2-text-3">
                未选择素材
                <br />
                在 Inspector 中打开素材库
              </span>
            </div>
          ))}
        {def.id === 'output' && (
          <div className="grid h-24 place-items-center bg-ml2-surface-3">
            <span className="text-[10px] text-ml2-text-3">产出汇集（M05-C 接入 Run）</span>
          </div>
        )}
        {def.id === 'script' && <PromptPreview prompt={data.prompt} />}
        {isFrame && (
          <div className="grid h-16 place-items-center rounded-md border border-dashed border-ml2-border bg-ml2-surface-0">
            <span className="text-[10px] text-ml2-text-3">{data.frameLabel || 'Frame / Group'}</span>
          </div>
        )}
      </div>

      {def.inputPorts.map((p) => (
        <Handle
          key={p.id}
          id={p.id}
          type="target"
          position={Position.Left}
          title={p.label}
          className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-ml2-surface-0 !bg-ml2-accent"
        />
      ))}
      {def.outputPorts.map((p) => (
        <Handle
          key={p.id}
          id={p.id}
          type="source"
          position={Position.Right}
          title={p.label}
          className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-ml2-surface-0 !bg-ml2-accent"
        />
      ))}
    </div>
  );
}

export const StudioNodeComponent = memo(StudioNodeInner);
export type { StudioEdge };
