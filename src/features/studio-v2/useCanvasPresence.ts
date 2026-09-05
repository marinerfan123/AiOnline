// ── W5a — useCanvasPresence：进画布即在线 + 15s 节流续活 + peers 轮询 ──────────
//
// 生命周期（实查接线）：
//   1. canvasId 来源：presence 按 canvasId 键（非 projectId）。本项目为「单主画布/项目」
//      （server studioCanvasPersistence.cjs：getCanvas WHERE project_id=$1 AND is_primary=TRUE
//      LIMIT 1；createCanvasTx 以 ON CONFLICT (project_id) WHERE is_primary 保证每项目至多
//      一个主画布；canvas.id = `canvas-<uuid>`，≠ projectId）。故本 hook 经
//      v2studio.getCanvas(projectId) 取 canvas.id；尚无主画布时 v2studio.createCanvas
//      （幂等，ON CONFLICT DO UPDATE 返回既有主画布）。这多一次 GET（persistence hook
//      也会 getCanvas，但不回传 canvasId），留待后续叶把 canvasId 从 persistence 上提。
//   2. enter：canvasId 就绪即 heartbeat(state='online')。
//   3. 续活：每 HEARTBEAT_INTERVAL_MS=15s 节流续活（状态机 keepalive 防重）。
//   4. visibilitychange：hidden→offline（摘除）、visible→online（重新进场）+ 立即刷 peers。
//   5. unmount→leave（heartbeat(state='offline')）。
//   6. peers：每 15s getPresence → 右上角在场条数据源。
//
// presence 全部 best-effort：网络失败静默（保留上次 peers / 不回写 online），
// 绝不因 presence 崩溃拖垮画布。

import { useEffect, useState } from 'react';
import { v2studio } from '@/shared/api/contract/studio-canvas-client';
import { presenceClient, type PresencePeer } from './collab/presenceClient';
import {
  createPresenceStateMachine,
  HEARTBEAT_INTERVAL_MS,
  type PresenceCommand,
} from './canvasPresenceState';

export interface CanvasPresence {
  /** 已解析的 presence 寻址键（未解析/失败为 null → presence 停用）。 */
  canvasId: string | null;
  /** 该画布当前在线 peers（含自身；契约不暴露 self userId，无法过滤自身）。 */
  peers: PresencePeer[];
}

export function useCanvasPresence(projectId: string | undefined): CanvasPresence {
  const [canvasId, setCanvasId] = useState<string | null>(null);
  const [peers, setPeers] = useState<PresencePeer[]>([]);

  // ── canvasId 解析（mount + projectId 切换）────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!projectId) {
      setCanvasId(null);
      setPeers([]);
      return;
    }
    (async () => {
      try {
        const res = await v2studio.getCanvas(projectId);
        let id: string | null = res.canvas?.id ?? null;
        if (!id) {
          // 尚无主画布：createCanvas 幂等（ON CONFLICT 返回既有主画布），与
          // useStudioCanvasPersistence.reloadFromServer 同源逻辑。
          const created = await v2studio.createCanvas(projectId, { name: 'Primary Canvas' });
          id = created.canvas?.id ?? null;
        }
        if (!cancelled) setCanvasId(id);
      } catch {
        if (!cancelled) setCanvasId(null); // 解析失败 → presence 停用（空态）
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

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
