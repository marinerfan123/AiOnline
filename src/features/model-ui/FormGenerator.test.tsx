// @vitest-environment jsdom
// L41 — FormGenerator 渲染层测试：字段渲染 + advanced 折叠（默认收起 → 展开）。
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, configure } from '@testing-library/react';
import { FormGenerator } from './FormGenerator';
import { buildFormSchema, type JsonSchema } from './formSchema';

// 本仓库组件统一用 `data-test`（非 data-testid）；RTL 默认只匹配 data-testid。
configure({ testIdAttribute: 'data-test' });

afterEach(cleanup);

const schema = buildFormSchema({
  type: 'object',
  properties: {
    prompt: { type: 'string', format: 'textarea', title: 'Prompt', 'x-ui': { order: 1, section: 'Creative' } },
    mode: { type: 'string', enum: ['nearest', 'asset'], title: 'Transfer Mode', 'x-ui': { order: 2, section: 'Creative' } },
    duration: { type: 'number', title: 'Duration', 'x-ui': { order: 3, section: 'Creative', step: 1, min: 1, max: 60, units: 's' } },
    refImage: { type: 'string', format: 'assetRef', title: 'Reference Image', 'x-ui': { order: 4, section: 'Creative' } },
    seed: { type: 'integer', title: 'Seed', 'x-ui': { order: 5, advanced: true } },
    negative: { type: 'string', format: 'textarea', title: 'Negative Prompt', 'x-ui': { order: 6, advanced: true } },
  },
} as JsonSchema);

describe('FormGenerator — 渲染', () => {
  it('按 section 渲染 normal 字段（含 select/slider/textarea/file 控件）', () => {
    render(<FormGenerator schema={schema} />);
    expect(screen.getByTestId('form-generator')).toBeTruthy();
    expect(screen.getByTestId('form-generator-section-Creative')).toBeTruthy();
    // textarea（prompt）
    expect(screen.getByTestId('form-field-prompt').tagName).toBe('TEXTAREA');
    // select（mode：enum）
    const mode = screen.getByTestId('form-field-mode');
    expect(mode.tagName).toBe('SELECT');
    expect(screen.getByRole('option', { name: 'nearest' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'asset' })).toBeTruthy();
    // slider（duration：number + step）
    expect(screen.getByTestId('form-field-duration').getAttribute('type')).toBe('range');
    // file（refImage：assetRef 占位按钮，未接线）
    const ref = screen.getByTestId('form-field-refImage');
    expect(ref.tagName).toBe('BUTTON');
    expect(ref.textContent).toContain('未接线');
  });

  it('advanced 默认折叠：advanced 字段不可见', () => {
    render(<FormGenerator schema={schema} />);
    expect(screen.queryByTestId('form-field-seed')).toBeNull();
    expect(screen.queryByTestId('form-field-negative')).toBeNull();
    expect(screen.queryByTestId('form-generator-advanced')).toBeNull();
  });

  it('点击 toggle 展开 advanced 字段，再次点击收起', () => {
    render(<FormGenerator schema={schema} />);
    const toggle = screen.getByTestId('form-generator-advanced-toggle');
    fireEvent.click(toggle);
    expect(screen.getByTestId('form-generator-advanced')).toBeTruthy();
    expect(screen.getByTestId('form-field-seed')).toBeTruthy();
    expect(screen.getByTestId('form-field-negative')).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByTestId('form-field-seed')).toBeNull();
  });

  it('默认值回填：values 缺省时用 field.default，onChange 上报新值', () => {
    const withDefault = buildFormSchema({
      type: 'object',
      properties: {
        title: { type: 'string', title: 'Title', 'x-ui': { order: 1, default: 'hello' } },
      },
    } as JsonSchema);
    let lastKey = '';
    let lastValue: unknown;
    render(<FormGenerator schema={withDefault} onChange={(k, v) => { lastKey = k; lastValue = v; }} />);
    const input = screen.getByTestId('form-field-title') as HTMLInputElement;
    expect(input.value).toBe('hello'); // default 回填
    fireEvent.change(input, { target: { value: 'world' } });
    expect(lastKey).toBe('title');
    expect(lastValue).toBe('world');
  });
});
