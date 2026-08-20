"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  apiGenerate,
  apiGetGenerationStatus,
  apiOptimizePrompt,
  apiRunSkill,
} from "@/services/api";
import type { CanvasNode as CanvasNodeType } from "./types";
import { NODE_KIND_META } from "./types";
import { useCanvas } from "./store";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function ContentView({ data }: { data: CanvasNodeType["data"] }) {
  if (data.status === "generating") {
    return (
      <div className="flex h-28 items-center justify-center text-xs text-zinc-400">
        <span className="animate-pulse">生成中…</span>
      </div>
    );
  }
  if (data.status === "error") {
    return (
      <div className="flex h-20 items-center justify-center px-2 text-center text-xs text-red-400">
        {data.error || "生成失败，请重试"}
      </div>
    );
  }
  if (!data.content) {
    return (
      <div className="flex h-20 items-center justify-center text-xs text-zinc-500">
        输入提示词并点击生成
      </div>
    );
  }
  if (data.kind === "image") {
    return (
      <img src={data.content} alt="生成图片" className="w-full rounded-md" draggable={false} />
    );
  }
  if (data.kind === "video") {
    return <video src={data.content} controls className="w-full rounded-md" />;
  }
  // text / script
  return (
    <div className="max-h-48 overflow-auto whitespace-pre-wrap p-2 text-xs leading-relaxed text-zinc-200">
      {data.content}
    </div>
  );
}

function CanvasNodeInner({ id, data, selected }: NodeProps<CanvasNodeType>) {
  const meta = NODE_KIND_META[data.kind];
  const { updateNodeData, upstreamContext, modelsByType } = useCanvas();
  const options = modelsByType[meta.modelType];
  const needsModel = data.kind === "image" || data.kind === "video";

  const generate = async () => {
    if (!data.prompt.trim() || data.status === "generating") return;
    updateNodeData(id, { status: "generating", error: undefined });
    const { text: upText, images: upImages } = upstreamContext(id);
    const fullPrompt = [data.prompt, ...upText].filter(Boolean).join("\n");

    try {
      if (data.kind === "image" || data.kind === "video") {
        const r = await apiGenerate({
          model: data.modelLabel || data.model,
          modelId: data.model || undefined,
          prompt: fullPrompt,
          contentType: data.kind,
          count: 1,
          referenceImages: upImages.length ? upImages : undefined,
          idempotencyKey: crypto.randomUUID(),
        });
        if (r.status === "pending" && r.taskId) {
          // 轮询直到终态（预算 120s，2s 间隔）
          for (let i = 0; i < 60; i++) {
            await sleep(2000);
            const st = await apiGetGenerationStatus(r.taskId);
            if (st.status === "done") {
              const url = st.result?.images?.[0] ?? null;
              updateNodeData(id, { content: url, status: "done" });
              return;
            }
            if (st.status === "failed") {
              updateNodeData(id, { status: "error", error: st.error || "生成失败" });
              return;
            }
          }
          updateNodeData(id, { status: "error", error: "生成超时（120s）" });
        } else if (r.status === "success" && r.images?.[0]) {
          updateNodeData(id, { content: r.images[0], status: "done" });
        } else {
          updateNodeData(id, { status: "error", error: r.error || "生成失败" });
        }
      } else if (data.kind === "text") {
        const r = await apiOptimizePrompt(data.prompt);
        if (r.success && (r.positive || r.positiveZh)) {
          updateNodeData(id, { content: r.positive || r.positiveZh || "", status: "done" });
        } else {
          updateNodeData(id, { status: "error", error: r.error || "生成失败" });
        }
      } else {
        // script：走 skill 文本生成（copy_writer → text_gen）
        const r = await apiRunSkill({ key: "copy_writer", input: data.prompt });
        if (r.ok && r.content) {
          updateNodeData(id, { content: r.content, status: "done" });
        } else {
          updateNodeData(id, { status: "error", error: r.error || "生成失败" });
        }
      }
    } catch (e) {
      updateNodeData(id, { status: "error", error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div
      className={`rounded-xl border bg-zinc-900/95 shadow-lg backdrop-blur transition-shadow ${
        selected ? "shadow-xl" : ""
      } ${data.kind === "script" ? "w-[420px]" : "w-72"}`}
      style={{ borderColor: selected ? meta.accent : "#3f3f46" }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-3 !w-3 !border-2 !border-zinc-900"
        style={{ background: meta.accent }}
      />
      <div
        className="flex items-center gap-2 rounded-t-xl px-3 py-2 text-xs font-medium text-white"
        style={{ background: `${meta.accent}26` }}
      >
        <span>{meta.icon}</span>
        <span>{meta.label}节点</span>
        <span className="ml-auto text-[10px] text-zinc-400">{data.modelLabel || "未选模型"}</span>
      </div>

      <div className="p-2">
        <ContentView data={data} />
      </div>

      <div className="nodrag border-t border-zinc-800 p-2">
        <textarea
          value={data.prompt}
          onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
          placeholder={
            data.kind === "script"
              ? "描述剧情，生成脚本/文案…"
              : `输入${meta.label}生成提示词…`
          }
          rows={2}
          className="w-full resize-none rounded-md bg-zinc-800 p-2 text-xs text-zinc-200 outline-none placeholder:text-zinc-500 focus:ring-1"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <select
            value={data.model}
            onChange={(e) => {
              const opt = options.find((o) => o.modelId === e.target.value);
              updateNodeData(id, {
                model: e.target.value,
                modelLabel: opt?.label ?? e.target.value,
              });
            }}
            className="min-w-0 flex-1 rounded-md bg-zinc-800 px-2 py-1 text-[11px] text-zinc-300 outline-none"
          >
            {options.length === 0 && <option value="">无可用模型</option>}
            {options.map((o) => (
              <option key={o.modelId} value={o.modelId}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            onClick={generate}
            disabled={data.status === "generating" || !data.prompt.trim() || (needsModel && !data.model)}
            className="rounded-md px-3 py-1 text-[11px] font-medium text-white transition-opacity disabled:opacity-40"
            style={{ background: meta.accent }}
          >
            {data.status === "generating" ? "生成中" : "生成"}
          </button>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!h-3 !w-3 !border-2 !border-zinc-900"
        style={{ background: meta.accent }}
      />
    </div>
  );
}

export const CanvasNodeComponent = memo(CanvasNodeInner);
