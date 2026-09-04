// ── Model UI — ui_schema 驱动的 Schema→Form 生成器（L41 纯函数层）─────────
//
// 规范锚点（墨渊 V2.0 §10-12）：
//   - §10   schema 不负责所有事情：input_schema / ui_schema / semantic_map /
//           capability_descriptor 四份分离；禁止塞 `x-moling-*`。
//   - §11   input_schema（JSON Schema Draft 2020-12）是 type/required/enum/
//           min-max 的服务器验证最终权威。
//   - §12   ui_schema 负责显示顺序 / 分组 / 控件提示 / Basic vs Advanced。
//
// 本模块是 ui_schema → 表单字段 的纯映射（无 React、无 I/O、不抛异常）：
//   buildFormSchema(uiSchema, inputSchema?) → { fields, normalFields,
//   advancedFields, sections, hasAdvanced }
//
// x-ui hint 白名单（§12，其它 key 一律忽略）：
//   order（排序） / section（分组） / advanced（折叠进 Advanced） /
//   default（默认值，覆盖 JSON Schema default） / units（单位后缀） /
//   step / min / max（slider 与 number 的步进/边界，覆盖 JSON Schema minimum/maximum）
//
// 字段类型映射（6 种，§12 支持面）：
//   string                      → text
//   number / integer            → number（x-ui.step 存在时 → slider）
//   enum 非空                   → select
//   string + format:"textarea"  → textarea
//   string + format:"assetRef"  → file（资产引用；picker 接线留 L42/L46）
//   其它（boolean/array/null）  → text（L41 范围外，安全回退）

export type FormFieldType = 'text' | 'number' | 'select' | 'slider' | 'textarea' | 'file';

/** §12 x-ui hint 白名单。此集合之外的 x-ui key 一律忽略（测试覆盖）。 */
export const X_UI_HINT_KEYS = ['order', 'section', 'advanced', 'default', 'units', 'step', 'min', 'max'] as const;

export type XUiHintKey = (typeof X_UI_HINT_KEYS)[number];

/** 宽容的 JSON Schema 片段（2020-12 动态，本模块只读关心的关键字）。 */
export interface JsonSchemaProperty {
  type?: string;
  format?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  /** §12 x-ui hints；白名单外的 key 被 extractXuiHints 忽略。 */
  'x-ui'?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  [k: string]: unknown;
}

export interface FormField {
  key: string;
  label: string;
  description?: string;
  type: FormFieldType;
  required: boolean;
  /** 默认值：x-ui.default ?? JSON Schema default。 */
  default?: unknown;
  /** 分组名，缺省 'General'。 */
  section: string;
  /** §12 Basic vs Advanced；true 折叠进 Advanced 区。 */
  advanced: boolean;
  /** 全局显示顺序（x-ui.order ?? 属性出现序）。 */
  order: number;
  units?: string;
  step?: number;
  min?: number;
  max?: number;
  /** select 的枚举候选值（enum 原样透传）。 */
  options?: unknown[];
  /** file 字段：true 表示 assetRef 资产引用。 */
  assetRef?: boolean;
}

export interface FormSchema {
  /** 全字段（按 order 升序，稳定）。 */
  fields: FormField[];
  /** advanced === false 的字段（按 order）。 */
  normalFields: FormField[];
  /** advanced === true 的字段（按 order）。 */
  advancedFields: FormField[];
  /** normalFields 的分组名（按首次出现序，去重）。 */
  sections: string[];
  hasAdvanced: boolean;
}

const DEFAULT_SECTION = 'General';

/** 提取 x-ui 白名单 hints；返回 { hints, ignored }（ignored 供测试断言未知 hint 被忽略）。 */
export function extractXuiHints(rawXui: unknown): { hints: Partial<Record<XUiHintKey, unknown>>; ignored: string[] } {
  const hints: Partial<Record<XUiHintKey, unknown>> = {};
  const ignored: string[] = [];
  if (rawXui && typeof rawXui === 'object' && !Array.isArray(rawXui)) {
    for (const [k, v] of Object.entries(rawXui as Record<string, unknown>)) {
      if ((X_UI_HINT_KEYS as readonly string[]).includes(k)) hints[k as XUiHintKey] = v;
      else ignored.push(k);
    }
  }
  return { hints, ignored };
}

/** 数字提示 → number | undefined（容忍 string / NaN，非法值回退 undefined）。 */
function toNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function toBool(v: unknown): boolean {
  return v === true;
}

/**
 * 单个属性 → 字段类型（§12 映射表）。
 * 优先级：enum → assetRef → textarea → number/slider → text。
 */
