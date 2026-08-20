"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import { apiGetModels } from "@/services/api";
import type { CanvasNode, CanvasNodeData, CanvasNodeKind } from "./types";
import { NODE_KIND_META } from "./types";

/** 画布可选的模型（按 modelType 过滤后的启用模型） */
export interface CanvasModelOption {
  modelId: string;
  label: string;
}

interface CanvasContextValue {
  nodes: CanvasNode[];
  edges: Edge[];
  onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  addNode: (kind: CanvasNodeKind, position: { x: number; y: number }) => void;
  updateNodeData: (id: string, patch: Partial<CanvasNodeData>) => void;
  /** 收集上游已完成节点的内容：text 数组 + image URL 数组 */
  upstreamContext: (id: string) => { text: string[]; images: string[] };
  /** 各 node kind 对应的可用模型列表 */
  modelsByType: Record<"text" | "image" | "video", CanvasModelOption[]>;
}

const CanvasContext = createContext<CanvasContextValue | null>(null);

let nodeSeq = 0;

export function CanvasProvider({ children }: { children: ReactNode }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [modelsByType, setModelsByType] = useState<
    Record<"text" | "image" | "video", CanvasModelOption[]>
  >({ text: [], image: [], video: [] });

  // 拉取启用模型，按 type 归类（image/video/text）
  useEffect(() => {
    let alive = true;
    apiGetModels().then((list: any[]) => {
      if (!alive) return;
      const bucket: Record<"text" | "image" | "video", CanvasModelOption[]> = {
        text: [],
        image: [],
        video: [],
      };
      for (const m of list || []) {
        const t = m?.type;
        if (t !== "text" && t !== "image" && t !== "video") continue;
        if (m?.enabled === false) continue;
        bucket[t].push({
          modelId: m.modelId || m.id || "",
          label: m.mappingName || m.displayName || m.modelId || m.id || "",
        });
      }
      setModelsByType(bucket);
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const onConnect = useCallback(
    (connection: Connection) =>
      setEdges((es) => addEdge({ ...connection, animated: true }, es)),
    [setEdges],
  );

  const addNode = useCallback(
    (kind: CanvasNodeKind, position: { x: number; y: number }) => {
      const meta = NODE_KIND_META[kind];
      const options = modelsByType[meta.modelType];
      const first = options[0];
      nodeSeq += 1;
      setNodes((ns) => [
        ...ns,
        {
          id: `${kind}-${nodeSeq}-${Date.now()}`,
          type: "canvas",
          position,
          data: {
            kind,
            prompt: "",
            model: first?.modelId ?? "",
            modelLabel: first?.label ?? "",
            content: null,
            status: "idle",
          },
        },
      ]);
    },
    [setNodes, modelsByType],
  );

  const updateNodeData = useCallback(
    (id: string, patch: Partial<CanvasNodeData>) => {
      setNodes((ns) =>
        ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
      );
    },
    [setNodes],
  );

  const upstreamContext = useCallback(
    (id: string) => {
      const text: string[] = [];
      const images: string[] = [];
      for (const e of edges) {
        if (e.target !== id) continue;
        const src = nodes.find((n) => n.id === e.source);
        if (!src || src.data.status !== "done" || !src.data.content) continue;
        if (src.data.kind === "image") images.push(src.data.content);
        else text.push(src.data.content);
      }
      return { text, images };
    },
    [edges, nodes],
  );

  const value = useMemo(
    () => ({
      nodes,
      edges,
      onNodesChange,
      onEdgesChange,
      onConnect,
      addNode,
      updateNodeData,
      upstreamContext,
      modelsByType,
    }),
    [nodes, edges, onNodesChange, onEdgesChange, onConnect, addNode, updateNodeData, upstreamContext, modelsByType],
  );

  return <CanvasContext.Provider value={value}>{children}</CanvasContext.Provider>;
}

export function useCanvas() {
  const ctx = useContext(CanvasContext);
  if (!ctx) throw new Error("useCanvas must be used within CanvasProvider");
  return ctx;
}
