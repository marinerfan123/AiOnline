// M05-A — Studio Inspector (right rail).
// No selection: canvas/project summary. Single node: per-node inspector
// derived from registry. Multi: selection summary + actions.
// Detail parameters live HERE, not on node cards (M05-B will extend).

import { useMemo } from 'react';
import { Trash2, Copy, Group, AlignStartVertical, AlignCenterVertical, AlignEndVertical } from 'lucide-react';
import { useStudioStore } from './store';
import { getNodeDef } from './registry';
import { NodeIcon } from './NodeIcon';
import { AssetPicker } from '@/features/project-foundation/AssetPicker';
import type { AssetType } from '@/shared/api/contract/schemas';
import { Button } from '@/shared/ui/v2/Button';
import { Input } from '@/shared/ui/v2/Input';

const ASSET_TYPES_BY_KIND: Record<string, AssetType[]> = {
  reference: [], // all types allowed as reference
  image: ['IMAGE'],
  video: ['VIDEO'],
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-ml2-border px-3 py-2.5">
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ml2-text-3">{title}</h3>
      {children}
    </div>
  );
}

export function Inspector({ projectId }: { projectId: string }) {
  const nodes = useStudioStore((s) => s.nodes);
  const edges = useStudioStore((s) => s.edges);
  const updateNodeData = useStudioStore((s) => s.updateNodeData);
  const beginEdit = useStudioStore((s) => s.beginEdit);
  const endEdit = useStudioStore((s) => s.endEdit);
  const removeSelection = useStudioStore((s) => s.removeSelection);
  const duplicateSelection = useStudioStore((s) => s.duplicateSelection);
  const copySelection = useStudioStore((s) => s.copySelection);
  const alignSelection = useStudioStore((s) => s.alignSelection);
  const groupSelection = useStudioStore((s) => s.groupSelection);

  const selected = useMemo(() => nodes.filter((n) => n.selected), [nodes]);
  const single = selected.length === 1 ? selected[0] : null;
  const def = single ? getNodeDef(single.data.nodeKind) : null;

  return (
    <aside data-test="studio-inspector" className="flex h-full w-60 shrink-0 flex-col overflow-y-auto border-l border-ml2-border bg-ml2-surface-1 xl:w-64 2xl:w-72">
      {selected.length === 0 && (
        <>
          <Section title="Canvas">
            <div className="space-y-1 text-[11px] text-ml2-text-2">
              <p>节点：{nodes.length}</p>
              <p>连接：{edges.length}</p>
              <p>Project：{projectId || '—'}</p>
            </div>
          </Section>
          <Section title="Persistence">
            <p className="text-[11px] leading-relaxed text-ml2-text-3">
              当前为 M05-A 会话态 Canvas（内存，可 undo/redo）。
              正式保存与版本将在 M05-C 接入 shared PostgreSQL。
              刷新页面将丢失未保存的画布内容。
            </p>
          </Section>
        </>
      )}

      {selected.length >= 2 && (
        <Section title={`已选择 ${selected.length} 项`}>
          <div className="grid grid-cols-2 gap-1.5">
            <Button size="sm" variant="secondary" onClick={duplicateSelection}><Copy className="size-3" />复制</Button>
            <Button size="sm" variant="destructive" onClick={removeSelection}><Trash2 className="size-3" />删除</Button>
            <Button size="sm" variant="secondary" data-test="inspector-align-left" onClick={() => alignSelection('left')}><AlignStartVertical className="size-3" />左对齐</Button>
            <Button size="sm" variant="secondary" data-test="inspector-align-middle" onClick={() => alignSelection('middle')}><AlignCenterVertical className="size-3" />水平居中</Button>
            <Button size="sm" variant="secondary" data-test="inspector-align-right" onClick={() => alignSelection('right')}><AlignEndVertical className="size-3" />右对齐</Button>
            <Button size="sm" variant="secondary" data-test="inspector-group" onClick={groupSelection}><Group className="size-3" />成组</Button>
          </div>
        </Section>
      )}

      {single && def && (
        <>
          <Section title={def.title}>
            <div className="flex items-center gap-2">
              <span className="grid size-7 place-items-center rounded bg-ml2-surface-3">
                <NodeIcon name={def.icon} className="size-4 text-ml2-accent" />
              </span>
              <div className="min-w-0 flex-1">
                <Input
                  data-test="inspector-node-title"
                  value={single.data.title}
                  onFocus={beginEdit}
                  onBlur={endEdit}
                  onChange={(e) => updateNodeData(single.id, { title: e.target.value })}
                  className="h-6 px-1.5 text-[11px]"
                />
                <p className="mt-1 text-[10px] text-ml2-text-3">{def.description}</p>
              </div>
            </div>
          </Section>

          {(def.id === 'prompt' || def.id === 'script') && (
            <Section title="Prompt">
              <textarea
                data-test="inspector-prompt"
                value={single.data.prompt ?? ''}
                onFocus={beginEdit}
                onBlur={endEdit}
                onChange={(e) => updateNodeData(single.id, { prompt: e.target.value })}
                placeholder="输入提示词…（编辑不会触发后端请求，生成由 M05-C Run Engine 控制）"
                rows={6}
                className="w-full resize-none rounded-md bg-ml2-surface-3 p-2 text-[11px] leading-relaxed text-ml2-text outline-none placeholder:text-ml2-text-3 focus:ring-1 focus:ring-ml2-accent"
              />
            </Section>
          )}

          {(def.id === 'reference' || def.id === 'image' || def.id === 'video') && (
            <Section title="Asset (M04-S)">
              <p className="mb-2 text-[10px] text-ml2-text-3">
                节点仅引用 assetId（永久 identity）。当前：
                <span className="block truncate font-mono text-ml2-text-2">{single.data.assetId ?? '未选择'}</span>
              </p>
              <AssetPicker projectId={projectId} allowedTypes={ASSET_TYPES_BY_KIND[def.id] ?? []} initialAssetId={(single.data.assetId as string | null) ?? undefined}
                onPick={(a) => { beginEdit(); updateNodeData(single.id, { assetId: a.assetId, status: 'ready' }); endEdit(); }}
              >
                {(open) => (
                  <Button data-test="inspector-open-asset-picker" size="sm" variant="secondary" className="w-full" onClick={open}>
                    {single.data.assetId ? '更换素材…' : '从素材库选择…'}
                  </Button>
                )}
              </AssetPicker>
              {single.data.assetId && (
                <Button size="sm" variant="ghost" className="mt-1 w-full text-ml2-text-3" onClick={() => { beginEdit(); updateNodeData(single.id, { assetId: null, status: 'idle' }); endEdit(); }}>
                  移除引用
                </Button>
              )}
            </Section>
          )}

          <Section title="Actions">
            <div className="grid grid-cols-2 gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => { copySelection(); }}><Copy className="size-3" />复制</Button>
              <Button size="sm" variant="destructive" onClick={removeSelection}><Trash2 className="size-3" />删除</Button>
            </div>
          </Section>
        </>
      )}

      <div className="mt-auto px-3 py-2 text-[10px] leading-relaxed text-ml2-text-3">
        快捷键：Del 删除 · Ctrl+D 复制 · Ctrl+C/V 拷贝粘贴 · Ctrl+Z / Ctrl+Shift+Z undo/redo
      </div>
    </aside>
  );
}
