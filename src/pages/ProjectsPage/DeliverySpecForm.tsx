// ── W1-07 — DeliverySpec onboarding form (visible fields + validation) ──────
// A controlled, reusable form for the 9 DeliverySpec fields:
//   aspect_ratio, resolution (w+h), duration, fps, platform, subtitles,
//   audio, safe_area, variants.
// Used by CreateProjectPage (staged before project exists) and the project
// Overview (edit + exact echo). Mirrors the backend deliverySpec.cjs rules so
// the form never submits a payload the server rejects.

import { type ReactNode } from 'react';
import { Input, Textarea } from '@/shared/ui/v2/Input';
import { Select } from '@/shared/ui/v2/Select';
import { cn } from '@/lib/utils';
import {
  type DeliverySpecDraft,
  type DeliveryPlatform,
  type DeliverySpecFormErrors,
  DEFAULT_DRAFT,
  PLATFORM_OPTIONS,
} from './deliverySpecDraft';

interface DeliverySpecFormProps {
  /** Controlled draft state. */
  draft: DeliverySpecDraft;
  /** Draft change handler — parent owns the state. */
  onChange: (draft: DeliverySpecDraft) => void;
  /** Field/global validation errors (optional). */
  errors?: DeliverySpecFormErrors;
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

export function DeliverySpecForm({ draft, onChange, errors, disabled }: DeliverySpecFormProps) {
  const fieldErrors = errors?.fields ?? {};
  const global = errors?.global ?? [];

  const set = (patch: Partial<DeliverySpecDraft>) => onChange({ ...draft, ...patch });

  return (
    <div className="space-y-4" data-test="delivery-spec-form">
      {global.length > 0 && (
        <div
          data-test="delivery-spec-global-errors"
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
        <Field label="画面比例" required error={fieldErrors.aspect_ratio}>
          <Input
            value={draft.aspect_ratio}
            onChange={(e) => set({ aspect_ratio: e.target.value })}
            placeholder="9:16"
            disabled={disabled}
            invalid={Boolean(fieldErrors.aspect_ratio)}
            data-test="ds-aspect-ratio"
          />
        </Field>

        <Field label="发布平台" required error={fieldErrors.platform}>
          <Select
            value={draft.platform}
            onValueChange={(v) => set({ platform: v as DeliveryPlatform })}
            options={PLATFORM_OPTIONS}
            placeholder="选择平台"
            disabled={disabled}
            className="w-full"
          />
        </Field>

        <Field label="分辨率宽" required error={fieldErrors.resolutionWidth}>
          <Input
            type="number"
            min={1}
            value={draft.resolutionWidth}
            onChange={(e) => set({ resolutionWidth: e.target.value })}
            placeholder="1080"
            disabled={disabled}
            invalid={Boolean(fieldErrors.resolutionWidth)}
            data-test="ds-resolution-width"
          />
        </Field>

        <Field label="分辨率高" required error={fieldErrors.resolutionHeight}>
          <Input
            type="number"
            min={1}
            value={draft.resolutionHeight}
            onChange={(e) => set({ resolutionHeight: e.target.value })}
            placeholder="1920"
            disabled={disabled}
            invalid={Boolean(fieldErrors.resolutionHeight)}
            data-test="ds-resolution-height"
          />
        </Field>

        <Field label="时长（秒）" required error={fieldErrors.duration}>
          <Input
            type="number"
            min={0}
            step="any"
            value={draft.duration}
            onChange={(e) => set({ duration: e.target.value })}
            placeholder="30"
            disabled={disabled}
            invalid={Boolean(fieldErrors.duration)}
            data-test="ds-duration"
          />
        </Field>

        <Field label="帧率（fps）" required error={fieldErrors.fps}>
          <Input
            type="number"
            min={1}
            step="any"
            value={draft.fps}
            onChange={(e) => set({ fps: e.target.value })}
            placeholder="30"
            disabled={disabled}
            invalid={Boolean(fieldErrors.fps)}
            data-test="ds-fps"
          />
        </Field>

        <Field label="字幕" error={fieldErrors.subtitles}>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ml2-text">
            <input
              type="checkbox"
              checked={draft.subtitles}
              disabled={disabled}
              onChange={(e) => set({ subtitles: e.target.checked })}
              className="size-4 accent-ml2-accent"
              data-test="ds-subtitles"
            />
            生成视频内嵌字幕
          </label>
        </Field>

        <Field label="音频" required error={fieldErrors.audio}>
          <Input
            value={draft.audio}
            onChange={(e) => set({ audio: e.target.value })}
            placeholder="stereo / 立体声"
            disabled={disabled}
            invalid={Boolean(fieldErrors.audio)}
            data-test="ds-audio"
          />
        </Field>

        <Field label="安全区（0-1）" required error={fieldErrors.safe_area}>
          <Input
            type="number"
            min={0}
            max={1}
            step="any"
            value={draft.safe_area}
            onChange={(e) => set({ safe_area: e.target.value })}
            placeholder="0.1"
            disabled={disabled}
            invalid={Boolean(fieldErrors.safe_area)}
            data-test="ds-safe-area"
          />
        </Field>

        <Field label="变体（JSON 对象数组）" error={fieldErrors.variants}>
          <Textarea
            value={draft.variants}
            onChange={(e) => set({ variants: e.target.value })}
            placeholder='[{"lang":"zh"},{"aspect_ratio":"1:1"}]'
            rows={3}
            disabled={disabled}
            invalid={Boolean(fieldErrors.variants)}
            data-test="ds-variants"
          />
        </Field>
      </div>
    </div>
  );
}

/** Default draft — re-exported so callers keep one source of truth. */
export { DEFAULT_DRAFT };
