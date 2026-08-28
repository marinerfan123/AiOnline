// M05-B1 — schema-driven parameter inspector renderer.
// Renders from NodeDef.parameterSchema; model options come from M02 logical
// model catalog via TanStack Query (cache only, not authority).

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { AssetPicker } from '@/features/project-foundation/AssetPicker';
import { Button } from '@/shared/ui/v2/Button';
import { Input } from '@/shared/ui/v2/Input';
import { v2ai, type LogicalModelView } from '@/shared/api/contract/ai-control-client';
import type { NodeDef } from './registry';
import type { ParameterField, StudioParameters } from './types';
import type { StudioNode } from './store';
import { useStudioStore } from './store';
import { validateParameterValue } from './validation';

function isVisible(field: ParameterField, params: StudioParameters) {
  const c = field.visibleWhen;
  if (!c) return true;
  const v = params[c.field];
  if (c.exists !== undefined) return c.exists ? v !== undefined && v !== null && v !== '' : v === undefined || v === null || v === '';
  if ('equals' in c) return v === c.equals;
  if ('notEquals' in c) return v !== c.notEquals;
  return true;
}

function modelMatches(m: LogicalModelView, capability: string) {
  if (!capability) return true;
  return m.enabled !== false && m.capabilities?.type === capability;
}

function FieldErrors({ field, value }: { field: ParameterField; value: unknown }) {
  const validation = validateParameterValue(field, value);
  if (validation.errors.length === 0) return null;
  return (
    <div id={`param-error-${field.key}`} className="mt-1 space-y-0.5" aria-live="polite">
      {validation.errors.map((e) => <p key={`${e.code}-${e.message}`} className="text-[10px] text-red-400">{e.message}</p>)}
    </div>
  );
}

function ModelField({ field, value, onChange }: { field: ParameterField; value: unknown; onChange: (v: unknown) => void }) {
  const q = useQuery({ queryKey: ['v2', 'ai-control', 'models', field.capability ?? 'all'], queryFn: () => v2ai.listModels(), retry: 0 });
  const models = useMemo(() => (q.data ?? []).filter((m) => modelMatches(m, field.capability ?? '')), [q.data, field.capability]);

  if (q.isPending) return <p data-test={`param-${field.key}-loading`} className="text-[11px] text-ml2-text-3">加载 Logical Models…</p>;
  if (q.isError) {
    return (
      <div className="rounded border border-red-500/30 bg-red-500/5 p-2">
        <p className="mb-1 text-[11px] text-red-400">模型加载失败</p>
        <Button size="sm" variant="secondary" onClick={() => q.refetch()}><RefreshCw className="size-3" />重试</Button>
      </div>
    );
  }
  if (models.length === 0) return <p className="text-[11px] text-ml2-text-3">没有可用 Logical Model</p>;

  return (
    <select
      data-test={`param-${field.key}`}
      aria-label={field.label}
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={validateParameterValue(field, value).errors.length > 0 || undefined}
      className="h-8 w-full rounded-md bg-ml2-surface-3 px-2 text-xs text-ml2-text outline-none focus:ring-1 focus:ring-ml2-accent"
    >
      <option value="">选择 Logical Model…</option>
      {models.map((m) => <option key={m.model_id} value={m.model_id}>{m.display_name || m.model_id}</option>)}
    </select>
  );
}

