// src/hooks/useOssLogStream.ts — 订阅后端 /api/oss/logs/stream (SSE)
//
// 能力：
//  - 自动连接 + 断线重连（3s 后由 EventSource 的 retry:3000 / onerror 触发重连）
//  - 首屏拉一次 snapshot 把历史拉出来；后续逐条 push
//  - 上限 500 条本地缓冲（与后端 ossLogger 一致）
//  - 暴露 level 过滤（all/info/success/warn/error）+ 清空本地视图
//  - 连接状态（connected）→ UI 展示"在线/离线"小灯
//
// 设计：仅在 OssConfigPanel 使用，全局不挂载。心智模型如同 console.log：

import { useEffect, useRef, useState } from 'react';

export type OssLogLevel = 'info' | 'success' | 'warn' | 'error';
export type OssLogFilter = 'all' | OssLogLevel;

export interface IOssLogEntry {
  id: number;
  ts: number;
  level: OssLogLevel;
  action: string;
  message: string;
  details?: Record<string, any>;
}

const MAX_LOCAL = 500;

export function useOssLogStream() {
  const [logs, setLogs] = useState<IOssLogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [filter, setFilter] = useState<OssLogFilter>('all');
  const esRef = useRef<EventSource | null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    stoppedRef.current = false;
    let reconnectTimer: any = null;

    function connect() {
      if (stoppedRef.current) return;
      try {
        const es = new EventSource('/api/oss/logs/stream', { withCredentials: true });
        esRef.current = es;
        es.onopen = () => { if (!stoppedRef.current) setConnected(true); };
        es.onerror = () => {
          if (stoppedRef.current) return;
          setConnected(false);
          try { es.close(); } catch {}
          esRef.current = null;
          reconnectTimer = setTimeout(connect, 3000);
        };
        es.onmessage = (ev) => {
          // 跳过心跳 `: ping ...`（前缀是冒号，data 为空）—— EventSource 不触发这里的 onmessage
          try {
            const msg = JSON.parse(ev.data);
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'snapshot' && Array.isArray(msg.data?.records)) {
              setLogs(msg.data.records);
            } else if (msg.type === 'oss' && msg.data) {
              setLogs((prev) => {
                const next = prev.length >= MAX_LOCAL ? prev.slice(prev.length - MAX_LOCAL + 1) : prev.slice();
                next.push(msg.data);
                return next;
              });
            }
            // 其它类型（如未来的"清空指令"）忽略
          } catch {
            // 忽略非 JSON 心跳
          }
        };
      } catch {
        // EventSource 构造异常（极少见）— 3s 后重连
        reconnectTimer = setTimeout(connect, 3000);
      }
    }
    connect();

    return () => {
      stoppedRef.current = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { esRef.current?.close(); } catch {}
      esRef.current = null;
    };
  }, []);

  const filtered = filter === 'all' ? logs : logs.filter((l) => l.level === filter);

  return {
    logs: filtered,           // 视图用（按 filter 已过滤）
    totalLogs: logs.length,   // 总数（用于 badge "256 条 / 全部"）
    connected,
    filter,
    setFilter,
    clear: () => setLogs([]), // 清空本地视图（不影响后端环形缓冲；后端有运维 API 可单独清）
  };
}
