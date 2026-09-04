// ── Model UI — FormGenerator（L41 渲染层，未接线）──────────────────────────
//
// 由 buildFormSchema 产出的 FormSchema 渲染 §12 Basic/Advanced 表单。
// 字段控件：text / number / select(enum) / slider / textarea / file(assetRef)。
//
// ⚠ 未接线状态：本组件目前只被测试引用，尚未挂载到 studio 运行画面。file
//   (assetRef) 字段渲染为占位按钮（真实素材选择器接线留 L42/L46，届时把
//   projectId + onPick 接进 AssetPicker）。projectId prop 仅为未来接线预留。

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { groupBySection, type FormField, type FormFieldType, type FormSchema } from './formSchema';

export interface FormGeneratorProps {
  schema: FormSchema;
  /** 当前值；缺省时回退 field.default。 */
  values?: Record<string, unknown>;
  /** 字段变更回调（未接线到任何 store/API）。 */
  onChange?: (key: string, value: unknown) => void;
  /** 预留：未来 assetRef 素材选择器接线。 */
  projectId?: string;
}

function currentValue(field: FormField, values?: Record<string, unknown>): unknown {
  const v = values?.[field.key];
  return v !== undefined && v !== null ? v : field.default;
}

function toDisplay(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value);
}

function FieldControl({ field, value, onChange }: { field: FormField; value: unknown; onChange?: (key: string, value: unknown) => void }) {
  const set = (v: unknown) => onChange?.(field.key, v);
  const testId = `form-field-${field.key}`;
  const common = {
    'data-test': testId,
    'aria-label': field.label,
    id: `ff-${field.key}`,
  } as const;

  if (field.type === 'select') {
    return (
      <select {...common} value={toDisplay(value)} onChange={(e) => set(e.target.value)} className="h-8 w-full rounded-md bg-ml2-surface-3 px-2 text-xs text-ml2-text outline-none focus:ring-1 focus:ring-ml2-accent">
        <option value="">请选择…</option>
        {(field.options ?? []).map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
      </select>
    );
  }
  if (field.type === 'textarea') {
    return <textarea {...common} value={toDisplay(value)} onChange={(e) => set(e.target.value)} rows={5} className="w-full resize-none rounded-md bg-ml2-surface-3 p-2 text-[11px] text-ml2-text outline-none focus:ring-1 focus:ring-ml2-accent" />;
  }
  if (field.type === 'file') {
    // 未接线：占位按钮。真实 AssetPicker 接线留 L42/L46。
    return (
      <button type="button" {...common} onClick={() => { /* noop — asset picker 未接线 */ }} className="h-8 w-full rounded-md bg-ml2-surface-3 px-2 text-left text-xs text-ml2-text outline-none focus:ring-1 focus:ring-ml2-accent">
        {value ? `已引用 ${toDisplay(value)}` : '选择资产引用…（未接线）'}
      </button>
    );
  }
  if (field.type === 'slider') {
    const num = Number(toDisplay(value)) || 0;
    return (
      <div className="flex items-center gap-2">
        <input {...common} type="range" min={field.min ?? 0} max={field.max ?? 100} step={field.step ?? 1} value={num} onChange={(e) => set(Number(e.target.value))} className="h-8 flex-1 accent-ml2-accent" />
        <span className="min-w-10 text-right text-xs tabular-nums text-ml2-text-2">{num}{field.units ?? ''}</span>
      </div>
    );
  }
  if (field.type === 'number') {
    return <input {...common} type="number" min={field.min} max={field.max} step={field.step} value={toDisplay(value)} onChange={(e) => set(e.target.value === '' ? undefined : Number(e.target.value))} className="h-8 w-full rounded-md bg-ml2-surface-3 px-2 text-xs text-ml2-text outline-none focus:ring-1 focus:ring-ml2-accent" />;
  }
  // text（含 boolean/array 等 L41 范围外类型的回退）
  return <input {...common} type="text" value={toDisplay(value)} onChange={(e) => set(e.target.value)} className="h-8 w-full rounded-md bg-ml2-surface-3 px-2 text-xs text-ml2-text outline-none focus:ring-1 focus:ring-ml2-accent" />;
}

function FieldRow({ field, values, onChange }: { field: FormField; values?: Record<string, unknown>; onChange?: (k: string, v: unknown) => void }) {
  const value = currentValue(field, values);
  return (
    <div data-test={`form-field-row-${field.key}`} className="space-y-1.5">
      <label htmlFor={`ff-${field.key}`} className="block text-[11px] font-medium text-ml2-text-2">
        {field.label}{field.required && <span className="ml-1 text-red-400">*</span>}
        {field.units && field.type !== 'slider' && <span className="ml-1 text-ml2-text-3">({field.units})</span>}
      </label>
      {field.description && <p className="text-[10px] leading-snug text-ml2-text-3">{field.description}</p>}
      <FieldControl field={field} value={value} onChange={onChange} />
    </div>
  );
}

export function FormGenerator({ schema, values, onChange, projectId: _projectId }: FormGeneratorProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div data-test="form-generator" className="space-y-3">
      {groupBySection(schema.normalFields).map(([section, fields]) => (
        <div key={section} className="space-y-2">
          <h3 data-test={`form-generator-section-${section}`} className="text-[10px] font-semibold uppercase tracking-wide text-ml2-text-3">{section}</h3>
          {fields.map((f) => <FieldRow key={f.key} field={f} values={values} onChange={onChange} />)}
        </div>
      ))}
      {schema.hasAdvanced && (
        <div className="border-t border-ml2-border pt-2">
          <button type="button" data-test="form-generator-advanced-toggle" onClick={() => setAdvancedOpen((v) => !v)} aria-expanded={advancedOpen} className="mb-2 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-ml2-text-3 hover:text-ml2-text-2">
            {advancedOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />} Advanced
          </button>
          {advancedOpen && (
            <div data-test="form-generator-advanced" className="space-y-2">
              {schema.advancedFields.map((f) => <FieldRow key={f.key} field={f} values={values} onChange={onChange} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 字段类型集合（供外部/测试断言 L41 支持面）。 */
export const SUPPORTED_FIELD_TYPES: readonly FormFieldType[] = ['text', 'number', 'select', 'slider', 'textarea', 'file'];
