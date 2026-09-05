// ── W5a — PresenceBar：画布右上角「在场条」（非世界坐标光标）──────────────────
//
// 本叶范围 = 在场条（谁在这个画布上）。世界坐标光标留 W5b（需服务端提供 cursor
// 字段 —— 现契约 peers 读面仅 { userId, state, lastSeenMs }，无 cursor/selection）。
//
// 头像 = userId 首字符（契约无 displayName，故用 userId 首字代替「名首字」）；
// 色点 = state 映射（online 绿 / editing 蓝 / away 琥珀 / offline 灰——offline 会被
// 服务端惰性过滤，正常不出现，仅容错展示）。

import type { PresencePeer, PresenceState } from './collab/presenceClient';

const STATE_DOT: Record<PresenceState, string> = {
  online: 'bg-emerald-500',
  editing: 'bg-blue-500',
  away: 'bg-amber-500',
  offline: 'bg-zinc-500',
};

const STATE_LABEL: Record<PresenceState, string> = {
  online: '在线',
  editing: '编辑中',
  away: '暂离',
  offline: '离线',
};

function initial(userId: string): string {
  const ch = userId.trim().charAt(0);
  return (ch || '?').toUpperCase();
}

export function PresenceBar({ peers }: { peers: PresencePeer[] }) {
  const sorted = [...peers].sort((a, b) => a.userId.localeCompare(b.userId));

  if (sorted.length === 0) {
    return (
      <div
        data-test="presence-bar"
        data-empty="true"
        className="pointer-events-none absolute right-2 top-2 z-40 rounded-full border border-ml2-border bg-ml2-surface-1/90 px-2.5 py-1 text-[11px] text-ml2-text-3 shadow-md backdrop-blur"
      >
        仅你在此画布
      </div>
    );
  }

  return (
    <div
      data-test="presence-bar"
      className="pointer-events-none absolute right-2 top-2 z-40 flex items-center gap-1 rounded-full border border-ml2-border bg-ml2-surface-1/90 px-2 py-1 shadow-md backdrop-blur"
    >
      {sorted.map((p) => (
        <div
          key={p.userId}
          data-test="presence-peer"
          title={`${p.userId} · ${STATE_LABEL[p.state]}`}
          className="relative flex h-6 w-6 items-center justify-center rounded-full border border-ml2-border bg-ml2-surface-2 text-[11px] font-medium text-ml2-text"
        >
          {initial(p.userId)}
          <span
            data-test="presence-state-dot"
            data-state={p.state}
            className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border border-ml2-surface-1 ${STATE_DOT[p.state]}`}
          />
        </div>
      ))}
    </div>
  );
}
