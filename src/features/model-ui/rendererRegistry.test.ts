// L42 — Custom Renderer Registry（§13 注册面）纯逻辑测试（无 DOM）。
// 覆盖 5 项验收：注册 / 优先级覆盖 / 按类型解析 / hint 优先 / 未知 hint 回退。
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerRenderer,
  resolveRenderer,
  listRenderers,
  resetRenderers,
} from './rendererRegistry';

const A = () => null;
const B = () => null;
const C = () => null;

beforeEach(() => resetRenderers());

describe('rendererRegistry — §13 注册面', () => {
  it('注册：registerRenderer 后出现在 listRenderers，priority 缺省为 0', () => {
    registerRenderer({ name: 'video.motion-control', component: A, forTypes: ['slider'] });
    const list = listRenderers();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('video.motion-control');
    expect(list[0].component).toBe(A);
    expect(list[0].forTypes).toEqual(['slider']);
    expect(list[0].priority).toBe(0);
  });

  it('优先级覆盖：同 name 更高 priority 覆盖，更低 priority 不降级', () => {
    registerRenderer({ name: 'x', component: A, forTypes: ['number'], priority: 0 });
    registerRenderer({ name: 'x', component: B, forTypes: ['number'], priority: 10 });
    expect(resolveRenderer({ type: 'number' })?.component).toBe(B);

    // 5 < 10：不降级，仍为 B
    registerRenderer({ name: 'x', component: C, forTypes: ['number'], priority: 5 });
    expect(resolveRenderer({ type: 'number' })?.component).toBe(B);
    expect(listRenderers()).toHaveLength(1);
  });

  it('按类型解析：forTypes 命中返回；未命中返回 null', () => {
    registerRenderer({ name: 'num', component: A, forTypes: ['number', 'integer'] });
    expect(resolveRenderer({ type: 'number' })?.name).toBe('num');
    expect(resolveRenderer({ type: 'integer' })?.name).toBe('num');
    expect(resolveRenderer({ type: 'text' })).toBeNull();
  });

  it('按类型解析：同 type 多 renderer，priority 高者胜', () => {
    registerRenderer({ name: 'low', component: A, forTypes: ['number'], priority: 1 });
    registerRenderer({ name: 'high', component: B, forTypes: ['number'], priority: 9 });
    expect(resolveRenderer({ type: 'number' })?.name).toBe('high');
  });

  it('hint 优先：rendererHint 命中即返回，即使同 type 上有更高 priority 者', () => {
    registerRenderer({ name: 'special', component: A, forTypes: ['slider'], priority: 0 });
    registerRenderer({ name: 'default', component: B, forTypes: ['number'], priority: 99 });
    expect(resolveRenderer({ type: 'number', rendererHint: 'special' })?.name).toBe('special');
    expect(resolveRenderer({ type: 'number', rendererHint: 'special' })?.component).toBe(A);
  });

  it('未知回退：未知 rendererHint → null（非 throw），无 type 无 hint → null', () => {
    registerRenderer({ name: 'known', component: A, forTypes: ['number'] });
    expect(() => resolveRenderer({ type: 'number', rendererHint: 'nope' })).not.toThrow();
    expect(resolveRenderer({ type: 'number', rendererHint: 'nope' })).toBeNull();
    expect(resolveRenderer({ rendererHint: 'unknown' })).toBeNull();
    expect(resolveRenderer({})).toBeNull();
  });
});
