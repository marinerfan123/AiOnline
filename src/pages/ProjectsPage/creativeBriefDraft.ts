// ── W1-06 — Creative Brief onboarding form helpers ─────────────────────────────
// Pure TS (no JSX) so it can be unit-tested and reused by both the Create and
// Edit (Overview) flows. Mirrors server/modules/project-foundation/creativeBrief.cjs
// validation rules so the form never produces a payload the backend rejects.
//
// The 16 Brief fields (W1-01 acceptance): goal, audience, platform, duration,
//   aspect_ratio, language, key_message, cta, brand, tone, style, references,
//   budget, deadline, deliverables, restrictions.
// goal + audience are required by the backend when the brief is provided; the
// rest are optional. We therefore only include an optional field in the output
// when it is non-empty, since the backend rejects empty-string optional fields
// (e.g. `language: ""` → "language must be a non-empty string").

import type { CreativeBrief } from '@/shared/api/contract/schemas';

/** The 5 platforms the backend accepts (creativeBrief.cjs PLATFORMS). */
export const BRIEF_PLATFORMS = ['douyin', 'kuaishou', 'video', 'xhs', 'tiktok'] as const;
export type BriefPlatform = (typeof BRIEF_PLATFORMS)[number];

export const PLATFORM_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'douyin', label: '抖音 Douyin' },
  { value: 'kuaishou', label: '快手 Kuaishou' },
  { value: 'video', label: '视频号 Video' },
  { value: 'xhs', label: '小红书 XHS' },
  { value: 'tiktok', label: 'TikTok' },
];

/** Draft form state. Every field is kept as a string so Input/Textarea
 *  components drive it directly; array/object fields are JSON text. Converted to
 *  typed values on save. */
export interface CreativeBriefDraft {
  goal: string;
  audience: string;
  platform: string;
  duration: string; // seconds
  aspect_ratio: string; // e.g. "9:16"
  language: string;
  key_message: string;
  cta: string;
  brand: string;
  tone: string; // JSON: string OR array of strings
  style: string; // JSON: string OR array of strings
  references: string; // JSON array of strings or objects
  budget: string; // number text OR JSON object
  deadline: string; // ISO/date text
  deliverables: string; // JSON array of strings
  restrictions: string; // JSON array of strings
}

/** Explicit draft defaults. Empty sentinel ('') means "not set yet" → omitted
 *  from the persisted brief; aspect_ratio defaults to the common 9:16 while the
 *  array fields default to an empty (valid) JSON array. */
export const DEFAULT_DRAFT: CreativeBriefDraft = {
  goal: '',
  audience: '',
  platform: '',
  duration: '',
  aspect_ratio: '9:16',
  language: '',
  key_message: '',
  cta: '',
  brand: '',
  tone: '',
  style: '',
  references: '[]',
  budget: '',
  deadline: '',
  deliverables: '[]',
  restrictions: '[]',
};

export interface CreativeBriefFormErrors {
  fields: Record<string, string>;
  global: string[];
}

const isBlank = (v: string) => v.trim() === '';
const isNonNegativeFinite = (x: number) => Number.isFinite(x) && x >= 0;

/** Parse JSON array of strings (deliverables / restrictions). */
function parseStringArray(text: string): string[] | null {
  try {
    const p = JSON.parse(text);
    if (Array.isArray(p) && p.every((x) => typeof x === 'string')) return p;
    return null;
  } catch {
    return null;
  }
}

/** Parse tone/style → a plain string OR an array of strings. A non-JSON value is
 *  treated as a single string (matches creativeBrief.cjs `isNonEmptyString`). */
function parseStringOrArray(text: string): string | string[] | null {
  try {
    const p = JSON.parse(text);
    if (Array.isArray(p) && p.every((x) => typeof x === 'string')) return p;
    if (typeof p === 'string' && p.trim() !== '') return p;
    return null; // object / number / empty — invalid for tone/style
  } catch {
    return text.trim() === '' ? null : text.trim();
  }
}

/** Parse references → array of strings or objects. */
function parseReferences(text: string): Array<string | Record<string, unknown>> | null {
  try {
    const p = JSON.parse(text);
    if (!Array.isArray(p)) return null;
    const ok = p.every(
      (x) => typeof x === 'string' || (x && typeof x === 'object' && !Array.isArray(x)),
    );
    if (!ok) return null;
    return p;
  } catch {
    return null;
  }
}

/**
 * Validate a draft and, when valid, produce the typed CreativeBrief write body.
 * Optional fields that are empty are omitted (the backend rejects empty strings
 * for optional string fields); unsupported combinations (platform) are reported
 * both at the field and a clear global message.
 */
