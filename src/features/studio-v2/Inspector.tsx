// M05-B1/B2 — Studio Inspector (right rail).
// Schema-driven production inspector: identity header, validation, parameters,
// required-inputs summary (CONNECTED/MISSING/OPTIONAL), execution status,
// and actions. Per-node parameter controls come from registry
// parameterSchema, not node-type branching.
//
// M05-B2: validation now feeds the M02 logical model catalog (TanStack Query
// cache — no per-keystroke server traffic) so MODEL_UNAVAILABLE /
// capability mismatch surface here; generation nodes show
// "Ready to run" / "Invalid configuration" / "Stale" result placeholders
// (never fake media).

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Trash2, Copy, Group, AlignStartVertical, AlignCenterVertical, AlignEndVertical } from 'lucide-react';
import { useStudioStore } from './store';
import { getNodeDef } from './registry';
import { NodeIcon } from './NodeIcon';
import { Button } from '@/shared/ui/v2/Button';
import { Input } from '@/shared/ui/v2/Input';
import { ParameterInspector } from './ParameterInspector';
import { ShotInspector } from './ShotInspector';
import { computeReadiness, validateNode } from './validation';
import { v2ai } from '@/shared/api/contract/ai-control-client';
import { cn } from '@/lib/utils';

// Re-export so consumers can import the Shot Inspector from the inspection rail.
export { ShotInspector };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-ml2-border px-3 py-2.5">
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ml2-text-3">{title}</h3>
      {children}
    </div>
  );
}

export function Inspector({
  projectId,
  episodeId,
  selectedShotId,
}: {
  projectId: string;
  /** When provided with `selectedShotId`, the rail shows the Shot Inspector (W1-11). */
  episodeId?: string;
  /** The currently selected shot id to inspect. */
  selectedShotId?: string;
}) {
  const showingShot = Boolean(episodeId && selectedShotId);
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

  // M02 logical model catalog (cached; generation nodes only)
  const modelField = def?.modelField ? def.parameterSchema.find((f) => f.key === def.modelField) : undefined;
  const modelsQuery = useQuery({
    queryKey: ['v2', 'ai-control', 'models', modelField?.capability ?? 'all'],
    queryFn: () => v2ai.listModels(),
    retry: 0,
    enabled: Boolean(single && def?.isGeneration),
  });

  const selectedModel = useMemo(() => {
    if (!single || !def?.isGeneration || !def.modelField) return null;
    const id = String((single.data.parameters ?? {})[def.modelField] ?? '');
    if (!id) return null;
    return (modelsQuery.data ?? []).find((m) => m.model_id === id) ?? null;
  }, [modelsQuery.data, single, def]);

  const validation = useMemo(() => {
    if (!single || !def) return null;
    const validModelIds = modelsQuery.data ? modelsQuery.data.filter((m) => m.enabled !== false).map((m) => m.model_id) : undefined;
    return validateNode(single, def, edges, {
      validModelIds,
      model: selectedModel ?? null,
      assetExists: null,
    });
  }, [single, def, edges, modelsQuery.data, selectedModel]);

  const readiness = useMemo(() => {
    if (!single || !def) return null;
    const validModelIds = modelsQuery.data ? modelsQuery.data.filter((m) => m.enabled !== false).map((m) => m.model_id) : undefined;
    return computeReadiness(single, def, edges, { validModelIds, model: selectedModel ?? null, assetExists: null });
  }, [single, def, edges, modelsQuery.data, selectedModel]);

  const inputSummary = useMemo(() => {
    if (!single || !def) return [];
    return def.inputPorts.map((p) => {
      const connected = edges.some((e) => e.target === single.id && e.targetHandle === p.id);
      return { port: p, connected };
    });
  }, [single, def, edges]);

  return (
    <aside data-test="studio-inspector" className="flex h-full w-60 shrink-0 flex-col overflow-y-auto border-l border-ml2-border bg-ml2-surface-1 xl:w-64 2xl:w-72">
      {showingShot ? (
        <ShotInspector projectId={projectId} episodeId={episodeId!} shotId={selectedShotId!} />
      ) : (
        <>
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
                  当前为 M05-A/M05-B 会话态 Canvas（内存，可 undo/redo）。
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
                    <p className="mt-1 text-[10px] text-ml2-text-3">
                      {def.title} · {def.executionKind} · schema v{single.data.schemaVersion ?? def.version}
                    </p>
                  </div>
                </div>
              </Section>

              {def.isGeneration && (
                <Section title="Status">
                  <div data-test="inspector-status" className="space-y-1 text-[11px]">
                    {single.data.status === 'STALE' ? (
                      <p className="text-amber-400">Stale — upstream changed (upstream 变更后待重跑)</p>
                    ) : validation && !validation.valid ? (
                      <p className="text-red-400">Invalid configuration（配置无效）</p>
                    ) : readiness ? (
                      <p className={cn('text-emerald-400')}>Ready to run（就绪 · 本阶段不执行）</p>
                    ) : (
                      <p className="text-ml2-text-3">Loading…</p>
                    )}
                    <p className="text-[10px] text-ml2-text-3">M05-B2：纯配置图，不触发真实生成。</p>
                  </div>
                </Section>
              )}

              <Section title="Validation">
                <div data-test="inspector-validation" className="space-y-1 text-[11px]">
                  {validation?.valid ? <p className="text-emerald-400">valid</p> : <p className="text-red-400">invalid</p>}
                  {validation?.errors.map((e) => <p key={`${e.code}-${e.field ?? e.port}`} className="text-red-400">{e.message}</p>)}
                  {validation?.warnings.map((e) => <p key={`${e.code}-${e.field ?? e.port}`} className="text-amber-400">{e.message}</p>)}
                </div>
              </Section>

              {def.inputPorts.length > 0 && (
                <Section title="Required Inputs">
                  <div data-test="inspector-ports" className="space-y-1 text-[11px]">
                    {inputSummary.map(({ port, connected }) => (
                      <div key={port.id} className="flex items-center justify-between gap-2">
                        <span className="text-ml2-text-2">
                          {port.label}
                          <span className="ml-1 text-[9px] text-ml2-text-3">{port.type}</span>
                        </span>
                        <span
                          data-test={`port-summary-${port.id}`}
                          className={cn(
                            'rounded-full px-1.5 py-px text-[9px] font-medium',
                            port.required
                              ? connected
                                ? 'bg-emerald-500/15 text-emerald-400'
                                : 'bg-red-500/15 text-red-400'
                              : 'bg-ml2-surface-3 text-ml2-text-3',
                          )}
                        >
                          {port.required ? (connected ? 'CONNECTED' : 'MISSING') : connected ? 'CONNECTED' : 'OPTIONAL'}
                        </span>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              <Section title="Parameters">
                <ParameterInspector node={single} def={def} projectId={projectId} />
              </Section>

              <Section title="Outputs">
                <div className="space-y-1 text-[11px] text-ml2-text-2">
                  <p data-test="inspector-output-type">
                    Output: {def.outputPorts.length ? def.outputPorts.map((p) => `${p.label}:${p.type}`).join(' · ') : 'none'}
                  </p>
                  <p className="text-[10px] text-ml2-text-3">Result contract: durable assetId only（provider 临时 URL 不作为最终 authority）</p>
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
        </>
      )}

      <div className="mt-auto px-3 py-2 text-[10px] leading-relaxed text-ml2-text-3">
        快捷键：Del 删除 · Ctrl+D 复制 · Ctrl+C/V 拷贝粘贴 · Ctrl+Z / Ctrl+Shift+Z undo/redo
      </div>
    </aside>
  );
}
