import { useEffect, useRef, useState } from 'react';
import type { Viewport } from '@xyflow/react';
import { useStudioStore, type StudioEdge, type StudioNode } from './store';
import { AUTOSAVE_DEBOUNCE_MS, DirtyOperationBuffer, deserializeStudioEdge, deserializeStudioNode, serializeStudioEdge, serializeStudioNode } from './persistence';
import { v2studio, StudioCanvasApiError } from '@/shared/api/contract/studio-canvas-client';

export type SaveStatus = 'Loading' | 'Saved' | 'Saving' | 'Unsaved' | 'Offline' | 'Save failed' | 'Conflict';

function mutationId() {
  return (globalThis.crypto && 'randomUUID' in globalThis.crypto) ? globalThis.crypto.randomUUID() : `cm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function nodeKey(n: StudioNode) { return n.id; }
function edgeKey(e: StudioEdge) { return e.id; }
function nodeSig(n: StudioNode) { return JSON.stringify(serializeStudioNode(n)); }
function edgeSig(e: StudioEdge) { return JSON.stringify(serializeStudioEdge(e)); }
function viewportSig(v: Viewport) { return `${v.x}:${v.y}:${v.zoom}`; }

export function useStudioCanvasPersistence(projectId: string, enabled = true) {
  const [status, setStatus] = useState<SaveStatus>('Loading');
  const [revision, setRevision] = useState<number | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ serverRevision: number; canvasId: string } | null>(null);
  const bufferRef = useRef(new DirtyOperationBuffer());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revisionRef = useRef<number | null>(null);
  const suppressRef = useRef(false);
  const blockedRef = useRef(false);
  const prevNodesRef = useRef(new Map<string, string>());
  const prevEdgesRef = useRef(new Map<string, string>());
  const prevViewportRef = useRef('');

  const markClean = (nodes: StudioNode[], edges: StudioEdge[], viewport: Viewport) => {
    prevNodesRef.current = new Map(nodes.map((n) => [nodeKey(n), nodeSig(n)]));
    prevEdgesRef.current = new Map(edges.map((e) => [edgeKey(e), edgeSig(e)]));
    prevViewportRef.current = viewportSig(viewport);
  };

  const flush = async () => {
    if (blockedRef.current || bufferRef.current.isEmpty() || !projectId || revisionRef.current == null) return;
    const baseRevision = revisionRef.current;
    const patch = bufferRef.current.flush({ baseRevision, clientMutationId: mutationId() });
    setStatus('Saving');
    try {
      const res = await v2studio.patchCanvas(projectId, patch);
      if (!res.canvas) throw new Error('missing canvas');
      revisionRef.current = res.canvas.revision;
      setRevision(res.canvas.revision);
      setLastSavedAt(new Date().toISOString());
      setStatus('Saved');
      markClean(useStudioStore.getState().nodes, useStudioStore.getState().edges, useStudioStore.getState().viewport);
    } catch (e) {
      if (e instanceof StudioCanvasApiError && e.status === 409 && e.serverRevision && e.canvasId) {
        blockedRef.current = true;
        setConflict({ serverRevision: e.serverRevision, canvasId: e.canvasId });
        setStatus('Conflict');
        return;
      }
      setStatus(navigator.onLine === false ? 'Offline' : 'Save failed');
    }
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
    setConflict(null);
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
      if (suppressRef.current || revisionRef.current == null || blockedRef.current) return;
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

  const retry = () => { if (!blockedRef.current) void flush(); };
  return { status, revision, lastSavedAt, conflict, retry, reloadFromServer };
}
