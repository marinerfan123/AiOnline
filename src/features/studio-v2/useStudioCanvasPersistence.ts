import { useEffect, useRef, useState } from 'react';
import type { Viewport } from '@xyflow/react';
import { useStudioStore, type StudioEdge, type StudioNode } from './store';
import { AUTOSAVE_DEBOUNCE_MS, DirtyOperationBuffer, deserializeStudioEdge, deserializeStudioNode, serializeStudioEdge, serializeStudioNode, type CanvasPatchRequest } from './persistence';
import { v2studio, StudioCanvasApiError } from '@/shared/api/contract/studio-canvas-client';
import type { StudioCanvasResponse } from '@/shared/api/contract/schemas';
import { parseConflictInfo, type ConflictInfo } from './schemas';

export type SaveStatus = 'Loading' | 'Saved' | 'Saving' | 'Unsaved' | 'Offline' | 'Save failed' | 'Conflict';

function mutationId() {
  return (globalThis.crypto && 'randomUUID' in globalThis.crypto) ? globalThis.crypto.randomUUID() : `cm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function nodeKey(n: StudioNode) { return n.id; }
function edgeKey(e: StudioEdge) { return e.id; }
function nodeSig(n: StudioNode) { return JSON.stringify(serializeStudioNode(n)); }
function edgeSig(e: StudioEdge) { return JSON.stringify(serializeStudioEdge(e)); }
function viewportSig(v: Viewport) { return `${v.x}:${v.y}:${v.zoom}`; }

// serverRevision/canvasId are guaranteed present once a 409 is classified as a
// conflict (parseConflict's gate below), so the hook-facing shape narrows the
// wire type's optional serverRevision to the number rebase/retry actually uses.
type ResolvedConflict = ConflictInfo & { serverRevision: number; canvasId: string };

export function useStudioCanvasPersistence(projectId: string, enabled = true) {
  const [status, setStatus] = useState<SaveStatus>('Loading');
  const [revision, setRevision] = useState<number | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ResolvedConflict | null>(null);
  const bufferRef = useRef(new DirtyOperationBuffer());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revisionRef = useRef<number | null>(null);
  const suppressRef = useRef(false);
  const blockedRef = useRef(false);
  const conflictRef = useRef<ResolvedConflict | null>(null);
  // F2: single-flight mutex + pending flag so concurrent flush requests are
  // serialized instead of racing with a stale baseRevision (self-inflicted 409).
  const inFlightRef = useRef(false);
  const pendingFlushRef = useRef(false);
  const prevNodesRef = useRef(new Map<string, string>());
  const prevEdgesRef = useRef(new Map<string, string>());
  const prevViewportRef = useRef('');

  const markClean = (nodes: StudioNode[], edges: StudioEdge[], viewport: Viewport) => {
    prevNodesRef.current = new Map(nodes.map((n) => [nodeKey(n), nodeSig(n)]));
    prevEdgesRef.current = new Map(edges.map((e) => [edgeKey(e), edgeSig(e)]));
    prevViewportRef.current = viewportSig(viewport);
  };

  const commitAndSave = (res: StudioCanvasResponse, patch: CanvasPatchRequest) => {
    // Drop only the ops we just applied; edits that landed mid-flight stay queued.
    bufferRef.current.commitSnapshot(patch);
    const rev = res.canvas!.revision;
    revisionRef.current = rev;
    setRevision(rev);
    setLastSavedAt(new Date().toISOString());
    setStatus('Saved');
    markClean(useStudioStore.getState().nodes, useStudioStore.getState().edges, useStudioStore.getState().viewport);
  };

  // Classifies a 409 as a canvas conflict only when it carries the core rebase
  // fields — the same gate as before the G22 extension. kindPolicy/commandSeq
  // are additive: parsed off the raw body, undefined when the server has not
  // merged them yet (legacy body → behaviour unchanged).
  const parseConflict = (e: StudioCanvasApiError): ResolvedConflict | null => {
    if (e.status !== 409 || !e.serverRevision || !e.canvasId) return null;
    const { kindPolicy, commandSeq } = parseConflictInfo(e.body);
    return { serverRevision: e.serverRevision, canvasId: e.canvasId, kindPolicy, commandSeq };
  };

  // One patch attempt against `baseRevision`. Returns the patch that was peeked
  // so the caller can commit exactly those ops on success.
  const attempt = async (baseRevision: number, cmid: string) => {
    const patch = bufferRef.current.peek({ baseRevision, clientMutationId: cmid });
    try {
      const res = await v2studio.patchCanvas(projectId, patch);
      if (!res.canvas) throw new Error('missing canvas');
      return { ok: true as const, res, patch };
    } catch (e) {
      if (e instanceof StudioCanvasApiError) {
        const conflict = parseConflict(e);
        if (conflict) return { ok: false as const, conflict };
      }
      return { ok: false as const, error: e };
    }
  };

  const doFlush = async () => {
    if (blockedRef.current || !projectId || revisionRef.current == null) return;
    if (bufferRef.current.isEmpty()) return;
    setStatus('Saving');

    const cmid = mutationId();
    const first = await attempt(revisionRef.current, cmid);

    if (first.ok) { commitAndSave(first.res, first.patch); return; }

    if (first.conflict) {
      // F1: server has moved past our base. Keep the uncommitted buffer and
      // replay once on top of the server's revision.
      // Kind policy routing today: 'lww'/'merge' → this same F1 retry (their
      // incremental rebase semantics); 'reject409'/undefined (legacy body) →
      // the whole-canvas reload semantics below (current logic, unchanged);
      // 'append' has no client path yet (conflictClientMode() in ./schemas).
      const rebased = await attempt(first.conflict.serverRevision, mutationId());
      if (rebased.ok) { commitAndSave(rebased.res, rebased.patch); return; }
      if (rebased.conflict) {
        // Still conflicting: enter conflict state, but KEEP the buffer so the
        // user's local edits survive for a later retry.
        blockedRef.current = true;
        conflictRef.current = rebased.conflict;
        setConflict(rebased.conflict);
        setStatus('Conflict');
        return;
      }
      setStatus(navigator.onLine === false ? 'Offline' : 'Save failed');
      return;
    }

    // Non-conflict failure (network, transient): retry once with the SAME
    // clientMutationId so the server's idempotency guard dedupes a patch that
    // committed but lost its response (F2).
    const retried = await attempt(revisionRef.current, cmid);
    if (retried.ok) { commitAndSave(retried.res, retried.patch); return; }
    setStatus(navigator.onLine === false ? 'Offline' : 'Save failed');
  };

  // F2 serialization gate: at most one flush in flight. A flush requested while
  // one is running is queued and re-run after the current one settles.
  const flush = () => {
    if (blockedRef.current) return;
    if (inFlightRef.current) { pendingFlushRef.current = true; return; }
    inFlightRef.current = true;
    void (async () => {
      try {
        await doFlush();
      } finally {
        inFlightRef.current = false;
        if (pendingFlushRef.current && !blockedRef.current) {
          pendingFlushRef.current = false;
          flush();
        }
      }
    })();
  };

  const schedule = () => {
    if (blockedRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    setStatus((s) => (s === 'Saving' ? s : 'Unsaved'));
    timerRef.current = setTimeout(() => { void flush(); }, AUTOSAVE_DEBOUNCE_MS);
  };

  const reloadFromServer = async () => {
    if (!projectId) return;
    setStatus('Loading');
    blockedRef.current = false;
    conflictRef.current = null;
    setConflict(null);
    // Reload discards any uncommitted local edits (explicit user action).
    bufferRef.current.clear();
    const res = await v2studio.getCanvas(projectId);
    const data = res.canvas ? res : await v2studio.createCanvas(projectId, { name: 'Primary Canvas' });
    const nodes = data.nodes.map(deserializeStudioNode);
    const edges = data.edges.map(deserializeStudioEdge);
    suppressRef.current = true;
    useStudioStore.getState().loadGraph(nodes, edges, data.viewport ?? { x: 0, y: 0, zoom: 1 });
    suppressRef.current = false;
    const rev = data.canvas?.revision ?? 1;
    revisionRef.current = rev;
    setRevision(rev);
    setLastSavedAt(data.canvas?.updatedAt ?? null);
    markClean(nodes, edges, data.viewport ?? { x: 0, y: 0, zoom: 1 });
    setStatus('Saved');
  };

  useEffect(() => {
    if (!enabled || !projectId) return;
    void reloadFromServer().catch(() => setStatus('Save failed'));
    const unsub = useStudioStore.subscribe((state) => {
      // NOTE: edits keep buffering even while blocked (conflict) so the retained
      // buffer accumulates any further local work for the user's later retry.
      if (suppressRef.current || revisionRef.current == null) return;
      const prevNodes = prevNodesRef.current;
      const nextNodes = new Map(state.nodes.map((n) => [nodeKey(n), nodeSig(n)]));
      for (const n of state.nodes) if (prevNodes.get(n.id) !== nextNodes.get(n.id)) bufferRef.current.upsertNode(n);
      for (const id of prevNodes.keys()) if (!nextNodes.has(id)) bufferRef.current.deleteNode(id);
      const prevEdges = prevEdgesRef.current;
      const nextEdges = new Map(state.edges.map((e) => [edgeKey(e), edgeSig(e)]));
      for (const e of state.edges) if (prevEdges.get(e.id) !== nextEdges.get(e.id)) bufferRef.current.upsertEdge(e);
      for (const id of prevEdges.keys()) if (!nextEdges.has(id)) bufferRef.current.deleteEdge(id);
      if (prevViewportRef.current !== viewportSig(state.viewport)) bufferRef.current.viewport(state.viewport);
      if (!bufferRef.current.isEmpty()) schedule();
    });
    return () => { unsub(); if (timerRef.current) clearTimeout(timerRef.current); };
  }, [projectId, enabled]);

  const retry = () => {
    if (blockedRef.current) {
      // Adopt the server's revision as the new base so the retained buffer
      // replays on top of the latest server state.
      const c = conflictRef.current;
      if (c) {
        revisionRef.current = c.serverRevision;
        setRevision(c.serverRevision);
      }
      blockedRef.current = false;
      conflictRef.current = null;
      setConflict(null);
    }
    flush();
  };

  return { status, revision, lastSavedAt, conflict, retry, reloadFromServer };
}
