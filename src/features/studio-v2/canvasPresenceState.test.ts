// W5a — canvas presence 状态机：节流（防重）与生命周期状态机（纯模块单测）。
import { describe, it, expect } from 'vitest';
import {
  createPresenceStateMachine,
  HEARTBEAT_INTERVAL_MS,
} from './canvasPresenceState';

describe('createPresenceStateMachine — 状态机（生命周期转换）', () => {
  it('enter → 立即 online 心跳，且幂等（重复 enter 不再发）', () => {
    const m = createPresenceStateMachine();
    expect(m.phase()).toBe('inactive');
    expect(m.enter()).toEqual({ type: 'heartbeat', state: 'online' });
    expect(m.phase()).toBe('online');
    expect(m.enter()).toEqual({ type: 'none' }); // 已在 online → no-op
  });

  it('hidden → offline（摘除）；visible → 立即 online 心跳', () => {
    const m = createPresenceStateMachine();
    m.enter();
    expect(m.hidden()).toEqual({ type: 'offline' });
    expect(m.phase()).toBe('hidden');
    expect(m.hidden()).toEqual({ type: 'none' }); // 幂等
    expect(m.visible()).toEqual({ type: 'heartbeat', state: 'online' });
    expect(m.phase()).toBe('online');
    expect(m.visible()).toEqual({ type: 'none' }); // 幂等
  });

  it('leave → 仍 online 时补发 offline；之后 enter/hidden/visible/leave 全部 no-op（终态）', () => {
    const m = createPresenceStateMachine();
    m.enter();
    expect(m.leave()).toEqual({ type: 'offline' });
    expect(m.phase()).toBe('left');
    expect(m.leave()).toEqual({ type: 'none' });
    expect(m.enter()).toEqual({ type: 'none' });
    expect(m.hidden()).toEqual({ type: 'none' });
    expect(m.visible()).toEqual({ type: 'none' });
  });

  it('leave while hidden 是 no-op（offline 已在 hidden 时发送，不重复摘除）', () => {
    const m = createPresenceStateMachine();
    m.enter();
    m.hidden(); // 已发 offline
    expect(m.leave()).toEqual({ type: 'none' });
  });

  it('从未 enter 的 inactive 阶段 leave → no-op（无可摘除）', () => {
    const m = createPresenceStateMachine();
    expect(m.leave()).toEqual({ type: 'none' });
  });
});

describe('createPresenceStateMachine — 节流（防重）', () => {
  it('常量钉死 15s 间隔', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(15_000);
  });

  it('keepalive 在 interval 内被节流，恰好间隔处放行（防重）', () => {
    let t = 0;
    const m = createPresenceStateMachine({ now: () => t });
    m.enter(); // lastSendMs = 0

    t = 1_000;
    expect(m.keepalive()).toEqual({ type: 'none' });

    t = 14_999;
    expect(m.keepalive()).toEqual({ type: 'none' });

    t = 15_000; // 恰好间隔边界 → 放行
    expect(m.keepalive()).toEqual({ type: 'heartbeat', state: 'online' });
  });

  it('放行后重新计时：下一次 keepalive 又需满一个间隔', () => {
    let t = 0;
    const m = createPresenceStateMachine({ now: () => t });
    m.enter(); // lastSendMs = 0
    t = 15_000;
    expect(m.keepalive()).toEqual({ type: 'heartbeat', state: 'online' }); // lastSendMs = 15000
    t = 15_001;
    expect(m.keepalive()).toEqual({ type: 'none' });
    t = 30_000;
    expect(m.keepalive()).toEqual({ type: 'heartbeat', state: 'online' });
  });

  it('keepalive 只在 online 阶段续活（hidden/left 不续）', () => {
    let t = 0;
    const m = createPresenceStateMachine({ now: () => t });
    m.enter();
    m.hidden();
    t = 20_000;
    expect(m.keepalive()).toEqual({ type: 'none' }); // hidden 不续活
    m.visible(); // 回到前台，markSent = 20000
    t = 21_000;
    expect(m.keepalive()).toEqual({ type: 'none' }); // 距 visible 仅 1s
    t = 35_000; // 距 visible 15s
    expect(m.keepalive()).toEqual({ type: 'heartbeat', state: 'online' });
  });
});