export function validateDraft(
  draft: CreativeBriefDraft,
): { ok: boolean; brief?: CreativeBrief; errors?: CreativeBriefFormErrors } {
  const fields: Record<string, string> = {};
  const global: string[] = [];
  const brief: CreativeBrief = {};

  // goal — required
  const goal = draft.goal.trim();
  if (goal === '') {
    fields.goal = '目标（goal）为必填项，不能为空';
  } else {
    brief.goal = goal;
  }

  // audience — required
  const audience = draft.audience.trim();
  if (audience === '') {
    fields.audience = '受众（audience）为必填项，不能为空';
  } else {
    brief.audience = audience;
  }

  // platform — optional but must be a supported enumeration when set
  const platform = draft.platform.trim();
  if (platform !== '') {
    if (!(BRIEF_PLATFORMS as readonly string[]).includes(platform)) {
      fields.platform = `不支持的平台，可选: ${BRIEF_PLATFORMS.join(', ')}`;
      global.push(`不支持的平台组合: ${platform}`);
    } else {
      brief.platform = platform;
    }
  }

  // duration — optional non-negative number (seconds)
  const duration = draft.duration.trim();
  if (duration !== '') {
    const d = Number(duration);
    if (isNonNegativeFinite(d)) {
      brief.duration = d;
    } else {
      fields.duration = '时长（duration）必须是非负数值（秒）';
    }
  }

  // aspect_ratio — optional, must look like "9:16" (W:H)
  const ar = draft.aspect_ratio.trim();
  if (ar !== '') {
    if (/^\d+\s*:\s*\d+$/.test(ar)) {
      brief.aspect_ratio = ar;
    } else {
      fields.aspect_ratio = '画面比例（aspect_ratio）必须形如 "9:16"（宽:高）';
    }
  }

  // language / key_message / cta / brand — optional non-empty strings
  const language = draft.language.trim();
  if (language !== '') brief.language = language;
  const keyMessage = draft.key_message.trim();
  if (keyMessage !== '') brief.key_message = keyMessage;
  const cta = draft.cta.trim();
  if (cta !== '') brief.cta = cta;
  const brand = draft.brand.trim();
  if (brand !== '') brief.brand = brand;

  // tone / style — string or array of strings
  const tone = draft.tone.trim();
  if (tone !== '') {
    const t = parseStringOrArray(tone);
    if (t === null) fields.tone = '基调（tone）应为字符串或字符串数组（例如 俏皮 或 ["俏皮","活力"]）';
    else brief.tone = t;
  }
  const style = draft.style.trim();
  if (style !== '') {
    const s = parseStringOrArray(style);
    if (s === null) fields.style = '风格（style）应为字符串或字符串数组（例如 国风 或 ["国风","水墨"]）';
    else brief.style = s;
  }

  // references — array of strings or objects (only sent when non-empty & not "[]")
  const refs = draft.references.trim();
  if (refs !== '' && refs !== '[]') {
    const r = parseReferences(refs);
    if (r === null) fields.references = '参考（references）应为字符串或对象数组，例如 ["url1","url2"]';
    else brief.references = r;
  }

  // budget — non-negative number OR object
  const budget = draft.budget.trim();
  if (budget !== '') {
    const num = Number(budget);
    if (isNonNegativeFinite(num)) {
      brief.budget = num;
    } else {
      try {
        const p = JSON.parse(budget);
        if (p && typeof p === 'object' && !Array.isArray(p)) brief.budget = p;
        else fields.budget = '预算（budget）应为非负数值或 JSON 对象';
      } catch {
        fields.budget = '预算（budget）应为非负数值或 JSON 对象';
      }
    }
  }

  // deadline — ISO date
  const deadline = draft.deadline.trim();
  if (deadline !== '') {
    const dt = new Date(deadline);
    if (Number.isNaN(dt.getTime())) {
      fields.deadline = '截止日期（deadline）必须为合法日期（如 2026-09-03）';
    } else {
      brief.deadline = dt.toISOString();
    }
  }

  // deliverables — array of strings
  const deliv = draft.deliverables.trim();
  if (deliv !== '' && deliv !== '[]') {
    const arr = parseStringArray(deliv);
    if (arr === null) fields.deliverables = '交付物（deliverables）应为字符串数组，例如 ["成片","海报"]';
    else brief.deliverables = arr;
  }

  // restrictions — array of strings
  const restr = draft.restrictions.trim();
  if (restr !== '' && restr !== '[]') {
    const arr = parseStringArray(restr);
    if (arr === null) fields.restrictions = '限制（restrictions）应为字符串数组，例如 ["品牌色禁用红色"]';
    else brief.restrictions = arr;
  }

  if (Object.keys(fields).length > 0 || global.length > 0) {
    return { ok: false, errors: { fields, global } };
  }
  return { ok: true, brief };
}

/** Serialize tone/style draft text from a persisted string-or-array value. */
const stringifyStringOrArray = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? JSON.stringify(v) : v ?? '';

/**
 * Convert a persisted CreativeBrief (from projects.creative_brief) back into a
 * form draft (exact echo). Unknown/missing fields fall back to DEFAULT_DRAFT.
 */
export function briefToDraft(brief: CreativeBrief | null | undefined): CreativeBriefDraft {
  const b = brief ?? {};
  const platformVal = Array.isArray(b.platform) ? b.platform[0] : b.platform;
  return {
    goal: b.goal ?? DEFAULT_DRAFT.goal,
    audience: b.audience ?? DEFAULT_DRAFT.audience,
    platform: (BRIEF_PLATFORMS as readonly string[]).includes(String(platformVal ?? ''))
      ? String(platformVal)
      : DEFAULT_DRAFT.platform,
    duration: b.duration !== undefined ? String(b.duration) : DEFAULT_DRAFT.duration,
    aspect_ratio: b.aspect_ratio ?? DEFAULT_DRAFT.aspect_ratio,
    language: b.language ?? DEFAULT_DRAFT.language,
    key_message: b.key_message ?? DEFAULT_DRAFT.key_message,
    cta: b.cta ?? DEFAULT_DRAFT.cta,
    brand:
      typeof b.brand === 'object' && b.brand !== null
        ? JSON.stringify(b.brand)
        : b.brand !== undefined
          ? String(b.brand)
          : DEFAULT_DRAFT.brand,
    tone: stringifyStringOrArray(b.tone),
    style: stringifyStringOrArray(b.style),
    references: JSON.stringify(b.references ?? []),
    budget:
      typeof b.budget === 'object' && b.budget !== null
        ? JSON.stringify(b.budget)
        : b.budget !== undefined
          ? String(b.budget)
          : DEFAULT_DRAFT.budget,
    deadline: b.deadline ?? DEFAULT_DRAFT.deadline,
    deliverables: JSON.stringify(b.deliverables ?? []),
    restrictions: JSON.stringify(b.restrictions ?? []),
  };
}