function ParameterControl({ field, node, projectId }: { field: ParameterField; node: StudioNode; projectId: string }) {
  const updateNodeParameter = useStudioStore((s) => s.updateNodeParameter);
  const beginEdit = useStudioStore((s) => s.beginEdit);
  const endEdit = useStudioStore((s) => s.endEdit);
  const params = (node.data.parameters ?? {}) as StudioParameters;
  const value = params[field.key] ?? field.defaultValue ?? '';
  const set = (v: unknown) => updateNodeParameter(node.id, field.key, v);
  const testId = field.key === 'prompt' ? 'inspector-prompt' : `param-${field.key}`;
  const common = {
    'data-test': testId,
    'aria-label': field.label,
    'aria-describedby': `param-error-${field.key}`,
    'aria-invalid': validateParameterValue(field, value).errors.length > 0 || undefined,
    onFocus: beginEdit,
    onBlur: endEdit,
  } as const;

  if (field.type === 'model') return <ModelField field={field} value={value} onChange={(v) => { beginEdit(); set(v); endEdit(); }} />;
  if (field.type === 'asset') {
    return (
      <AssetPicker projectId={projectId} allowedTypes={field.assetTypes ?? []} initialAssetId={typeof value === 'string' ? value : undefined}
        onPick={(a) => { beginEdit(); set(a.assetId); endEdit(); }}>
        {(open) => <Button data-test={field.key === 'assetId' ? 'inspector-open-asset-picker' : `param-${field.key}`} size="sm" variant="secondary" className="w-full" onClick={open}>{value ? `已选择 ${String(value)}` : '从素材库选择…'}</Button>}
      </AssetPicker>
    );
  }
  if (field.type === 'textarea') {
    return <textarea {...common} value={String(value ?? '')} onChange={(e) => set(e.target.value)} rows={5} className="w-full resize-none rounded-md bg-ml2-surface-3 p-2 text-[11px] text-ml2-text outline-none focus:ring-1 focus:ring-ml2-accent" />;
  }
  if (field.type === 'boolean') {
    return <input {...common} type="checkbox" checked={Boolean(value)} onChange={(e) => set(e.target.checked)} className="size-4 rounded border-ml2-border bg-ml2-surface-3" />;
  }
  if (['select', 'aspect-ratio', 'resolution'].includes(field.type)) {
    return (
      <select {...common} value={String(value ?? '')} onChange={(e) => set(e.target.value)} className="h-8 w-full rounded-md bg-ml2-surface-3 px-2 text-xs text-ml2-text outline-none focus:ring-1 focus:ring-ml2-accent">
        {field.options?.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
    );
  }
  if (field.type === 'multi-select') {
    const arr = Array.isArray(value) ? value.map(String) : [];
    return <select {...common} multiple value={arr} onChange={(e) => set(Array.from(e.currentTarget.selectedOptions).map((o) => o.value))} className="min-h-16 w-full rounded-md bg-ml2-surface-3 px-2 text-xs text-ml2-text outline-none focus:ring-1 focus:ring-ml2-accent">{field.options?.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}</select>;
  }
  if (['number', 'integer', 'slider', 'seed'].includes(field.type)) {
    const type = field.type === 'slider' ? 'range' : 'number';
    return <Input {...common} type={type} min={field.min} max={field.max} step={field.step ?? (field.type === 'integer' || field.type === 'seed' ? 1 : 'any')} value={value == null ? '' : String(value)} onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))} className="h-8 text-xs" />;
  }
  return <Input {...common} value={String(value ?? '')} onChange={(e) => set(e.target.value)} className="h-8 text-xs" />;
}

function ParameterRow({ field, node, projectId }: { field: ParameterField; node: StudioNode; projectId: string }) {
  const params = (node.data.parameters ?? {}) as StudioParameters;
  if (!isVisible(field, params)) return null;
  const value = params[field.key] ?? field.defaultValue ?? '';
  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] font-medium text-ml2-text-2">
        {field.label}{field.required && <span className="ml-1 text-red-400">*</span>}
      </label>
      {field.description && <p className="text-[10px] leading-snug text-ml2-text-3">{field.description}</p>}
      <ParameterControl field={field} node={node} projectId={projectId} />
      <FieldErrors field={field} value={value} />
    </div>
  );
}

export function ParameterInspector({ node, def, projectId }: { node: StudioNode; def: NodeDef; projectId: string }) {
  const [advancedOpen, setAdvancedOpen] = useState(def.inspector.advancedDefaultOpen);
  const normal = def.parameterSchema.filter((f) => !f.advanced);
  const advanced = def.parameterSchema.filter((f) => f.advanced);
  const grouped = (fields: ParameterField[]) => Object.entries(fields.reduce<Record<string, ParameterField[]>>((acc, f) => {
    const g = f.group ?? 'Creative';
    (acc[g] ??= []).push(f);
    return acc;
  }, {}));

  return (
    <div data-test="schema-parameter-inspector" className="space-y-3">
      {grouped(normal).map(([group, fields]) => (
        <div key={group} className="space-y-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-wide text-ml2-text-3">{group}</h3>
          {fields.map((f) => <ParameterRow key={f.key} field={f} node={node} projectId={projectId} />)}
        </div>
      ))}
      {advanced.length > 0 && (
        <div className="border-t border-ml2-border pt-2">
          <button type="button" data-test="inspector-advanced-toggle" onClick={() => setAdvancedOpen((v) => !v)} className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-ml2-text-3 hover:text-ml2-text-2">
            {advancedOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />} Advanced
          </button>
          {advancedOpen && <div className="space-y-2">{advanced.map((f) => <ParameterRow key={f.key} field={f} node={node} projectId={projectId} />)}</div>}
        </div>
      )}
    </div>
  );
}
