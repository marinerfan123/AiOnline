// @vitest-environment jsdom
// W1-06 — Creative Brief onboarding form: all 16 fields visible + editable + errors.
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup, fireEvent, configure } from '@testing-library/react';
import { useState } from 'react';
import { BriefForm } from './BriefForm';
import { DEFAULT_DRAFT, type CreativeBriefDraft, type CreativeBriefFormErrors } from './creativeBriefDraft';

// This repo's components use `data-test` (not `data-testid`) — match that here.
configure({ testIdAttribute: 'data-test' });

afterEach(cleanup);

function Harness({
  initial = DEFAULT_DRAFT,
  errors,
  disabled,
}: {
  initial?: CreativeBriefDraft;
  errors?: CreativeBriefFormErrors;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<CreativeBriefDraft>(initial);
  return <BriefForm draft={draft} onChange={setDraft} errors={errors} disabled={disabled} />;
}

describe('W1-06 BriefForm', () => {
  it('renders all 16 editable fields', () => {
    render(<Harness />);
    expect(screen.getByTestId('bf-goal')).toBeTruthy();
    expect(screen.getByTestId('bf-audience')).toBeTruthy();
    expect(screen.getByTestId('bf-duration')).toBeTruthy();
    expect(screen.getByTestId('bf-aspect-ratio')).toBeTruthy();
    expect(screen.getByTestId('bf-language')).toBeTruthy();
    expect(screen.getByTestId('bf-key-message')).toBeTruthy();
    expect(screen.getByTestId('bf-cta')).toBeTruthy();
    expect(screen.getByTestId('bf-brand')).toBeTruthy();
    expect(screen.getByTestId('bf-tone')).toBeTruthy();
    expect(screen.getByTestId('bf-style')).toBeTruthy();
    expect(screen.getByTestId('bf-references')).toBeTruthy();
    expect(screen.getByTestId('bf-budget')).toBeTruthy();
    expect(screen.getByTestId('bf-deadline')).toBeTruthy();
    expect(screen.getByTestId('bf-deliverables')).toBeTruthy();
    expect(screen.getByTestId('bf-restrictions')).toBeTruthy();
    // platform is rendered as a Radix Select trigger button
    expect(screen.getByRole('combobox')).toBeTruthy();
  });

  it('pre-fills the persisted values (exact echo)', () => {
    render(
      <Harness
        initial={{
          goal: '夏日饮品',
          audience: '18-30 青年',
          platform: 'tiktok',
          duration: '15',
          aspect_ratio: '1:1',
          language: 'zh-CN',
          key_message: '清爽一夏',
          cta: '立即购买',
          brand: 'Aqua',
          tone: '["俏皮","活力"]',
          style: '国风',
          references: '["https://a.com"]',
          budget: '50000',
          deadline: '2026-09-03',
          deliverables: '["成片"]',
          restrictions: '["禁用红色"]',
        }}
      />,
    );
    expect((screen.getByTestId('bf-goal') as HTMLTextAreaElement).value).toBe('夏日饮品');
    expect((screen.getByTestId('bf-audience') as HTMLTextAreaElement).value).toBe('18-30 青年');
    expect((screen.getByTestId('bf-duration') as HTMLInputElement).value).toBe('15');
    expect((screen.getByTestId('bf-aspect-ratio') as HTMLInputElement).value).toBe('1:1');
    expect((screen.getByTestId('bf-language') as HTMLInputElement).value).toBe('zh-CN');
    expect((screen.getByTestId('bf-key-message') as HTMLTextAreaElement).value).toBe('清爽一夏');
    expect((screen.getByTestId('bf-cta') as HTMLInputElement).value).toBe('立即购买');
    expect((screen.getByTestId('bf-brand') as HTMLInputElement).value).toBe('Aqua');
    expect((screen.getByTestId('bf-tone') as HTMLInputElement).value).toBe('["俏皮","活力"]');
    expect((screen.getByTestId('bf-style') as HTMLInputElement).value).toBe('国风');
    expect((screen.getByTestId('bf-references') as HTMLTextAreaElement).value).toBe('["https://a.com"]');
    expect((screen.getByTestId('bf-budget') as HTMLInputElement).value).toBe('50000');
    expect((screen.getByTestId('bf-deadline') as HTMLInputElement).value).toBe('2026-09-03');
    expect((screen.getByTestId('bf-deliverables') as HTMLTextAreaElement).value).toBe('["成片"]');
    expect((screen.getByTestId('bf-restrictions') as HTMLTextAreaElement).value).toBe('["禁用红色"]');
    // platform select is controlled to tiktok
    expect(screen.getByRole('combobox').textContent).toContain('TikTok');
  });

  it('fires onChange when a field is edited', () => {
    render(<Harness />);
    const input = screen.getByTestId('bf-duration') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '45' } });
    expect(input.value).toBe('45');
  });

  it('shows global rejection messages', () => {
    render(<Harness errors={{ fields: {}, global: ['不支持的平台组合: youtube'] }} />);
    expect(screen.getByTestId('brief-global-errors').textContent).toContain('不支持的平台组合');
  });

  it('shows a field-level error', () => {
    render(<Harness errors={{ fields: { goal: '目标（goal）为必填项，不能为空' }, global: [] }} />);
    expect(screen.getByText('目标（goal）为必填项，不能为空')).toBeTruthy();
    expect((screen.getByTestId('bf-goal') as HTMLTextAreaElement).getAttribute('aria-invalid')).toBe('true');
  });

  it('disables all inputs when read-only', () => {
    render(<Harness disabled />);
    expect((screen.getByTestId('bf-goal') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByTestId('bf-duration') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('combobox') as HTMLButtonElement).disabled).toBe(true);
  });
});
