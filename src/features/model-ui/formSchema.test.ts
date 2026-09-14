// L41 — ui_schema → 表单 schema 纯函数层测试（无 DOM）。
// 覆盖 4 项验收：字段类型映射 / 默认值 / 未知 x-ui hint 忽略 / advanced 折叠（分区）。
import { describe, it, expect } from 'vitest';
import {
  buildFormSchema,
  extractXuiHints,
  groupBySection,
  mapFieldType,
  X_UI_HINT_KEYS,
  type JsonSchema,
} from './formSchema';

describe('extractXuiHints — §12 白名单', () => {
  it('提取白名单内的 hint，忽略未知 hint 并报告 ignored 键名', () => {
    const { hints, ignored } = extractXuiHints({
      order: 3,
      section: 'Creative',
      advanced: true,
      default: 'x',
      units: 's',
      step: 0.5,
      min: 1,
      max: 60,
      widget: 'fancy-slider', // 未知 → 忽略
      control: 'camera', // 未知 → 忽略
      xMoling: 'no', // 禁止塞入 → 忽略
    });
    expect(hints.order).toBe(3);
    expect(hints.section).toBe('Creative');
    expect(hints.advanced).toBe(true);
    expect(hints.default).toBe('x');
    expect(hints.units).toBe('s');
    expect(hints.step).toBe(0.5);
    expect(hints.min).toBe(1);
    expect(hints.max).toBe(60);
    // 白名单 key 一个不少
    expect(Object.keys(hints).sort()).toEqual([...X_UI_HINT_KEYS].sort());
    // 未知 key 被记录为 ignored（不进入 hints）
    expect(ignored.sort()).toEqual(['control', 'widget', 'xMoling']);
  });

  it('非对象 / null / 数组输入不抛异常，返回空 hints', () => {
    for (const bad of [null, undefined, 'str', 42, ['a'], true]) {
      const { hints, ignored } = extractXuiHints(bad);
      expect(hints).toEqual({});
      expect(ignored).toEqual([]);
    }
  });
});

describe('mapFieldType — 字段类型映射（§12 六种）', () => {
  it('string → text', () => expect(mapFieldType({ type: 'string' }, {})).toBe('text'));
  it('number / integer → number（无 x-ui.step）', () => {
    expect(mapFieldType({ type: 'number' }, {})).toBe('number');
    expect(mapFieldType({ type: 'integer' }, {})).toBe('number');
  });
  it('number / integer + x-ui.step → slider', () => {
    expect(mapFieldType({ type: 'number' }, { step: 0.5 })).toBe('slider');
    expect(mapFieldType({ type: 'integer' }, { step: 1 })).toBe('slider');
  });
  it('enum 非空 → select', () => {
    expect(mapFieldType({ type: 'string', enum: ['a', 'b'] }, {})).toBe('select');
    expect(mapFieldType({ type: 'number', enum: [1, 2] }, {})).toBe('select');
  });
  it('string + format:assetRef → file', () => {
    expect(mapFieldType({ type: 'string', format: 'assetRef' }, {})).toBe('file');
  });
  it('string + format:textarea → textarea', () => {
    expect(mapFieldType({ type: 'string', format: 'textarea' }, {})).toBe('textarea');
  });
  it('enum 为空数组 → 按 type 回退（不误判为 select）', () => {
    expect(mapFieldType({ type: 'string', enum: [] }, {})).toBe('text');
  });
  it('boolean / 未知类型 → text（L41 范围外安全回退）', () => {
    expect(mapFieldType({ type: 'boolean' }, {})).toBe('text');
    expect(mapFieldType({ type: 'array' }, {})).toBe('text');
    expect(mapFieldType({}, {})).toBe('text');
  });
});

