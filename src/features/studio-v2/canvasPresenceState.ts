// ── W5a — canvas presence 生命周期状态机（纯模块，无 React / 无 IO）───────────
//
// 把「进画布即 online、15s 节流续活、visibilitychange 切换、unmount 离开」编译为
// 一个可单测的纯状态机：每个生命周期事件返回一个「命令」，由调用方（useCanvasPresence
// hook）翻译成 presenceClient.heartbeat / leave 的实际调用。这样节流与状态机
// 逻辑不依赖定时器/浏览器/网络，可直接用注入的 now() 断言。
//
// 与 collab/presenceClient 的关系（实查结论）：
//   - presence 寻址键 = canvasId（非 projectId）；本模块不关心 canvasId 来源。
//   - 状态枚举单一真源在 presenceBus.cjs / presenceClient.ts：online/away/editing/offline。
//   - 本叶范围仅用 online（进画布/续活/回到前台）与 offline（切走/离开）。契约里的
//     away（「编辑器后台/切走标签页」语义）本叶不使用：任务口径为
//     visibilitychange hidden→offline / visible→online（见 leaf 说明）。
//   - 契约无 cursor/selection 字段 → 本叶只做在场条（peers 列表），不做世界坐标光标。

/** 客户端续活间隔（ms）。与 collab/presenceClient.HEARTBEAT_INTERVAL_MS 逐字一致
 *  （复制常量而非 require，避免本纯模块反向依赖 api client）。服务端 TTL=30s=2×此值。 */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** 心跳可上报的「在场」状态（offline 是「摘除」，走独立 offline 命令）。 */
export type HeartbeatState = 'online' | 'away' | 'editing';

/** 状态机输出的命令 —— 调用方据此触发实际 presenceClient 调用。 */
export type PresenceCommand =
  | { type: 'heartbeat'; state: HeartbeatState }
  | { type: 'offline' }
  | { type: 'none' };

/** 自身 presence 生命周期阶段。 */
export type PresencePhase = 'inactive' | 'online' | 'hidden' | 'left';

export interface PresenceStateMachine {
  /** 当前阶段（只读，供调试/断言）。 */
  phase(): PresencePhase;
  /** 进画布（mount + canvasId 就绪）→ 立即 online。幂等：已在 online/已 left 则 no-op。 */
  enter(): PresenceCommand;
  /** 15s 定时器续活 —— 严格节流：距上次发送 < intervalMs 返回 none（防重）。 */
  keepalive(): PresenceCommand;
  /** visibilitychange → document.hidden=true → offline（摘除在场记录）。幂等。 */
  hidden(): PresenceCommand;
  /** visibilitychange → document.hidden=false → 立即 online。幂等。 */
  visible(): PresenceCommand;
  /** unmount → 离开。仅在「仍 online」时补发 offline（hidden 已摘除则 no-op）。 */
  leave(): PresenceCommand;
}

export interface CreatePresenceStateMachineOptions {
  /** 续活节流窗口（默认 HEARTBEAT_INTERVAL_MS）。 */
  intervalMs?: number;
  /** 时钟注入（默认 Date.now），供测试冻结/推进时间。 */
  now?: () => number;
}

export function createPresenceStateMachine(
  opts: CreatePresenceStateMachineOptions = {},
): PresenceStateMachine {
  const intervalMs = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const now = opts.now ?? Date.now;

  let phase: PresencePhase = 'inactive';
  let lastSendMs = -Infinity;
  const markSent = () => { lastSendMs = now(); };

  return {
    phase: () => phase,

    enter() {
      if (phase === 'online' || phase === 'left') return { type: 'none' };
      phase = 'online';
      markSent();
      return { type: 'heartbeat', state: 'online' };
    },

    keepalive() {
      if (phase !== 'online') return { type: 'none' };
      if (now() - lastSendMs < intervalMs) return { type: 'none' }; // 节流防重
      markSent();
      return { type: 'heartbeat', state: 'online' };
    },

    hidden() {
      if (phase === 'hidden' || phase === 'left') return { type: 'none' };
      phase = 'hidden';
      markSent();
      return { type: 'offline' };
    },

    visible() {
      if (phase === 'online' || phase === 'left') return { type: 'none' };
      phase = 'online';
      markSent();
      return { type: 'heartbeat', state: 'online' };
    },

    leave() {
      if (phase === 'left' || phase === 'inactive') return { type: 'none' };
      const wasOnline = phase === 'online';
      phase = 'left';
      markSent();
      return wasOnline ? { type: 'offline' } : { type: 'none' };
    },
  };
}
