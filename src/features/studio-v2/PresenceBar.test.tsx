// @vitest-environment jsdom
// W5a — PresenceBar：渲染 peers（头像/名首字/state 色点）+ 空态。
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within, configure } from '@testing-library/react';
import { PresenceBar } from './PresenceBar';
import type { PresencePeer } from './collab/presenceClient';

// 组件用 data-test 标注（repo 约定）；RTL 默认只认 data-testid。
configure({ testIdAttribute: 'data-test' });

afterEach(cleanup);

describe('PresenceBar — 渲染 peers', () => {
  it('渲染每个 peer 的头像（userId 首字）+ state 色点（data-state 标注）', () => {
    const peers: PresencePeer[] = [
      { userId: 'alice-1', state: 'editing', lastSeenMs: 1 },
      { userId: 'bob-2', state: 'online', lastSeenMs: 2 },
      { userId: 'carol', state: 'away', lastSeenMs: 3 },
    ];
    render(<PresenceBar peers={peers} />);

    const bar = screen.getByTestId('presence-bar');
    expect(bar).toBeTruthy();
    expect(bar.getAttribute('data-empty')).toBeNull(); // 非空态

    const items = within(bar).getAllByTestId('presence-peer');
    expect(items).toHaveLength(3);
    // 名首字：userId 首字符大写
    expect(items[0].textContent).toContain('A');
    expect(items[1].textContent).toContain('B');
    expect(items[2].textContent).toContain('C');

    // state 色点逐一标注（渲染层只挂 state 语义，颜色由 CSS 决定）
    const dots = within(bar).getAllByTestId('presence-state-dot');
    expect(dots.map((d) => d.getAttribute('data-state'))).toEqual(['editing', 'online', 'away']);
  });

  it('按 userId 稳定排序（渲染顺序确定，不受输入顺序影响）', () => {
    const peers: PresencePeer[] = [
      { userId: 'zeta', state: 'online', lastSeenMs: 1 },
      { userId: 'alpha', state: 'online', lastSeenMs: 2 },
    ];
    render(<PresenceBar peers={peers} />);
    const items = within(screen.getByTestId('presence-bar')).getAllByTestId('presence-peer');
    expect(items[0].textContent).toContain('A'); // alpha 在前
    expect(items[1].textContent).toContain('Z');
  });

  it('offline state 也容错渲染（不崩溃，灰点）', () => {
    const peers: PresencePeer[] = [{ userId: 'ghost', state: 'offline', lastSeenMs: null }];
    render(<PresenceBar peers={peers} />);
    const dot = within(screen.getByTestId('presence-bar')).getByTestId('presence-state-dot');
    expect(dot.getAttribute('data-state')).toBe('offline');
  });
});

describe('PresenceBar — 空态', () => {
  it('无 peers → 渲染「仅你在此画布」空态标记', () => {
    render(<PresenceBar peers={[]} />);
    const bar = screen.getByTestId('presence-bar');
    expect(bar.getAttribute('data-empty')).toBe('true');
    expect(bar.textContent).toContain('仅你在此画布');
    expect(screen.queryByTestId('presence-peer')).toBeNull();
  });
});
