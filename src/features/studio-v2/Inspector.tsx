// M05-B1 — Studio Inspector (right rail).
// Schema-driven production inspector: identity header, validation, parameters,
// IO summary, and actions. Per-node parameter controls come from registry
// parameterSchema, not node-type branching.

import { useMemo } from 'react';
import { Trash2, Copy, Group, AlignStartVertical, AlignCenterVertical, AlignEndVertical } from 'lucide-react';
import { useStudioStore } from './store';
import { getNodeDef } from './registry';
import { NodeIcon } from './NodeIcon';
import { Button } from '@/shared/ui/v2/Button';
import { Input } from '@/shared/ui/v2/Input';
import { ParameterInspector } from './ParameterInspector';
import { validateNode } from './validation';

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
  const validation = single && def ? validateNode(single, def, edges) : null;

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
              当前为 M05-A/M05-B1 会话态 Canvas（内存，可 undo/redo）。
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
          <Section title="Node identity">
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
                <p className="mt-1 text-[10px] text-ml2-text-3">{def.title} · schema v{single.data.schemaVersion ?? def.version}</p>
              </div>
            </div>
          </Section>

          <Section title="Validation">
            <div data-test="inspector-validation" className="space-y-1 text-[11px]">
              {validation?.valid ? <p className="text-emerald-400">valid</p> : <p className="text-red-400">invalid</p>}
              {validation?.errors.map((e) => <p key={`${e.code}-${e.field ?? e.port}`} className="text-red-400">{e.message}</p>)}
              {validation?.warnings.map((e) => <p key={`${e.code}-${e.field ?? e.port}`} className="text-amber-400">{e.message}</p>)}
            </div>
          </Section>

          <Section title="Parameters">
            <ParameterInspector node={single} def={def} projectId={projectId} />
          </Section>

          <Section title="Inputs / Outputs">
            <div className="space-y-1 text-[11px] text-ml2-text-2">
              <p>Inputs: {def.inputPorts.length ? def.inputPorts.map((p) => `${p.label}:${p.type}`).join(' · ') : 'none'}</p>
              <p>Outputs: {def.outputPorts.length ? def.outputPorts.map((p) => `${p.label}:${p.type}`).join(' · ') : 'none'}</p>
              <p>Execution: contract only · no real generation in M05-B1</p>
            </div>
          </Section>

          <Section title="Actions">
            <div className="grid grid-cols-2 gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => { copySelection(); }}><Copy className="size-3" />复制</Button>
              <Button size="sm" variant="destructive" onClick={removeSelection}><Trash2 className="size-3" />删除</Button>
            </div>
          </Section>
        </>
      )}

      {single && !def && (
        <>
          <Section title="Unknown Node">
            <div data-test="unknown-node-inspector" className="space-y-1 text-[11px] text-ml2-text-2">
              <p>node type: {String(single.data.nodeKind)}</p>
              <p>schema version: {String(single.data.schemaVersion ?? 'unknown')}</p>
              <p className="text-amber-400">unsupported · execution disabled</p>
            </div>
          </Section>
          <Section title="Actions">
            <Button size="sm" variant="destructive" onClick={removeSelection}><Trash2 className="size-3" />删除</Button>
          </Section>
        </>
      )}

      <div className="mt-auto px-3 py-2 text-[10px] leading-relaxed text-ml2-text-3">
        快捷键：Del 删除 · Ctrl+D 复制 · Ctrl+C/V 拷贝粘贴 · Ctrl+Z / Ctrl+Shift+Z undo/redo
      </div>
    </aside>
  );
}
