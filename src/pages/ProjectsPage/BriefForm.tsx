// ── W1-06 — Creative Brief onboarding form (visible fields + validation) ──────
// A controlled, reusable form for the 16 Brief fields:
//   goal, audience, platform, duration, aspect_ratio, language, key_message,
//   cta, brand, tone, style, references, budget, deadline, deliverables, restrictions.
// Used by CreateProjectPage (staged before project exists) and the project
// Overview (edit + exact echo). Mirrors the backend creativeBrief.cjs rules so
// the form never submits a payload the server rejects.

import { type ReactNode } from 'react';
import { Input, Textarea } from '@/shared/ui/v2/Input';
import { Select } from '@/shared/ui/v2/Select';
import { cn } from '@/lib/utils';
import {
  type CreativeBriefDraft,
  type BriefPlatform,
  type CreativeBriefFormErrors,
  DEFAULT_DRAFT,
  PLATFORM_OPTIONS,
} from './creativeBriefDraft';

interface BriefFormProps {
  /** Controlled draft state. */
  draft: CreativeBriefDraft;
  /** Draft change handler — parent owns the state. */
  onChange: (draft: CreativeBriefDraft) => void;
  /** Field/global validation errors (optional). */
  errors?: CreativeBriefFormErrors;
  /** Disable all inputs (e.g. read-only / no permission). */
  disabled?: boolean;
}

function Field({
  label,
  required,
  error,
  children,
  className,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <label className="text-xs font-medium text-ml2-text-2">
        {label}
        {required && <span className="ml-0.5 text-ml2-danger">*</span>}
      </label>
      {children}
      {error ? <p className="text-xs text-ml2-danger">{error}</p> : null}
    </div>
  );
}