describe('buildFormSchema — 完整映射', () => {
  it('默认值：x-ui.default 覆盖 JSON Schema default；无 x-ui.default 用 schema default；都没有则 undefined', () => {
    const ui: JsonSchema = {
      properties: {
        a: { type: 'string', default: 'from-schema', 'x-ui': { order: 1 } },
        b: { type: 'number', default: 5, 'x-ui': { order: 2, default: 42 } },
        c: { type: 'string', 'x-ui': { order: 3 } },
      },
    };
    const schema = buildFormSchema(ui);
    const byKey = Object.fromEntries(schema.fields.map((f) => [f.key, f]));
    expect(byKey.a.default).toBe('from-schema'); // 无 x-ui.default
    expect(byKey.b.default).toBe(42); // x-ui.default 覆盖 schema default
    expect(byKey.c.default).toBeUndefined();
  });

  it('unknown x-ui hint 被忽略：不产生字段、不崩溃、白名单 hint 仍生效', () => {
    const ui: JsonSchema = {
      properties: {
        p: { type: 'string', 'x-ui': { order: 1, section: 'Creative', widget: 'gizmo', foo: 123 } },
      },
    };
    const schema = buildFormSchema(ui);
    expect(schema.fields).toHaveLength(1);
    const f = schema.fields[0];
    expect(f.key).toBe('p');
    expect(f.section).toBe('Creative'); // 白名单生效
    expect(f.order).toBe(1);
    expect(f.type).toBe('text'); // widget 未知 → 不回退/不改变类型映射
  });

  it('order 升序 + section 分组保序', () => {
    const ui: JsonSchema = {
      properties: {
        z: { type: 'string', 'x-ui': { order: 3, section: 'B' } },
        a: { type: 'string', 'x-ui': { order: 1, section: 'A' } },
        m: { type: 'string', 'x-ui': { order: 2, section: 'B' } },
      },
    };
    const schema = buildFormSchema(ui);
    expect(schema.fields.map((f) => f.key)).toEqual(['a', 'm', 'z']);
    expect(schema.sections).toEqual(['A', 'B']);
    const groups = groupBySection(schema.normalFields);
    expect(groups.map(([s]) => s)).toEqual(['A', 'B']);
    expect(groups.find(([s]) => s === 'B')?.[1].map((f) => f.key)).toEqual(['m', 'z']);
  });

  it('advanced 折叠：advanced=true 进 advancedFields，否则进 normalFields（§12 Basic vs Advanced）', () => {
    const ui: JsonSchema = {
      properties: {
        prompt: { type: 'textarea', format: 'textarea', 'x-ui': { order: 1, section: 'Creative' } },
        duration: { type: 'number', 'x-ui': { order: 2, section: 'Creative' } },
        seed: { type: 'integer', 'x-ui': { order: 3, advanced: true } },
        camera: { type: 'string', 'x-ui': { order: 4, advanced: true } },
      },
    };
    const schema = buildFormSchema(ui);
    expect(schema.hasAdvanced).toBe(true);
    expect(schema.normalFields.map((f) => f.key)).toEqual(['prompt', 'duration']);
    expect(schema.advancedFields.map((f) => f.key)).toEqual(['seed', 'camera']);
    expect(schema.sections).toEqual(['Creative']); // advanced 不进 sections
  });

  it('无 advanced 字段时 hasAdvanced=false，advancedFields 空', () => {
    const ui: JsonSchema = { properties: { a: { type: 'string', 'x-ui': { order: 1 } } } };
    const schema = buildFormSchema(ui);
    expect(schema.hasAdvanced).toBe(false);
    expect(schema.advancedFields).toEqual([]);
  });

  it('input_schema 作为 §11 权威：type/enum/min/max/required 生效；ui_schema 仅提供 hints', () => {
    const input: JsonSchema = {
      type: 'object',
      required: ['duration'],
      properties: {
        duration: { type: 'number', minimum: 1, maximum: 60, title: 'Duration', description: 'seconds' },
        mode: { type: 'string', enum: ['nearest', 'asset'], title: 'Transfer Mode' },
      },
    };
    const ui: JsonSchema = {
      properties: {
        duration: { 'x-ui': { order: 1, section: 'Creative', step: 1, units: 's' } },
        mode: { 'x-ui': { order: 2, section: 'Creative' } },
      },
    };
    const schema = buildFormSchema(ui, input);
    const byKey = Object.fromEntries(schema.fields.map((f) => [f.key, f]));
    expect(byKey.duration.type).toBe('slider'); // number + x-ui.step
    expect(byKey.duration.min).toBe(1); // JSON Schema minimum
    expect(byKey.duration.max).toBe(60);
    expect(byKey.duration.required).toBe(true);
    expect(byKey.duration.label).toBe('Duration');
    expect(byKey.duration.description).toBe('seconds');
    expect(byKey.mode.type).toBe('select'); // enum 权威来自 input_schema
    expect(byKey.mode.options).toEqual(['nearest', 'asset']);
  });

  it('x-ui.min/max/step 覆盖 JSON Schema minimum/maximum', () => {
    const input: JsonSchema = { properties: { n: { type: 'number', minimum: 0, maximum: 10 } } };
    const ui: JsonSchema = { properties: { n: { 'x-ui': { order: 1, min: -5, max: 50 } } } };
    const schema = buildFormSchema(ui, input);
    const f = schema.fields[0];
    expect(f.min).toBe(-5);
    expect(f.max).toBe(50);
    expect(f.type).toBe('number'); // 无 step → number
  });
});
