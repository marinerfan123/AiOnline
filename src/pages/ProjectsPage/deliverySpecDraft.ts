// ── W1-07 — DeliverySpec onboarding form helpers ─────────────────────────────
// Pure TS (no JSX) so it can be unit-tested and reused by both the Create and
// Edit (Overview) flows. Mirrors server/modules/project-foundation/deliverySpec.cjs
// validation rules so the form never produces a payload the backend rejects.

import type {
  DeliverySpec,
  DeliverySpecWriteBody,
} from '@/shared/api/contract/delivery-spec-client';

/** The 5 platforms the backend accepts (deliverySpec.cjs PLATFORMS). */
export const DELIVERY_PLATFORMS = ['douyin', 'kuaishou', 'video', 'xhs', 'tiktok'] as const;
export type DeliveryPlatform = (typeof DELIVERY_PLATFORMS)[number];

export const PLATFORM_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'douyin', label: '抖音 Douyin' },
  { value: 'kuaishou', label: '快手 Kuaishou' },
  { value: 'video', label: '视频号 Video' },
  { value: 'xhs', label: '小红书 XHS' },
  { value: 'tiktok', label: 'TikTok' },
];

/** Draft form state. Numeric/boolean fields are kept as strings/JSON so Input
 *  components can drive them directly; converted to typed values on save. */
export interface DeliverySpecDraft {
  aspect_ratio: string;
  resolutionWidth: string;
  resolutionHeight: string;
  duration: string;
  fps: string;
  platform: DeliveryPlatform;
  subtitles: boolean;
  audio: string;
  safe_area: string;
  variants: string; // JSON text of Record<string, unknown>[]
}

/** Explicit draft defaults mirroring DEFAULT_DELIVERY_SPEC (minus version). */
export const DEFAULT_DRAFT: DeliverySpecDraft = {
  aspect_ratio: '9:16',
  resolutionWidth: '1080',
  resolutionHeight: '1920',
  duration: '30',
  fps: '30',
  platform: 'douyin',
  subtitles: true,
  audio: 'stereo',
  safe_area: '0.1',
  variants: '[]',
};

export interface DeliverySpecFormErrors {
  fields: Record<string, string>;
  global: string[];
}

const isNonNegativeFinite = (v: number) => Number.isFinite(v) && v >= 0;
const isPositiveFinite = (v: number) => Number.isFinite(v) && v > 0;

/**
 * Validate a draft and, when valid, produce the typed DeliverySpecWriteBody
 * (version is server-managed and deliberately NOT included).
 */
export function validateDraft(
  draft: DeliverySpecDraft,
): { ok: boolean; spec?: DeliverySpecWriteBody; errors?: DeliverySpecFormErrors } {
  const fields: Record<string, string> = {};
  const global: string[] = [];

  // aspect_ratio — must look like "9:16" (W:H)
  const ar = draft.aspect_ratio.trim();
  if (!/^\d+\s*:\s*\d+$/.test(String(ar))) {
    fields.aspect_ratio = '必须形如 "9:16"（宽:高）';
  }

  // resolution — positive integers
  const w = Number(draft.resolutionWidth);
  const h = Number(draft.resolutionHeight);
  if (!Number.isInteger(w) || w <= 0) fields.resolutionWidth = '必须是正整数';
  if (!Number.isInteger(h) || h <= 0) fields.resolutionHeight = '必须是正整数';

  // duration — non-negative number
  const duration = Number(draft.duration);
  if (draft.duration.trim() === '' || !isNonNegativeFinite(duration)) {
    fields.duration = '必须是非负数值';
  }

  // fps — positive number
  const fps = Number(draft.fps);
  if (draft.fps.trim() === '' || !isPositiveFinite(fps)) {
    fields.fps = '必须是正整数';
  }

  // platform — must be a supported enumeration
  if (!DELIVERY_PLATFORMS.includes(draft.platform)) {
    fields.platform = `不支持的平台，可选: ${DELIVERY_PLATFORMS.join(', ')}`;
    global.push(`不支持的平台组合: ${draft.platform}`);
  }

  // audio — non-empty string
  if (draft.audio.trim() === '') {
    fields.audio = '必须是非空字符串';
  }

  // safe_area — number in [0, 1]
  const safeArea = Number(draft.safe_area);
  if (draft.safe_area.trim() === '' || !isNonNegativeFinite(safeArea) || safeArea > 1) {
    fields.safe_area = '必须是 [0, 1] 之间的数值';
  }

  // variants — array of objects
  let variants: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(draft.variants || '[]');
    if (!Array.isArray(parsed) || parsed.some((v) => !v || typeof v !== 'object' || Array.isArray(v))) {
      throw new Error('not-array-of-objects');
    }
    variants = parsed;
  } catch {
    fields.variants = '必须是 JSON 对象数组（例如 [{"lang":"zh"}]）';
  }

  // Cross-field combination guard: resolution must be compatible with aspect_ratio.
  if (!fields.aspect_ratio && !fields.resolutionWidth && !fields.resolutionHeight) {
    const ratioMatch = String(draft.aspect_ratio.trim()).match(/^(\d+)\s*:\s*(\d+)$/);
    const rw = Number(draft.resolutionWidth);
    const rh = Number(draft.resolutionHeight);
    if (ratioMatch && Number.isInteger(rw) && rw > 0 && Number.isInteger(rh) && rh > 0) {
      const aw = Number(ratioMatch[1]);
      const ah = Number(ratioMatch[2]);
      const ratio = rw / rh;
      const target = aw / ah;
      const tolerance = 0.01;
      if (Math.abs(ratio - target) > tolerance) {
        global.push(
          `分辨率 ${rw}x${rh} 与画面比例 ${draft.aspect_ratio} 不匹配（应为约 ${aw}:${ah}）。`,
        );
      }
    }
  }

  if (Object.keys(fields).length > 0 || global.length > 0) {
    return { ok: false, errors: { fields, global } };
  }

  const spec: DeliverySpecWriteBody = {
    aspect_ratio: ar,
    resolution: { width: w, height: h },
    duration,
    fps,
    platform: draft.platform,
    subtitles: draft.subtitles,
    audio: draft.audio.trim(),
    safe_area: safeArea,
    variants,
  };
  return { ok: true, spec };
}

/** Convert a persisted DeliverySpec back into a form draft (exact echo). */
export function specToDraft(spec: DeliverySpec | DeliverySpecWriteBody | null | undefined): DeliverySpecDraft {
  const s = spec ?? ({} as DeliverySpecWriteBody);
  return {
    aspect_ratio: s.aspect_ratio ?? DEFAULT_DRAFT.aspect_ratio,
    resolutionWidth: String(s.resolution?.width ?? DEFAULT_DRAFT.resolutionWidth),
    resolutionHeight: String(s.resolution?.height ?? DEFAULT_DRAFT.resolutionHeight),
    duration: String(s.duration ?? DEFAULT_DRAFT.duration),
    fps: String(s.fps ?? DEFAULT_DRAFT.fps),
    platform: (DELIVERY_PLATFORMS as readonly string[]).includes(String(s.platform))
      ? (s.platform as DeliveryPlatform)
      : DEFAULT_DRAFT.platform,
    subtitles: typeof s.subtitles === 'boolean' ? s.subtitles : DEFAULT_DRAFT.subtitles,
    audio: s.audio ?? DEFAULT_DRAFT.audio,
    safe_area: String(s.safe_area ?? DEFAULT_DRAFT.safe_area),
    variants: JSON.stringify(s.variants ?? []),
  };
}
