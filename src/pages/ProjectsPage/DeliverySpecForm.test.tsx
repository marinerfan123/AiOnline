// @vitest-environment jsdom
// W1-07 — DeliverySpec onboarding form: all 9 fields visible + editable + errors.
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup, fireEvent, configure } from '@testing-library/react';
import { useState } from 'react';
import { DeliverySpecForm } from './DeliverySpecForm';
import { DEFAULT_DRAFT, type DeliverySpecDraft, type DeliverySpecFormErrors } from './deliverySpecDraft';

// This repo's components use `data-test` (not `data-testid`) — match that here.
configure({ testIdAttribute: 'data-test' });

afterEach(cleanup);

function Harness({
  initial = DEFAULT_DRAFT,
  errors,
  disabled,
}: {
  initial?: DeliverySpecDraft;
  errors?: DeliverySpecFormErrors;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<DeliverySpecDraft>(initial);
  return <DeliverySpecForm draft={draft} onChange={setDraft} errors={errors} disabled={disabled} />;
}

describe('W1-07 DeliverySpecForm', () => {
  it('renders all 9 editable fields', () => {
    render(<Harness />);
    expect(screen.getByTestId('ds-aspect-ratio')).toBeTruthy();
    expect(screen.getByTestId('ds-resolution-width')).toBeTruthy();
    expect(screen.getByTestId('ds-resolution-height')).toBeTruthy();
    expect(screen.getByTestId('ds-duration')).toBeTruthy();
    expect(screen.getByTestId('ds-fps')).toBeTruthy();
    expect(screen.getByTestId('ds-safe-area')).toBeTruthy();
    expect(screen.getByTestId('ds-audio')).toBeTruthy();
    expect(screen.getByTestId('ds-variants')).toBeTruthy();
    // platform select is rendered as a trigger button
    expect(screen.getByRole('combobox')).toBeTruthy();
    // subtitles checkbox
    expect(screen.getByRole('checkbox')).toBeTruthy();
  });

  it('pre-fills the persisted values (exact echo)', () => {
    render(
      <Harness
        initial={{
          aspect_ratio: '1:1',
          resolutionWidth: '1080',
          resolutionHeight: '1080',
          duration: '15',
          fps: '60',
          platform: 'tiktok',
          subtitles: false,
          audio: 'mono',
          safe_area: '0.2',
          variants: '[{"lang":"en"}]',
        }}
      />,
    );
    expect((screen.getByTestId('ds-aspect-ratio') as HTMLInputElement).value).toBe('1:1');
    expect((screen.getByTestId('ds-resolution-width') as HTMLInputElement).value).toBe('1080');
    expect((screen.getByTestId('ds-resolution-height') as HTMLInputElement).value).toBe('1080');
    expect((screen.getByTestId('ds-duration') as HTMLInputElement).value).toBe('15');
    expect((screen.getByTestId('ds-fps') as HTMLInputElement).value).toBe('60');
    expect((screen.getByTestId('ds-safe-area') as HTMLInputElement).value).toBe('0.2');
    expect((screen.getByTestId('ds-audio') as HTMLInputElement).value).toBe('mono');
    expect((screen.getByTestId('ds-variants') as HTMLTextAreaElement).value).toBe('[{"lang":"en"}]');
    // disabled? no
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('fires onChange when a field is edited', () => {
    render(<Harness />);
    const input = screen.getByTestId('ds-duration') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '45' } });
    expect(input.value).toBe('45');
  });

  it('shows global rejection messages', () => {
    render(<Harness errors={{ fields: {}, global: ['分辨率与画面比例不匹配。'] }} />);
    expect(screen.getByTestId('delivery-spec-global-errors').textContent).toContain('分辨率与画面比例不匹配');
  });

  it('shows a field-level error', () => {
    render(<Harness errors={{ fields: { aspect_ratio: '必须形如 "9:16"' }, global: [] }} />);
    expect(screen.getByText('必须形如 "9:16"')).toBeTruthy();
    expect((screen.getByTestId('ds-aspect-ratio') as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
  });

  it('disables all inputs when read-only', () => {
    render(<Harness disabled />);
    expect((screen.getByTestId('ds-duration') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('combobox') as HTMLButtonElement).disabled).toBe(true);
  });
});
