// M05-D — Canvas conflict banner (strategy-aware, G22 / doc 26 §4).
// Pure presentational leaf. Maps a parsed canvas 409 conflict to one of three
// tones by kindPolicy and renders nothing when there is no conflict. Consumed
// by StudioPage inside the canvas root; `conflict` comes straight from
// useStudioCanvasPersistence (already parsed through ./schemas) and `onReload`
// is the hook's whole-canvas reloadFromServer.
//
// Tone routing mirrors conflictClientMode's reload class: a legacy 409 body
// (kindPolicy undefined — server has not merged the G22 fields yet) IS the
// reject409 / whole-canvas CAS conflict, so it gets the same red bar + reload.
// 'lww'/'merge' conflicts were already auto-rebased once by the hook (F1
// replay on the server revision), so they render an informational amber bar —
// no undo, because an auto-rebase is not a reversible local edit. 'append'
// never emits a 409 today (doc 26 §2.3) but is rendered as a neutral gray note
// if a future server ever sends it.

import type { ConflictInfo } from './schemas';

export interface CanvasConflictBannerProps {
  /** Parsed conflict from useStudioCanvasPersistence; null/undefined → nothing. */
  conflict?: ConflictInfo | null;
  /** Whole-canvas reload (hook's reloadFromServer). Wired for the red bar only. */
  onReload?: () => void;
}

const BASE = 'absolute right-3 top-3 z-30 flex max-w-sm items-center gap-3 rounded-lg border px-3 py-2 text-xs shadow-xl backdrop-blur';

const TONES = {
  danger: 'border-red-500/40 bg-ml2-surface-1/95 text-red-300',
  warning: 'border-amber-500/40 bg-ml2-surface-1/95 text-amber-200',
  neutral: 'border-ml2-border bg-ml2-surface-1/95 text-ml2-text-2',
} as const;

export type CanvasConflictTone = keyof typeof TONES;

export function CanvasConflictBanner({ conflict, onReload }: CanvasConflictBannerProps) {
  if (!conflict) return null;
  const kind = conflict.kindPolicy;

  // 'lww' | 'merge' → incremental rebase class (hook already auto-merged once).
  if (kind === 'lww' || kind === 'merge') {
    return (
      <div data-test="canvas-conflict-banner" data-tone="warning" role="status" className={`${BASE} ${TONES.warning}`}>
        <span>已按最新内容自动合并</span>
      </div>
    );
  }

  // 'append' → append-only kinds never 409 today; neutral note if one arrives.
  if (kind === 'append') {
    return (
      <div data-test="canvas-conflict-banner" data-tone="neutral" role="status" className={`${BASE} ${TONES.neutral}`}>
        <span>已按追加策略同步服务器最新内容</span>
      </div>
    );
  }

  // 'reject409' — and legacy undefined kindPolicy (the whole-canvas CAS class).
  return (
    <div data-test="canvas-conflict-banner" data-tone="danger" role="alert" className={`${BASE} ${TONES.danger}`}>
      <div>
        <p className="font-semibold">画布已被他人结构性修改</p>
        <p className="mt-0.5 text-[11px] text-ml2-text-3">本地工作副本已保留。请重新加载服务器版本后再继续保存。</p>
      </div>
      <button
        data-test="canvas-conflict-reload"
        onClick={onReload}
        className="shrink-0 rounded bg-red-500/20 px-2 py-1 text-[11px] text-red-200 hover:bg-red-500/30"
      >
        重新加载
      </button>
    </div>
  );
}