export function BriefForm({ draft, onChange, errors, disabled }: BriefFormProps) {
  const fieldErrors = errors?.fields ?? {};
  const global = errors?.global ?? [];

  const set = (patch: Partial<CreativeBriefDraft>) => onChange({ ...draft, ...patch });

  return (
    <div className="space-y-4" data-test="brief-form">
      {global.length > 0 && (
        <div
          data-test="brief-global-errors"
          className="rounded-md border border-ml2-danger/40 bg-ml2-danger/5 px-3 py-2 text-xs text-ml2-danger"
        >
          <ul className="list-inside list-disc space-y-0.5">
            {global.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="目标（goal）*" required error={fieldErrors.goal} className="sm:col-span-2">
          <Textarea
            value={draft.goal}
            onChange={(e) => set({ goal: e.target.value })}
            placeholder="例如：推出一支面向年轻消费者的夏日饮品短片…"
            rows={3}
            disabled={disabled}
            invalid={Boolean(fieldErrors.goal)}
            data-test="bf-goal"
          />
        </Field>

        <Field label="受众（audience）*" required error={fieldErrors.audience} className="sm:col-span-2">
          <Textarea
            value={draft.audience}
            onChange={(e) => set({ audience: e.target.value })}
            placeholder="例如：18-30 岁的都市青年，重视个性与社交传播…"
            rows={3}
            disabled={disabled}
            invalid={Boolean(fieldErrors.audience)}
            data-test="bf-audience"
          />
        </Field>

        <Field label="发布平台（platform）" error={fieldErrors.platform}>
          <Select
            value={draft.platform}
            onValueChange={(v) => set({ platform: v as BriefPlatform })}
            options={PLATFORM_OPTIONS}
            placeholder="选择平台"
            disabled={disabled}
            className="w-full"
          />
        </Field>

        <Field label="时长（duration，秒）" error={fieldErrors.duration}>
          <Input
            type="number"
            min={0}
            step="any"
            value={draft.duration}
            onChange={(e) => set({ duration: e.target.value })}
            placeholder="30"
            disabled={disabled}
            invalid={Boolean(fieldErrors.duration)}
            data-test="bf-duration"
          />
        </Field>

        <Field label="画面比例（aspect_ratio）" error={fieldErrors.aspect_ratio}>
          <Input
            value={draft.aspect_ratio}
            onChange={(e) => set({ aspect_ratio: e.target.value })}
            placeholder="9:16"
            disabled={disabled}
            invalid={Boolean(fieldErrors.aspect_ratio)}
            data-test="bf-aspect-ratio"
          />
        </Field>

        <Field label="语言（language）" error={fieldErrors.language}>
          <Input
            value={draft.language}
            onChange={(e) => set({ language: e.target.value })}
            placeholder="中文"
            disabled={disabled}
            invalid={Boolean(fieldErrors.language)}
            data-test="bf-language"
          />
        </Field>

        <Field label="核心信息（key_message）" error={fieldErrors.key_message} className="sm:col-span-2">
          <Textarea
            value={draft.key_message}
            onChange={(e) => set({ key_message: e.target.value })}
            placeholder="一句观众必须记住的话…"
            rows={2}
            disabled={disabled}
            invalid={Boolean(fieldErrors.key_message)}
            data-test="bf-key-message"
          />
        </Field>

        <Field label="行动号召（cta）" error={fieldErrors.cta}>
          <Input
            value={draft.cta}
            onChange={(e) => set({ cta: e.target.value })}
            placeholder="例如：点击购买 / 关注公众号"
            disabled={disabled}
            invalid={Boolean(fieldErrors.cta)}
            data-test="bf-cta"
          />
        </Field>

        <Field label="品牌（brand）" error={fieldErrors.brand}>
          <Input
            value={draft.brand}
            onChange={(e) => set({ brand: e.target.value })}
            placeholder="品牌名"
            disabled={disabled}
            invalid={Boolean(fieldErrors.brand)}
            data-test="bf-brand"
          />
        </Field>

        <Field label="基调（tone）" error={fieldErrors.tone}>
          <Input
            value={draft.tone}
            onChange={(e) => set({ tone: e.target.value })}
            placeholder="俏皮 或 [&quot;俏皮&quot;,&quot;活力&quot;]"
            disabled={disabled}
            invalid={Boolean(fieldErrors.tone)}
            data-test="bf-tone"
          />
        </Field>

        <Field label="风格（style）" error={fieldErrors.style}>
          <Input
            value={draft.style}
            onChange={(e) => set({ style: e.target.value })}
            placeholder="国风 或 [&quot;国风&quot;,&quot;水墨&quot;]"
            disabled={disabled}
            invalid={Boolean(fieldErrors.style)}
            data-test="bf-style"
          />
        </Field>

        <Field label="参考（references）" error={fieldErrors.references} className="sm:col-span-2">
          <Textarea
            value={draft.references}
            onChange={(e) => set({ references: e.target.value })}
            placeholder='["https://example.com/ref1","https://example.com/ref2"]'
            rows={3}
            disabled={disabled}
            invalid={Boolean(fieldErrors.references)}
            data-test="bf-references"
          />
        </Field>

        <Field label="预算（budget）" error={fieldErrors.budget}>
          <Input
            value={draft.budget}
            onChange={(e) => set({ budget: e.target.value })}
            placeholder="50000 或 {&quot;currency&quot;:&quot;CNY&quot;}"
            disabled={disabled}
            invalid={Boolean(fieldErrors.budget)}
            data-test="bf-budget"
          />
        </Field>

        <Field label="截止日期（deadline）" error={fieldErrors.deadline}>
          <Input
            type="date"
            value={draft.deadline}
            onChange={(e) => set({ deadline: e.target.value })}
            disabled={disabled}
            invalid={Boolean(fieldErrors.deadline)}
            data-test="bf-deadline"
          />
        </Field>

        <Field label="交付物（deliverables）" error={fieldErrors.deliverables} className="sm:col-span-2">
          <Textarea
            value={draft.deliverables}
            onChange={(e) => set({ deliverables: e.target.value })}
            placeholder='["成片","海报","花絮"]'
            rows={2}
            disabled={disabled}
            invalid={Boolean(fieldErrors.deliverables)}
            data-test="bf-deliverables"
          />
        </Field>

        <Field label="限制（restrictions）" error={fieldErrors.restrictions} className="sm:col-span-2">
          <Textarea
            value={draft.restrictions}
            onChange={(e) => set({ restrictions: e.target.value })}
            placeholder='["品牌主色禁用红色","不含竞品元素"]'
            rows={2}
            disabled={disabled}
            invalid={Boolean(fieldErrors.restrictions)}
            data-test="bf-restrictions"
          />
        </Field>
      </div>
    </div>
  );
}

/** Default draft — re-exported so callers keep one source of truth. */
export { DEFAULT_DRAFT };