export function mapFieldType(schemaProp: JsonSchemaProperty | undefined, xuiHints: Partial<Record<XUiHintKey, unknown>>): FormFieldType {
  const prop = schemaProp ?? {};
  const hasEnum = Array.isArray(prop.enum) && prop.enum.length > 0;
  if (hasEnum) return 'select';
  if (prop.type === 'string' && prop.format === 'assetRef') return 'file';
  if (prop.type === 'string' && prop.format === 'textarea') return 'textarea';
  if (prop.type === 'number' || prop.type === 'integer') {
    // x-ui.step 存在 → slider（滑块）；否则普通 number 输入。
    return toNumber(xuiHints.step) !== undefined ? 'slider' : 'number';
  }
  if (prop.type === 'string') return 'text';
  // boolean / array / null / 未知类型：L41 范围外，安全回退 text。
  return 'text';
}

/** 合并 ui_schema 与（可选）input_schema 的属性源 + 提取 hints。 */
function resolveProperty(key: string, uiSchema: JsonSchema, inputSchema?: JsonSchema): {
  prop: JsonSchemaProperty;
  hints: Partial<Record<XUiHintKey, unknown>>;
  ignored: string[];
} {
  const inputProp = inputSchema?.properties?.[key];
  const uiProp = uiSchema.properties?.[key];
  // §11：type/enum/min/max/default 权威来自 input_schema（若给）；无 input_schema 时
  // ui_schema 自身即 JSON Schema 源。浅拷贝，避免改写调用方传入的 schema 对象。
  const base: JsonSchemaProperty = inputProp ? { ...inputProp } : uiProp ? { ...uiProp } : {};
  // title/description：input_schema 优先，回退 ui_schema（不覆盖 type 等权威关键字）。
  if (inputProp && uiProp) {
    base.title = inputProp.title ?? uiProp.title;
    base.description = inputProp.description ?? uiProp.description;
  }
  // x-ui hints：ui_schema 优先，回退 input_schema 上的 x-ui（兼容单 schema 自包含）。
  const rawXui = uiProp?.['x-ui'] ?? inputProp?.['x-ui'];
  const { hints, ignored } = extractXuiHints(rawXui);
  return { prop: base, hints, ignored };
}

/**
 * ui_schema → 表单 schema 的纯映射。
 * @param uiSchema   §12 UI schema（JSON Schema + x-ui hints）；字段迭代顺序来源。
 * @param inputSchema 可选 §11 输入 schema（type/enum/min-max 权威）。
 */
export function buildFormSchema(uiSchema: JsonSchema, inputSchema?: JsonSchema): FormSchema {
  const uiProps = uiSchema?.properties ?? {};
  const inputProps = inputSchema?.properties ?? {};
  const keys: string[] = [];
  const seen = new Set<string>();
  // 键并集，保序（ui_schema 顺序优先，input_schema 补充未覆盖键）。
  for (const k of [...Object.keys(uiProps), ...Object.keys(inputProps)]) {
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }

  const required = new Set<string>([...(inputSchema?.required ?? []), ...(uiSchema?.required ?? [])]);

  const fields: FormField[] = keys.map((key, index) => {
    const { prop, hints } = resolveProperty(key, uiSchema, inputSchema);
    const type = mapFieldType(prop, hints);

    const step = toNumber(hints.step) ?? undefined;
    const min = toNumber(hints.min) ?? toNumber(prop.minimum);
    const max = toNumber(hints.max) ?? toNumber(prop.maximum);

    return {
      key,
      label: prop.title ?? key,
      description: prop.description,
      type,
      required: required.has(key),
      // 默认值：x-ui.default 覆盖 JSON Schema default。
      default: hints.default !== undefined ? hints.default : prop.default,
      section: typeof hints.section === 'string' && hints.section.trim() ? hints.section : DEFAULT_SECTION,
      advanced: toBool(hints.advanced),
      order: toNumber(hints.order) ?? index,
      units: typeof hints.units === 'string' ? hints.units : undefined,
      step,
      min,
      max,
      options: type === 'select' && Array.isArray(prop.enum) ? prop.enum : undefined,
      assetRef: type === 'file',
    };
  });

  // order 升序，稳定（同 order 保持键出现序）。
  const ordered = [...fields].sort((a, b) => a.order - b.order);
  const normalFields = ordered.filter((f) => !f.advanced);
  const advancedFields = ordered.filter((f) => f.advanced);

  const sections: string[] = [];
  for (const f of normalFields) if (!sections.includes(f.section)) sections.push(f.section);

  return {
    fields: ordered,
    normalFields,
    advancedFields,
    sections,
    hasAdvanced: advancedFields.length > 0,
  };
}

/** 便捷：把 normalFields 按 section 分桶（保序），供渲染层直接消费。 */
export function groupBySection(fields: FormField[]): [string, FormField[]][] {
  const groups = new Map<string, FormField[]>();
  for (const f of fields) {
    const list = groups.get(f.section);
    if (list) list.push(f);
    else groups.set(f.section, [f]);
  }
  return [...groups.entries()];
}
