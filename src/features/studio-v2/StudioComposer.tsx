// G07 — Bottom Prompt Composer (Blueprint 02 §8). Floating bottom-center.
// States (six) derived from canvas selection context. Text edits persist to
// the selected node's prompt payload via the store (beginEdit/endEdit batch).
// Slash (@) detection shows suggestions; ref chips render @ bindings.
// Honest wiring: dynamic model schema & server slash registry arrive with the
// public Models API (G07 remainder); actual Run dispatch is G15 (facade +
// planner) — this surface NEVER fabricates a queued/completed run.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, Send, AlertTriangle } from 'lucide-react';
import { useStudioStore } from './store';
import { getNodeDef } from './registry';
import { deriveComposerState, detectSlashCommand, parseRefTokens } from './composerModel';
import { cn } from '@/lib/utils';

const SLASH_HINTS = ['optimize', 'rewrite', 'translate'];

function promptValueOf(data: Record<string, unknown>): string {
  const params = (data.parameters ?? {}) as Record<string, unknown>;
  const raw = params.prompt ?? params.content ?? params.scriptText ?? data.prompt;
  return typeof raw === 'string' ? raw : '';
}

export function StudioComposer() {
  const nodes = useStudioStore((s) => s.nodes);
  const beginEdit = useStudioStore((s) => s.beginEdit);
  const endEdit = useStudioStore((s) => s.endEdit);
  const updateNodeData = useStudioStore((s) => s.updateNodeData);
  const editing = useRef(false);

  const selected = nodes.filter((n) => n.selected && n.data.nodeKind !== 'frame');
  const state = deriveComposerState({ selection: { count: selected.length, nodeKind: selected[0]?.data.nodeKind } });
  const node = selected.length === 1 ? selected[0] : null;
  const def = node ? getNodeDef(node.data.nodeKind) : undefined;
  const isGeneration = Boolean(def?.isGeneration);
  const [text, setText] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);

  // Sync draft text whenever the target node changes (never while editing).
  useEffect(() => {
    if (editing.current) return;
    setText(node ? promptValueOf(node.data) : '');
  }, [node?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const refs = useMemo(() => (text ? parseRefTokens(text) : []), [text]);
  const slash = useMemo(() => (text ? detectSlashCommand(text, SLASH_HINTS) : null), [text]);
  const dirty = text !== (node ? promptValueOf(node.data) : '');

  const commit = (value: string) => {
    if (!node) return;
    if (!editing.current) {
      beginEdit();
      editing.current = true;
    }
    updateNodeData(node.id, { prompt: value });
  };

  const flush = () => {
    if (!editing.current) return;
    endEdit();
    editing.current = false;
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1600);
  };

  const validation = !node
    ? null
    : !isGeneration
      ? { ok: true as const, note: `编辑 ${def?.title ?? '节点'} 内容 — 生成面由其上游/自身执行` }
      : text.trim().length === 0
        ? { ok: false as const, note: '请输入提示词' }
        : null;

  if (state === 'NO_SELECTION') {
    return (
      <div data-test="studio-composer" className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center">
        <div data-test="composer-no-selection" className="pointer-events-auto rounded-2xl border border-ml2-border/70 bg-ml2-panel px-4 py-2 text-[11px] text-ml2-text-3 shadow-xl backdrop-blur">
          选中一个节点开始创作 · 双击空白新建 · Ctrl+G 分组
        </div>
      </div>
    );
  }

  return (
    <div data-test="studio-composer" className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-8">
      <div data-test="composer-panel" className="pointer-events-auto w-full max-w-2xl rounded-2xl border border-ml2-border bg-ml2-panel p-3 shadow-2xl backdrop-blur" data-composer-state={state}>
        <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ml2-text-3">
          <span data-test="composer-state">{state}</span>
          {def && <span className="text-ml2-accent">· {def.title}</span>}
          {isGeneration && <span className="ml-auto flex items-center gap-1 text-ml2-accent"><Sparkles className="size-3" />{(def.capabilityRequirements ?? []).join(', ') || 'generation'}</span>}
        </div>

        {refs.length > 0 && (
          <div data-test="composer-ref-chips" className="mb-1 flex flex-wrap gap-1">
            {refs.map((r, i) => (
              <span key={`${r.token}-${i}`} data-test="composer-ref-chip" className="rounded-full border border-ml2-accent/30 bg-ml2-accent/10 px-2 py-px text-[10px] text-ml2-accent">
                @{r.token}
              </span>
            ))}
          </div>
        )}

        <div className="relative">
          <textarea
            data-test="composer-textarea"
            value={text}
            rows={Math.min(6, Math.max(1, text.split('\n').length))}
            placeholder={isGeneration ? '描述你想生成的内容…（@角色 / @风格 引用）' : `编辑 ${def?.title ?? '节点'} 内容…`}
            onChange={(e) => { setText(e.target.value); commit(e.target.value); }}
            onBlur={flush}
            className="w-full resize-none rounded-xl border border-ml2-border bg-ml2-surface-0 px-3 py-2 text-xs text-ml2-text outline-none placeholder:text-ml2-text-3 focus:border-ml2-accent/60"
          />
          {slash && (
            <div data-test="composer-slash-hint" className="absolute bottom-full left-2 mb-1 flex gap-1 rounded-lg border border-ml2-border bg-ml2-surface-1 p-1 shadow-xl">
              {SLASH_HINTS.filter((s) => s.startsWith(slash.slash)).map((s) => (
                <button key={s} data-test={`slash-${s}`} className="rounded-md px-2 py-1 text-[10px] text-ml2-text-2 hover:bg-ml2-surface-3 hover:text-ml2-text">/{s}</button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-2 flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-[10px] text-ml2-text-3">
            {isGeneration
              ? 'Cost: 生成前 quoteService 估价 · Run 层接线 (G15)'
              : validation?.ok ? '' : validation?.note}
          </div>
          {savedFlash && <span data-test="composer-saved" className="text-[10px] text-emerald-400">已保存</span>}
          {validation && !validation.ok && (
            <span data-test="composer-validation" className="flex items-center gap-1 text-[10px] text-amber-400"><AlertTriangle className="size-3" />{validation.note}</span>
          )}
          <button
            data-test="composer-generate"
            disabled={!isGeneration || text.trim().length === 0}
            onClick={() => { flush(); }}
            title={isGeneration ? '执行链经 G15 Run 层接入；当前保存节点提示词' : '仅生成类节点可执行'}
            className="flex items-center gap-1.5 rounded-xl bg-ml2-accent px-3 py-1.5 text-[11px] font-medium text-black enabled:hover:brightness-110 disabled:opacity-40"
          >
            <Send className="size-3" /> Generate
          </button>
        </div>
      </div>
    </div>
  );
}
