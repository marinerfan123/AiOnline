"use client";

import { useCallback, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
  ReactFlowProvider,
  useReactFlow,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { CanvasProvider, useCanvas } from "./store";
import { CanvasNodeComponent } from "./CanvasNode";
import { CANVAS_KINDS, NODE_KIND_META, type CanvasNodeKind } from "./types";

const nodeTypes: NodeTypes = { canvas: CanvasNodeComponent };

function NodePicker({
  at,
  onPick,
  onClose,
}: {
  at: { x: number; y: number };
  onPick: (kind: CanvasNodeKind) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute z-50 w-36 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
      style={{ left: at.x, top: at.y }}
      onMouseLeave={onClose}
    >
      <div className="px-3 py-1.5 text-[10px] text-zinc-500">添加节点</div>
      {CANVAS_KINDS.map((kind) => (
        <button
          key={kind}
          onClick={() => onPick(kind)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-200 hover:bg-zinc-800"
        >
          <span>{NODE_KIND_META[kind].icon}</span>
          {NODE_KIND_META[kind].label}节点
        </button>
      ))}
    </div>
  );
}

function Toolbar() {
  const { addNode } = useCanvas();
  const { screenToFlowPosition } = useReactFlow();

  const addAtCenter = (kind: CanvasNodeKind) => {
    const pos = screenToFlowPosition({
      x: window.innerWidth / 2 + (Math.random() - 0.5) * 120,
      y: window.innerHeight / 2 + (Math.random() - 0.5) * 120,
    });
    addNode(kind, pos);
  };

  return (
    <div className="absolute left-4 top-1/2 z-40 flex -translate-y-1/2 flex-col gap-1 rounded-xl border border-zinc-800 bg-zinc-900/90 p-2 backdrop-blur">
      <div className="px-1 pb-1 text-[10px] text-zinc-500">添加</div>
      {CANVAS_KINDS.map((kind) => (
        <button
          key={kind}
          title={`新建${NODE_KIND_META[kind].label}节点`}
          onClick={() => addAtCenter(kind)}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-lg hover:bg-zinc-800"
        >
          {NODE_KIND_META[kind].icon}
        </button>
      ))}
    </div>
  );
}

function CanvasInner() {
  const { nodes, edges, onNodesChange, onEdgesChange, onConnect, addNode } = useCanvas();
  const { screenToFlowPosition } = useReactFlow();
  const [picker, setPicker] = useState<{
    screen: { x: number; y: number };
    flow: { x: number; y: number };
  } | null>(null);

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains("react-flow__pane")) return;
      setPicker({
        screen: { x: e.clientX, y: e.clientY },
        flow: screenToFlowPosition({ x: e.clientX, y: e.clientY }),
      });
    },
    [screenToFlowPosition],
  );

  return (
    <div className="h-full w-full" onDoubleClick={onDoubleClick}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        zoomOnDoubleClick={false}
        minZoom={0.1}
        fitView
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
        deleteKeyCode={["Delete", "Backspace"]}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} />
        <MiniMap pannable zoomable position="bottom-left" />
        <Controls position="bottom-right" />
      </ReactFlow>
      <Toolbar />
      {picker && (
        <NodePicker
          at={picker.screen}
          onPick={(kind) => {
            addNode(kind, picker.flow);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      <div className="pointer-events-none absolute left-1/2 top-4 z-40 -translate-x-1/2 rounded-full border border-zinc-800 bg-zinc-900/80 px-4 py-1.5 text-xs text-zinc-400 backdrop-blur">
        双击画布空白处新建节点 · 拖拽节点两侧圆点连线搭建工作流
      </div>
    </div>
  );
}

export default function InfiniteCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasProvider>
        <CanvasInner />
      </CanvasProvider>
    </ReactFlowProvider>
  );
}
