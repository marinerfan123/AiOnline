// M05-A — Studio Canvas (center). React Flow wrapper with:
// pan/zoom/minimap/controls, drag-from-library, context menu, invalid
// connection feedback, empty state, keyboard shortcuts, node error isolation.

import { useCallback, useEffect, useRef, useState, useMemo, Component, type ReactNode } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
  useReactFlow,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  useStudioStore,
  selectCanUndo,
  selectCanRedo,
  studioCanvasActions,
} from './store';
import { StudioNodeComponent } from './StudioNode';
import { NODE_DEFS_LIST, canConnectToPort, getNodeDef } from './registry';
import type { StudioNodeKind } from './types';
import type { PortType } from './types';
import { Button } from '@/shared/ui/v2/Button';
import { IconButton } from '@/shared/ui/v2/IconButton';
import { Undo2, Redo2, Maximize2, Scan, X, Copy, Trash2 } from "lucide-react";

const nodeTypes: NodeTypes = { studio: StudioNodeComponent };

// ── Error boundary: one broken node renderer must not white-screen Studio ──
class StudioErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div data-test="studio-error-boundary" className="grid h-full w-full place-items-center bg-ml2-surface-0 p-8">
          <div className="max-w-sm rounded-lg border border-ml2-border bg-ml2-surface-1 p-5 text-center">
            <p className="mb-1 text-sm font-medium text-ml2-text">Studio 渲染出现错误</p>
            <p className="mb-4 text-xs text-ml2-text-3">某个节点渲染器出错已被隔离。可以尝试重新加载 Studio。</p>
            <Button variant="secondary" size="sm" onClick={() => location.reload()}>重新加载</Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function ContextMenu({
  at,
  onAdd,
  onClose,
  kinds,
  header,
}: {
  at: { x: number; y: number };
  onAdd: (k: StudioNodeKind) => void;
  onClose: () => void;
  kinds?: StudioNodeKind[]; // G05 edge-to-empty: filtered to compatible targets
  header?: string;
}) {
  // M05-B2: derived from the registry (never a hardcoded second node list).
  const allKinds = useMemo(() => NODE_DEFS_LIST.map((d) => d.id), []);
  const list = kinds ?? allKinds;
  return (
    <div
      data-test="canvas-context-menu"
      className="absolute z-50 w-44 overflow-hidden rounded-lg border border-ml2-border bg-ml2-surface-1 py-1 shadow-2xl"
      style={{ left: at.x, top: at.y }}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
    >
      <div className="px-3 py-1 text-[10px] text-ml2-text-3">{header ?? '在此处添加节点'}</div>
      {list.map((k) => {
        const def = NODE_DEFS_LIST.find((d) => d.id === k);
        return (
          <button key={k} data-test={`context-menu-${k}`} onClick={() => { onAdd(k); onClose(); }}
            className="block w-full px-3 py-1.5 text-left text-xs text-ml2-text-2 hover:bg-ml2-surface-2 hover:text-ml2-text">
            {def?.title ?? k}
          </button>
        );
      })}
    </div>
  );
}

function InvalidConnectionToast() {
  const info = useStudioStore((s) => s.invalidConnection);
  const clear = useStudioStore((s) => s.clearInvalidConnection);
  useEffect(() => {
    if (!info) return;
    const t = setTimeout(clear, 3000);
    return () => clearTimeout(t);
  }, [info, clear]);
  if (!info) return null;
  return (
    <div data-test="invalid-connection-toast" role="alert"
      className="absolute left-1/2 top-4 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-red-500/40 bg-ml2-surface-1 px-4 py-1.5 text-xs text-red-400 shadow-lg">
      {info.message}
      <button onClick={clear} aria-label="关闭" className="rounded p-0.5 hover:bg-ml2-surface-3"><X className="size-3" /></button>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: (k: StudioNodeKind) => void }) {
  return (
    <div data-test="studio-empty-state" className="pointer-events-none absolute inset-0 grid place-items-center">
      <div className="pointer-events-auto w-80 rounded-xl border border-ml2-border bg-ml2-surface-1/95 p-5 text-center shadow-xl backdrop-blur">
        <h2 className="text-sm font-semibold text-ml2-text">开始搭建你的 Creative Flow</h2>
        <p className="mt-1 text-[11px] text-ml2-text-3">从 Prompt 出发，连接参考素材与媒体节点（会话态，M05-C 接入正式保存）。</p>
        <div className="mt-4 grid grid-cols-3 gap-1.5">
          <Button size="sm" variant="primary" data-test="empty-add-prompt" onClick={() => onAdd('prompt')}>Start with Prompt</Button>
          <Button size="sm" variant="secondary" data-test="empty-add-reference" onClick={() => onAdd('reference')}>Add Reference</Button>
          <Button size="sm" variant="secondary" data-test="empty-add-image" onClick={() => onAdd('image-generation')}>Add Image Generation</Button>
        </div>
        <p className="mt-3 text-[10px] text-ml2-text-3">或在左侧 Node Library 拖拽 · 或双击画布空白处快速添加</p>
      </div>
    </div>
  );
}

