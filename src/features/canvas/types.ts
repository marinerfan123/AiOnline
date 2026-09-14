// 无限画布节点类型定义（接入 moling 真实生成能力）
import type { Node } from "@xyflow/react";

export type CanvasNodeKind = "text" | "image" | "video" | "script";

/** 节点数据类型：content 对 text/script 为正文，对 image/video 为媒体 URL */
export interface CanvasNodeData extends Record<string, unknown> {
  kind: CanvasNodeKind;
  prompt: string;
  /** modelId（canonical 机器运行标识，传给后端优先） */
  model: string;
  /** 展示名（dropdown 显示 / 兼容旧客户端 model 字段） */
  modelLabel: string;
  content: string | null;
  status: "idle" | "generating" | "done" | "error";
  error?: string;
}

export type CanvasNode = Node<CanvasNodeData>;

/** 每种节点对应的 moling 模型类型（text 推理 / image 生图 / video 生视频） */
export const NODE_KIND_META: Record<
  CanvasNodeKind,
  { label: string; icon: string; accent: string; modelType: "text" | "image" | "video" }
> = {
  text:   { label: "文本", icon: "📝", accent: "#3b82f6", modelType: "text" },
  image:  { label: "图片", icon: "🖼️", accent: "#8b5cf6", modelType: "image" },
  video:  { label: "视频", icon: "🎥", accent: "#f59e0b", modelType: "video" },
  script: { label: "脚本", icon: "🎬", accent: "#ef4444", modelType: "text" },
};

export const CANVAS_KINDS = Object.keys(NODE_KIND_META) as CanvasNodeKind[];
