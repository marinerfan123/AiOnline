// ── W5a — useCanvasPresence：进画布即在线 + 15s 节流续活 + peers 轮询 ──────────
//
// 生命周期（实查接线）：
//   1. canvasId 来源（W6① 上提后）：presence 按 canvasId 键（非 projectId），本
//      项目为「单主画布/项目」。canvasId 现由 useStudioCanvasPersistence 在
//      loadGraph 成功后写入 store.currentCanvasId（经 getCanvas/createCanvas 幂等
//      解析），本 hook 只读 store —— 不再自行 getCanvas，消除 W5a 每轮多一次 GET。
//      projectId 为空 → 停用（canvasId 视为 null）。
//   2. enter：canvasId 就绪即 heartbeat(state='online')。
//   3. 续活：每 HEARTBEAT_INTERVAL_MS=15s 节流续活（状态机 keepalive 防重）。
//   4. visibilitychange：hidden→offline（摘除）、visible→online（重新进场）+ 立即刷 peers。
//   5. unmount→leave（heartbeat(state='offline')）。
//   6. peers：每 15s getPresence → 右上角在场条数据源。
//
// presence 全部 best-effort：网络失败静默（保留上次 peers / 不回写 online），
// 绝不因 presence 崩溃拖垮画布。

import { useEffect, useState } from 'react';
import { useStudioStore } from './store';
import { presenceClient, type PresencePeer } from './collab/presenceClient';
import {
  createPresenceStateMachine,
  HEARTBEAT_INTERVAL_MS,
  type PresenceCommand,
} from './canvasPresenceState';

export interface CanvasPresence {
  /** 已解析的 presence 寻址键（store.currentCanvasId；未解析/失败为 null → presence 停用）。 */
  canvasId: string | null;
  /** 该画布当前在线 peers（含自身；契约不暴露 self userId，无法过滤自身）。 */
  peers: PresencePeer[];
}

export function useCanvasPresence(projectId: string | undefined): CanvasPresence {
  // W6① canvasId 上提：直接从 store 读主画布 id（persistence 已解析），不再自行
  // getCanvas/createCanvas。projectId 为空 → 停用（canvasId 视为 null）。
  const storeCanvasId = useStudioStore((s) => s.currentCanvasId);
  const canvasId = projectId ? storeCanvasId : null;
  const [peers, setPeers] = useState<PresencePeer[]>([]);

  // ── 生命周期：enter / 15s 节流续活 / visibility / unmount leave / peers ──
  useEffect(() => {
    if (!canvasId) return;
    const machine = createPresenceStateMachine();
    let disposed = false;

    const send = async (cmd: PresenceCommand) => {
      if (cmd.type === 'none' || disposed) return;
      try {
        if (cmd.type === 'offline') {
          await presenceClient.leave({ canvasId });
        } else {
          await presenceClient.heartbeat({ canvasId, state: cmd.state });
        }
      } catch {
        // presence best-effort：失败静默，不回写状态、不重抛。
      }
    };

    const refreshPeers = async () => {
      try {
        const list = await presenceClient.getPresence({ canvasId });
        if (!disposed) setPeers(list);
      } catch {
        // 保留上次已知 peers（瞬时失败不闪空）。
      }
    };

    void send(machine.enter());
    void refreshPeers();

    const keepaliveTimer = setInterval(() => { void send(machine.keepalive()); }, HEARTBEAT_INTERVAL_MS);
    const peersTimer = setInterval(() => { void refreshPeers(); }, HEARTBEAT_INTERVAL_MS);

    const onVisibility = () => {
      if (document.hidden) {
        void send(machine.hidden());
      } else {
        void send(machine.visible());
        void refreshPeers();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      clearInterval(keepaliveTimer);
      clearInterval(peersTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      // 卸载即离开：fire-and-forget，不因 disposed 拦截（这是 teardown 自身）。
      const cmd = machine.leave();
      if (cmd.type === 'offline') void presenceClient.leave({ canvasId }).catch(() => {});
    };
  }, [canvasId]);

  return { canvasId, peers };
}