function CanvasCore() {
  const nodes = useStudioStore((s) => s.nodes);
  const edges = useStudioStore((s) => s.edges);
  const onNodesChange = useStudioStore((s) => s.onNodesChange);
  const onEdgesChange = useStudioStore((s) => s.onEdgesChange);
  const onConnect = useStudioStore((s) => s.onConnect);
  const addNode = useStudioStore((s) => s.addNode);
  const undo = useStudioStore((s) => s.undo);
  const redo = useStudioStore((s) => s.redo);
  const canUndo = useStudioStore(selectCanUndo);
  const canRedo = useStudioStore(selectCanRedo);
  const removeSelection = useStudioStore((s) => s.removeSelection);
  const duplicateSelection = useStudioStore((s) => s.duplicateSelection);
  const copySelection = useStudioStore((s) => s.copySelection);
  const selectAll = useStudioStore((s) => s.selectAll);
  const paste = useStudioStore((s) => s.paste);
  const onNodeDragStart = useStudioStore((s) => s.onNodeDragStart);
  const onNodeDragStop = useStudioStore((s) => s.onNodeDragStop);
  const onViewportChange = useStudioStore((s) => s.onViewportChange);
  const [menu, setMenu] = useState<{
    x: number; y: number; fx: number; fy: number;
    edgeFrom?: { nodeId: string; handleId: string; portType: PortType };
  } | null>(null);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const canvasRef = useRef<HTMLDivElement>(null);

  // G05 edge-to-empty: node kinds whose input accepts the dragged output type.
  const compatibleTargetKinds = useCallback((portType: PortType): StudioNodeKind[] => {
    const out: StudioNodeKind[] = [];
    for (const def of NODE_DEFS_LIST) {
      if (def.inputPorts.some((p) => canConnectToPort(portType, p))) out.push(def.id);
    }
    return out;
  }, []);

  // First compatible input port id of a target node kind for the output type.
  const firstCompatibleInput = useCallback((kind: StudioNodeKind, portType: PortType): string | null => {
    const def = NODE_DEFS_LIST.find((d) => d.id === kind);
    if (!def) return null;
    const port = def.inputPorts.find((p) => canConnectToPort(portType, p));
    return port?.id ?? null;
  }, []);

  // Controlled pattern: the zustand store is the single source of truth.
  // onNodesChange (position/selection/dimensions) is applied back via applyNodeChanges.

  const addAtCenter = useCallback((kind: StudioNodeKind) => {
    // Use the ACTUAL canvas container rect (not the window) — the RF container
    // is the center region between the library and inspector. Mapping the
    // container center through screenToFlowPosition guarantees the new node
    // lands in the visible viewport.
    const rect = canvasRef.current?.getBoundingClientRect();
    const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    const flow = screenToFlowPosition({ x: cx, y: cy });
    // Cascade onto a NON-overlapping grid (nodes are ~240-320px wide/tall):
    // 3 columns across, then wrap down. This keeps new nodes visible AND
    // distinct, so handles stay reachable for connections.
    const i = useStudioStore.getState().nodes.length;
    const col = i % 3;
    const row = Math.floor(i / 3);
    const id = addNode(kind, {
      // M05-B2: wide cascade (>= card width + handle gutter) so input handles of
      // a newly added node never overlap the output handles of the previous one
      // — connection drags must start/end on the handle, not on a card body.
      x: flow.x - 160 + col * 420,
      y: flow.y - 120 + row * 300,
    });
    // Focus the newly added node so it is always visible and reachable, even
    // under onlyRenderVisibleElements culling. maxZoom:1 keeps zoom sane
    // (no extreme zoom-in); use the fit-all control to see the whole graph.
    if (id) {
      requestAnimationFrame(() => fitView({ nodes: [{ id }], duration: 200, padding: 0.35, maxZoom: 1 }));
    }
    return id;
  }, [addNode, screenToFlowPosition, fitView]);

  // Expose "add at viewport center" to consumers outside the RF provider
  // (Node Library), so new nodes always land in the visible viewport.
  useEffect(() => {
    studioCanvasActions.addAtViewportCenter = addAtCenter;
    return () => {
      studioCanvasActions.addAtViewportCenter = () => null;
    };
  }, [addAtCenter]);

  // keyboard shortcuts (canvas-scoped; text inputs keep native editing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const inField = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
      if (e.key === 'Escape') {
        setMenu(null);
        return;
      }
      if (inField) return; // never fight text editing (native undo/copy/delete)
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return; }
      if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); useStudioStore.getState().groupSelection(); return; }
      if (mod && e.key.toLowerCase() === 'c') { copySelection(); return; }
      if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); paste(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { removeSelection(); }
      // G02 canvas input contract (Blueprint 02 §3): F = fit selected, Shift+F = fit all.
      if (!mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        const selectedIds = useStudioStore.getState().nodes.filter((n) => n.selected).map((n) => n.id);
        if (!e.shiftKey && selectedIds.length > 0) {
          fitView({ nodes: selectedIds.map((id) => ({ id })), padding: 0.3, maxZoom: 1.5, duration: 250 });
        } else {
          fitView({ padding: 0.15, duration: 250 });
        }
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, duplicateSelection, copySelection, paste, removeSelection, selectAll, fitView]);

  return (
    <div ref={canvasRef} data-test="studio-canvas" className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onMoveEnd={(_, v) => onViewportChange(v)}
        defaultEdgeOptions={{ style: { stroke: '#52525b', strokeWidth: 1.5 }, type: 'smoothstep' }}
        minZoom={0.05}
        maxZoom={2}
        onlyRenderVisibleElements
        fitView
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
        deleteKeyCode={null} // we own Delete (input-guarded) in the keyboard handler
        selectionOnDrag // LMB blank drag = box select (Blueprint 02 §3)
        panOnDrag={[1]} // middle-mouse pan; Space+LMB pan via panActivationKeyCode
        panActivationKeyCode="Space"
        zoomOnDoubleClick={false} // reserve double-click for node-create menu (G05)
        zoomOnScroll
        onPaneContextMenu={(e) => {
          const ev = (e as unknown as { clientX: number; clientY: number });
          const el = e.currentTarget ?? canvasRef.current;
          const rect = (el as HTMLElement).getBoundingClientRect();
          const x = ev.clientX - rect.left;
          const y = ev.clientY - rect.top;
          const f = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
          setMenu({ x, y, fx: f.x, fy: f.y });
        }}
        onDrop={(e) => {
          e.preventDefault();
          const kind = e.dataTransfer.getData('application/x-studio-node-kind') as StudioNodeKind;
          if (kind && getNodeDef(kind)) {
            const f = screenToFlowPosition({ x: e.clientX, y: e.clientY });
            addNode(kind, { x: f.x - 120, y: f.y - 60 });
          }
          // Real file drop (G05 interaction): creates a Reference node at the
          // drop point; the actual upload→asset binding ships with G06.
          const hasFile = e.dataTransfer?.files?.length > 0;
          if (hasFile) {
            const f = screenToFlowPosition({ x: e.clientX, y: e.clientY });
            addNode('reference', { x: f.x - 120, y: f.y - 60 });
          }
        }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
        onConnectEnd={(event, connectionState) => {
          // G05 edge-to-empty: a connection drag released over blank canvas opens
          // a filtered create menu (compatible target node kinds only).
          const from = connectionState?.fromNode;
          const fromHandle = connectionState?.fromHandle;
          const droppedOnTarget = connectionState?.toNode;
          if (!from || !fromHandle || droppedOnTarget) return;
          const handleId = (fromHandle as unknown as { id?: string })?.id ?? String(fromHandle);
          const fromDef = getNodeDef(String((from.data as { nodeKind?: string })?.nodeKind ?? from.type));
          const outPort = fromDef?.outputPorts.find((p) => p.id === handleId);
          if (!outPort) return;
          const ev = event as unknown as { clientX?: number; clientY?: number };
          const x = typeof ev.clientX === 'number' ? ev.clientX : 0;
          const y = typeof ev.clientY === 'number' ? ev.clientY : 0;
          const f = screenToFlowPosition({ x, y });
          setMenu({ x: x - 40, y: y - 10, fx: f.x, fy: f.y, edgeFrom: { nodeId: from.id, handleId, portType: outPort.type } });
        }}
        onDoubleClick={(e) => {
          const target = e.target as HTMLElement;
          if (!target.classList.contains('react-flow__pane')) return;
          const f = screenToFlowPosition({ x: e.clientX, y: e.clientY });
          setMenu({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY, fx: f.x, fy: f.y });
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="var(--ml2-border, #3f3f46)" />
        <MiniMap pannable zoomable position="bottom-left" className="!bg-ml2-surface-1 !border !border-ml2-border" maskColor="rgba(0,0,0,0.5)" />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>

      <div className="absolute left-1/2 top-2 z-40 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-ml2-border bg-ml2-surface-1/95 px-1 py-0.5 shadow-md backdrop-blur">
        <IconButton data-test="canvas-undo" label="撤销 (Ctrl+Z)" size="sm" disabled={!canUndo} onClick={undo}><Undo2 className="size-3.5" /></IconButton>
        <IconButton data-test="canvas-redo" label="重做 (Ctrl+Shift+Z)" size="sm" disabled={!canRedo} onClick={redo}><Redo2 className="size-3.5" /></IconButton>
        <IconButton data-test="canvas-copy" label="复制 (Ctrl+C)" size="sm" onClick={copySelection}><Copy className="size-3.5" /></IconButton>
        <IconButton data-test="canvas-duplicate" label="快速复制 (Ctrl+D)" size="sm" onClick={duplicateSelection}><Copy className="size-3.5" /></IconButton>
        <IconButton data-test="canvas-delete" label="删除 (Del)" size="sm" onClick={removeSelection}><Trash2 className="size-3.5" /></IconButton>
        <span className="mx-0.5 h-4 w-px bg-ml2-border" />
        <IconButton data-test="canvas-fit" label="适应全部 (zoom-to-fit)" size="sm" onClick={() => fitView({ padding: 0.15 })}><Maximize2 className="size-3.5" /></IconButton>
        <IconButton data-test="canvas-reset-viewport" label="重置视口" size="sm" onClick={() => fitView({ padding: 0.05, duration: 200 })}><Scan className="size-3.5" /></IconButton>
      </div>

      <InvalidConnectionToast />
      {nodes.length === 0 && <EmptyState onAdd={addAtCenter} />}
      {menu && (
        <ContextMenu
          at={{ x: menu.x, y: menu.y }}
          header={menu.edgeFrom ? '连接到此新节点' : undefined}
          kinds={menu.edgeFrom ? compatibleTargetKinds(menu.edgeFrom.portType) : undefined}
          onAdd={(k) => {
            const id = addNode(k, { x: menu.fx - 120, y: menu.fy - 60 });
            if (id && menu.edgeFrom) {
              const targetHandle = firstCompatibleInput(k, menu.edgeFrom.portType);
              if (targetHandle) {
                onConnect({
                  source: menu.edgeFrom.nodeId,
                  sourceHandle: menu.edgeFrom.handleId,
                  target: id,
                  targetHandle,
                });
              }
            }
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

export function StudioCanvas() {
  return (
    <ReactFlowProvider>
      <StudioErrorBoundary>
        <CanvasCore />
      </StudioErrorBoundary>
    </ReactFlowProvider>
  );
}
