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
import { deriveComposerState, detectSlashCommand, parseRefTokens, filterAvailableModels, type ModelAvailability } from './composerModel';
import { cn } from '@/lib/utils';

// Legacy registry capability vocabulary → blueprint-canonical capability keys
// (server models API projects canonical capabilities).
const LEGACY_TO_CANONICAL: Record<string, string> = {
  text_to_image: 'image.text2image',
  image_to_video: 'video.image2video',
  text_to_video: 'video.text2video',
};

interface ModelOption extends ModelAvailability {
  bindingId: string;
  name: string;
  capabilities: Record<string, boolean | number>;
  lineCount?: number;
}

interface ResolvedRef {
  token: string;
  resolution: string;
  binding?: { entityType: string; entityId: string; canonicalName?: string };
  candidates?: { entityType: string; entityId: string; canonicalName?: string }[];
}

/** Render-path read of a node's primary text payload (parameters first, then legacy denormalization). */
export function promptValueOf(data: Record<string, unknown>): string {
  const params = (data.parameters ?? {}) as Record<string, unknown>;
  const raw = params.prompt ?? params.content ?? params.scriptText ?? data.prompt;
  return typeof raw === 'string' ? raw : '';
}

/**
 * Primary text parameter key per node kind — the registry parameterSchema key
 * is the single source of truth (prompt→parameters.prompt, script→scriptText,
 * text→content). Mirrors the promptValueOf read order so dirty stays accurate.
 */
function primaryTextParameterKey(kind: string): string | null {
  switch (kind) {
    case 'prompt': return 'prompt';
    case 'script': return 'scriptText';
    case 'text': return 'content';
    default: return null;
  }
}

