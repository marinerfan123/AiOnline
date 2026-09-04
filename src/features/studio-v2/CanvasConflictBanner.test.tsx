// @vitest-environment jsdom
/** M05-D — CanvasConflictBanner: kindPolicy-strategy tones + empty null. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, configure } from '@testing-library/react';
import { CanvasConflictBanner } from './CanvasConflictBanner';
import type { ConflictInfo } from './schemas';

configure({ testIdAttribute: 'data-test' });
afterEach(cleanup);

function conflict(kindPolicy: ConflictInfo['kindPolicy']): ConflictInfo {
  return { canvasId: 'c1', kindPolicy };
}

describe('CanvasConflictBanner — strategy tones', () => {
  it('renders nothing when conflict is null or undefined', () => {
    const first = render(<CanvasConflictBanner conflict={null} />);
    expect(first.container.firstChild).toBeNull();
    const second = render(<CanvasConflictBanner />);
    expect(second.container.firstChild).toBeNull();
  });

  it('reject409 → red bar with exact copy + reload button invoking onReload', () => {
    const onReload = vi.fn();
    render(<CanvasConflictBanner conflict={conflict('reject409')} onReload={onReload} />);
    const banner = screen.getByTestId('canvas-conflict-banner');
    expect(banner.getAttribute('data-tone')).toBe('danger');
    expect(screen.getByText('画布已被他人结构性修改')).toBeTruthy();
    fireEvent.click(screen.getByTestId('canvas-conflict-reload'));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('legacy undefined kindPolicy maps to the reject409 reload class', () => {
    const onReload = vi.fn();
    render(<CanvasConflictBanner conflict={conflict(undefined)} onReload={onReload} />);
    expect(screen.getByTestId('canvas-conflict-banner').getAttribute('data-tone')).toBe('danger');
    expect(screen.getByText('画布已被他人结构性修改')).toBeTruthy();
    expect(screen.getByTestId('canvas-conflict-reload')).toBeTruthy();
  });

  it('lww → amber auto-merge note, no reload button', () => {
    render(<CanvasConflictBanner conflict={conflict('lww')} />);
    expect(screen.getByTestId('canvas-conflict-banner').getAttribute('data-tone')).toBe('warning');
    expect(screen.getByText('已按最新内容自动合并')).toBeTruthy();
    expect(screen.queryByTestId('canvas-conflict-reload')).toBeNull();
  });

  it('merge → same amber auto-merge note as lww', () => {
    render(<CanvasConflictBanner conflict={conflict('merge')} />);
    expect(screen.getByTestId('canvas-conflict-banner').getAttribute('data-tone')).toBe('warning');
    expect(screen.getByText('已按最新内容自动合并')).toBeTruthy();
    expect(screen.queryByTestId('canvas-conflict-reload')).toBeNull();
  });

  it('append → gray neutral note', () => {
    render(<CanvasConflictBanner conflict={conflict('append')} />);
    const banner = screen.getByTestId('canvas-conflict-banner');
    expect(banner.getAttribute('data-tone')).toBe('neutral');
    expect(banner.textContent?.length).toBeGreaterThan(0);
    expect(screen.queryByTestId('canvas-conflict-reload')).toBeNull();
  });
});
