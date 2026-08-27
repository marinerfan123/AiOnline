# 11 — State Architecture

日期: 2026-08-27
原则: 按生命周期分域, 禁止全部堆在组件。技术选型: TanStack Query (server state) + Zustand (canvas/app 单例) + React 局部 state (UI 瞬时态)。

## 1. 五域划分

### 1.1 Server State (TanStack Query)
- 所有 REST 数据 (models/providers/keys/media/projects/users/finance/monitor snapshots...)
- 配置: staleTime 30s (目录类) / 0s (账务/任务), retry 1 (写操作不自动重试, 生成除外由闸门处理), GC 5min
- Query key 约定: ['media', filters], ['providers'], ['keys', providerId], ['admin', 'users', params] ...
- 失效规则: 写成功 → invalidate 相关目录 (如 key 变更 → ['providers'] + ['keys',id] + ['models'] 刷新健康列)
- 与现有 126 个 api 函数兼容: api/* 保持纯 fetch 封装, Query 在 hook 层调用
- 大列表 (admin tasks/media >100): useInfiniteQuery + 表格虚拟滚动

### 1.2 Realtime State (SSE 单例 → 事件总线 → 多消费者)
- 一个 EventSource /api/generate/stream (user) + 各自 admin SSE, 全局单例 (现 useGenerationStream 重构为 sseClient)
- 事件分派: task 事件 → (a) 更新 activeTasks store (b) invalidate ['tasks','active'] (c) toast 桥 (完成/失败)
- 画布执行状态经同一总线 (nodeId↔taskId 映射在 canvasStore.execution)
- 断线: 指数退避重连 (3s/6s/12s max 60s), 重连后拉 /generate/active 对齐; 降级轮询 10s (现状)

### 1.3 Canvas State (Zustand, studioStore)
- nodes/edges/viewport (xyflow 受控同步)
- execution map, cost cache, undo/redo 快照栈
- 持久化: meta.canvas (G1), 本地无 localStorage 副本 (服务端为准, 离线编辑一期不支持)
- 生命周期: 进画布创建, 离开 flush 保存后销毁

### 1.4 App/Session State (Zustand appStore)
- session user (me) + role — 登录态单例, 刷新经 /api/auth/refresh
- sidebar 折叠/workspace 选择/主题 (dark 默认) — 这些可 localStorage 持久
- toast 队列, 命令面板 open 状态
- 积分余额 (顶栏): 来自 me.summary, 任务完成事件后 +1 次 invalidate

### 1.5 UI Local State (组件 useState)
- 表单草稿, 弹窗开关, 筛选控件瞬时态, 滚动/拖拽
- 铁律: 任何跨组件共享的 server 数据不得 useState 手动 fetch (旧 useModelHub 类 hook 迁移到 Query)

## 2. 数据流图

```
api/* (fetch+auth+error)
   ↑
hooks (useQuery/useMutation 封装)
   ↑
Pages/Components (渲染)
   ↑              SSE sseClient (单例)
   └── 事件 → store 更新 / Query invalidate / toast
Zustand: studioStore (canvas) | appStore (session/ui) | activeTasksStore
```

## 3. 迁移策略 (对旧代码)
- 旧 useModelHub/useMediaCounts/useGenerationStream → 逐个替换为 Query + sseClient (Phase A/B)
- 旧 authStore → 并入 appStore
- 移除: 组件内散落的 fetch useEffect (约 30 处, 审计清单在 12 §Phase B)
- canvas store (React context) → Zustand (Phase D, 旧 canvas 代码整体删除)