export function StudioComposer({ projectId }: { projectId?: string }) {
  const nodes = useStudioStore((s) => s.nodes);
  const beginEdit = useStudioStore((s) => s.beginEdit);
  const endEdit = useStudioStore((s) => s.endEdit);
  const updateNodeData = useStudioStore((s) => s.updateNodeData);
  const updateNodeParameter = useStudioStore((s) => s.updateNodeParameter);
  const editing = useRef(false);
  const flushRef = useRef<number | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [slashHints, setSlashHints] = useState<string[]>([]);
  const [resolutions, setResolutions] = useState<Record<string, ResolvedRef>>({});
  const [boundRefs, setBoundRefs] = useState<Record<string, ResolvedRef['binding']>>({});

  const selected = nodes.filter((n) => n.selected && n.data.nodeKind !== 'frame');
  const state = deriveComposerState({ selection: { count: selected.length, nodeKind: selected[0]?.data.nodeKind } });
  const node = selected.length === 1 ? selected[0] : null;
  const def = node ? getNodeDef(node.data.nodeKind) : undefined;
  const isGeneration = Boolean(def?.isGeneration);
  const [text, setText] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);

  // Load the public model list once (canonical capabilities projection).
  useEffect(() => {
    let alive = true;
    fetch('/api/studio/models', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((d) => { if (alive && Array.isArray(d?.models)) setModels(d.models); })
      .catch(() => { /* offline composer still works; model row hidden */ });
    return () => { alive = false; };
  }, []);

  // Slash hints come from the server slash registry (single source of truth) —
  // no hardcoded copy in the composer.
  useEffect(() => {
    let alive = true;
    fetch('/api/studio/shortcuts', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((d) => {
        if (alive && Array.isArray(d?.shortcuts)) {
          setSlashHints(d.shortcuts.map((s: { slash?: string }) => s.slash).filter(Boolean) as string[]);
        }
      })
      .catch(() => { /* registry unavailable; hints stay empty */ });
    return () => { alive = false; };
  }, []);

  const capableModels = useMemo(() => {
    if (!isGeneration || !def?.capabilityRequirements?.length) return [];
    const wanted = def.capabilityRequirements.map((c) => LEGACY_TO_CANONICAL[c] ?? c);
    return filterAvailableModels(models, wanted);
  }, [models, isGeneration, def]);

  const params = (node?.data.parameters ?? {}) as Record<string, unknown>;
  const selectedModel = def?.modelField ? String(params[def.modelField] ?? '') : '';
  const modelName = capableModels.find((m) => m.bindingId === selectedModel)?.name ?? '';

  // Debounced @resolution against the server (04 §13), project-scoped.
  useEffect(() => {
    if (!projectId || !text.includes('@')) { setResolutions({}); return; }
    const t = window.setTimeout(() => {
      fetch('/api/studio/autolink/resolve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, text }),
      })
        .then((r) => r.json())
        .then((d) => {
          if (!Array.isArray(d?.results)) return;
          const map: Record<string, ResolvedRef> = {};
          for (const rr of d.results) map[rr.token] = rr;
          setResolutions(map);
        })
        .catch(() => {});
    }, 700);
    return () => window.clearTimeout(t);
  }, [projectId, text]);

  // Persist user-confirmed @bindings into the node payload (canvas data.references).
  const persistedRefsRef = useRef('');
  useEffect(() => {
    if (!node) return;
    const arr = Object.values(boundRefs).filter(Boolean) as NonNullable<ResolvedRef['binding']>[];
    const sig = JSON.stringify(arr.map((b) => `${b.entityType}:${b.entityId}`));
    if (sig === persistedRefsRef.current) return;
    persistedRefsRef.current = sig;
    updateNodeData(node.id, { references: arr });
  }, [boundRefs, node, updateNodeData]);

  const chooseBinding = (token: string, b: ResolvedRef['binding']) => {
    setBoundRefs((prev) => ({ ...prev, [token]: b }));
  };

  // Sync draft text whenever the target node changes (never while editing).
  const lastNodeId = useRef<string | null>(null);
  useEffect(() => {
    if (editing.current) return;
    if (lastNodeId.current !== (node?.id ?? null)) {
      lastNodeId.current = node?.id ?? null;
      setBoundRefs({});
      setResolutions({});
    }
    setText(node ? promptValueOf(node.data) : '');
  }, [node?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const refs = useMemo(() => (text ? parseRefTokens(text) : []), [text]);
  const slash = useMemo(() => (text ? detectSlashCommand(text, slashHints) : null), [text, slashHints]);
  const dirty = text !== (node ? promptValueOf(node.data) : '');

  const commit = (value: string) => {
    if (!node) return;
    if (!editing.current) {
      beginEdit();
      editing.current = true;
    }
    // M05-B2 HIGH fix: write the node's PRIMARY text parameter via
    // updateNodeParameter (schema authority = registry parameterSchema key),
    // not only the denormalized data.prompt. updateNodeParameter owns
    // STALE/readiness propagation AND the data.prompt denormalization mirror
    // for 'prompt'/'scriptText' — so no explicit data.prompt write is needed
    // here (the render path promptValueOf reads parameters.* first).
    const key = primaryTextParameterKey(node.data.nodeKind);
    if (key) {
      updateNodeParameter(node.id, key, value);
    } else {
      // kinds without a schema text parameter (e.g. generation nodes) keep the
      // legacy denormalized data.prompt mirror that promptValueOf falls back to.
      updateNodeData(node.id, { prompt: value });
    }
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

        {isGeneration && def?.modelField && (
          <div data-test="composer-model-row" className="mb-1.5 flex items-center gap-2">
            <span className="shrink-0 text-[10px] text-ml2-text-3">Model</span>
            <select
              data-test="composer-model-select"
              value={selectedModel}
              onChange={(e) => {
                if (!node) return;
                if (!editing.current) { beginEdit(); editing.current = true; }
                updateNodeParameter(node.id, def.modelField!, e.target.value);
                flushRef.current && window.clearTimeout(flushRef.current);
                flushRef.current = window.setTimeout(flush, 800);
              }}
              className="min-w-0 flex-1 rounded-lg border border-ml2-border bg-ml2-surface-0 px-2 py-1 text-[11px] text-ml2-text outline-none focus:border-ml2-accent/60"
            >
              {capableModels.length === 0 && <option value="">{modelName || '模型列表加载中 / 无可用模型'}</option>}
              {capableModels.map((m) => (
                <option key={m.bindingId} value={m.bindingId}>{m.name}</option>
              ))}
            </select>
          </div>
        )}

        {refs.length > 0 && (
          <div data-test="composer-ref-chips" className="mb-1 flex flex-wrap gap-1">
            {refs.map((r, i) => {
              const res = resolutions[r.token];
              const bound = boundRefs[r.token];
              const opts = bound ? [bound] : (res?.candidates?.length ? res.candidates : res?.binding ? [res.binding] : []);
              if (opts.length === 0) {
                return (
                  <span key={`${r.token}-${i}`} data-test="composer-ref-chip" className="rounded-full border border-ml2-accent/30 bg-ml2-accent/10 px-2 py-px text-[10px] text-ml2-accent">
                    @{r.token}
                  </span>
                );
              }
              const boundId = bound ? `${bound.entityType}:${bound.entityId}` : '';
              return (
                <select
                  key={`${r.token}-${i}`}
                  data-test="composer-ref-chip"
                  aria-label={`绑定 ${r.token}`}
                  value={boundId}
                  onChange={(e) => {
                    const pick = opts.find((o) => `${o.entityType}:${o.entityId}` === e.target.value);
                    chooseBinding(r.token, pick ?? null);
                  }}
                  className={cn(
                    'max-w-52 cursor-pointer rounded-full border px-2 py-px text-[10px] outline-none',
                    bound ? 'border-ml2-accent/60 bg-ml2-accent/20 text-ml2-accent' : 'border-ml2-border bg-ml2-surface-1 text-ml2-text-2',
                  )}
                >
                  <option value="">@{r.token}（未绑定）</option>
                  {opts.map((o, oi) => (
                    <option key={`${o.entityType}:${o.entityId}-${oi}`} value={`${o.entityType}:${o.entityId}`}>
                      {o.entityType} / {o.canonicalName ?? r.token}
                    </option>
                  ))}
                </select>
              );
            })}
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
              {slashHints.filter((s) => s.startsWith(slash.slash)).map((s) => (
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
