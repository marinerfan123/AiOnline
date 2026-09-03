# G22 Collaboration Foundation — 现状审计

> Blueprint V2.0 G22 Collaboration Foundation 验收轴：actor/commands、presence protocol、conflict behavior。
> 本文为**契约核前置审计**（只读，未改动任何运行时代码），依据仓库现有实现（2026-09-03 快照）逐项核对「已有 / 部分 / 零」。
> 配套产物：`server/modules/studio-contracts/collabContract.cjs`（纯模块）＋ `collabContract.test.cjs`。

## 0. 审计范围与证据文件

| 文件 | 角色 |
|---|---|
| `server/modules/studio-contracts/envelopes.cjs` | 命令信封纯契约（G00 Contract Freeze） |
| `server/modules/project-foundation/studioCanvasPersistence.cjs` | Canvas revision/CAS/409/幂等（M05-C 服务端） |
| `src/features/studio-v2/store.ts` | 客户端会话态（undo/redo 快照栈，M05-A） |
| `src/features/studio-v2/useStudioCanvasPersistence.ts` | 客户端 autosave / 409 conflict-panel / reload（M05-C 客户端） |
| `src/features/studio-v2/persistence.ts` | DirtyOperationBuffer / patch 序列化 |

## 1. actor / commands 现状

### 已有：命令信封（纯契约层，G00 已冻结）
`envelopes.cjs::validateCommand` 定义完整命令信封约束：

```
{ commandId, projectId, type, idempotencyKey,          // 必填非空字符串
  actor: { id },                                        // 必填（嵌套 actor 对象，仅 id）
  canvasId?, expectedRevision? (int>=0),                // 可选
  payload, clientTimestamp? (ISO) }                     // payload 必填
```

- `COMMAND_TYPES` 注册表 35 种命令类型 (2026-09-04 审计修正: 实测 35, 原 33 为注释滞后)（`node.* / edge.* / script.row.* / director.* / timeline.* / run.* / workflow.*` 等），并有 `isKnownCommandType` 守卫。
- **关键缺口**：该信封目前是**纯契约、未接入任何执行端点**。实际 canvas 写路径（`studioCanvasPersistence.cjs`）消费的是另一套报文 `{ baseRevision, clientMutationId, upsertNodes, deleteNodeIds, upsertEdges, deleteEdgeIds, viewport }` —— 没有 kind、没有 actor 信封、没有命令级类型分派。即「命令信封」与「落库协议」两套格式并存，G22 需收敛。
- 幂等：服务端以 `(canvas_id, client_mutation_id)` 唯一键做重放（`studio_canvas_mutations` 表存响应，命中直接回放 `{idempotent:true}`），与信封 `idempotencyKey` 语义同源、命名不同。

### 部分：actor 身份
- 只有「请求鉴权主体」维度：`requireUser`/`sessionUser` 鉴权 → `created_by`/`updated_by` 落库 → `emit('canvas.updated', { actor_id, … })` 进事件日志。
- actor **不是协作模型中的参与者**：无连接会话概念、无 actor 到 canvas 的订阅关系、无按 actor 区分的命令队列。
- 权限按 workspace membership role（`canRead/canUpdate/canArchive/canRestore/canDelete`），非逐命令 actor 策略。

### 零：命令总线 / 分派 / 队列
- 无 `CommandBus`、无命令 handler 注册、无重试/死信/乱序缓冲。
- 服务端没有针对不同 kind（结构性 vs 参数 vs 列表）做差异化冲突处理的任何代码——所有写走同一个 PATCH 全量 upsert。

## 2. conflict behavior 现状（canvas revision 语义）

### 已有：整体乐观锁 + CAS revision + 409 + 整图 reload
服务端 `handlePatch`/`handleRestore` 语义（`studioCanvasPersistence.cjs` L157-180、L185）：

1. **整画布单 revision 计数器**（`studio_canvases.revision`，初始 1），**任何** mutation（包括纯参数 patch、viewport）都执行 `UPDATE ... SET revision=revision+1 WHERE id=$1 AND revision=$base`。
2. CAS 失败（0 行）→ **409 `CONFLICT`**，body 携带 `{ serverRevision, canvasId }` —— revision 是整画布全局值，非每节点。
3. 节点/边 upsert 为**全行覆写**（`ON CONFLICT (canvas_id,node_id) DO UPDATE SET data_json=EXCLUDED.data_json ...`）→ 单次获胜 CAS patch 内行 upsert 为 **last-write-wins**，无字段级 merge、无 CRDT/OT；跨客户端并发是整画布 CAS 409，非并发 LWW (2026-09-04 审计修正措辞)。
4. 冲突解决在客户端：`useStudioCanvasPersistence.ts` 捕获 `409` 后 `blockedRef=true` 冻结保存、置 `status='Conflict'`，`StudioPage.tsx` 渲染 `data-test="studio-conflict-panel"`，仅提供 **「Reload server version」= 整图拉取替换**（`reloadFromServer` → `store.loadGraph`），**本地未保存编辑整体丢弃**。

### 已有：客户端 undo/redo（本地快照栈，M05-A）
- `store.ts`：`Snapshot {nodes, edges}` 全图快照栈，`UNDO_LIMIT=100`，新操作清 redo；`loadGraph`（服务端 hydration / 冲突 reload）**清空 undo/redo 栈**。
- 冲突路径上 undo/redo 与远端完全无关：reload 即抹掉本地历史。无远端操作回放进栈、无「合并后再撤销」语义。

### 零：逐命令冲突策略
- 服务端不区分 kind：结构变更（建/删节点）、参数 patch（改参数/位置）、列表操作（边/行序）**统一 CAS-409 或整行 LWW**。
- 无 `reject-409 / merge / append` 分级策略的代码依据，无字段级三路合并，无服务端 merge。
- 结构性变更的 409 行为存在（有 `CONFLICT_REVISION` 公共错误码），但参数 patch 也被一并 409 → 协作粒度粗。

## 3. presence 现状

### 零：presence 协议完全缺失
- 全仓无 presence 模块：无在线状态枚举、无心跳/TTL、无在线成员列表、无光标/选区广播。
- 无 SSE 推送或 WebSocket 通道：`logEvent`（aggregate `studio_canvas`）只写事件日志，不做实时扇出；`StudioCanvasPersistence` 无订阅者表。
- 客户端 `SaveStatus` 含 `Offline`（网络断连感知）但那是**单机网络态**，不是协作 presence。
- 多端并发唯一现状 = 上述「乐观锁 + 409 + reload」，无「他人在线/在编辑哪个节点」的可视性。

## 4. 审计结论汇总

| G22 验收轴 | 现状等级 | 证据 |
|---|---|---|
| 命令信封（校验/类型注册） | **已有（纯契约，未接入执行）** | `envelopes.cjs::validateCommand / COMMAND_TYPES` |
| 命令总线/分派/队列 | **零** | 实际端点吃 `clientMutationId+baseRevision` patch，无 kind 分派 |
| actor 身份（鉴权侧） | **部分** | `sessionUser → created_by/updated_by/actor_id` 落库；无协作参与者模型 |
| canvas revision 冲突行为（CAS+409） | **已有（整画布粒度）** | `studioCanvasPersistence.cjs` CAS UPDATE、409 `{serverRevision,canvasId}`、`studio_canvas_mutations` 幂等 |
| 逐命令冲突策略（LWW/merge/append） | **零** | 服务端单一 PATCH 全行 upsert = 节点级 LWW；无按 kind 分级 |
| 客户端 conflict-panel / reload | **已有** | `StudioPage.tsx` conflict-panel、`reloadFromServer` 整图替换 |
| 本地 undo/redo（快照栈） | **已有（本地，冲突即清空）** | `store.ts` `UNDO_LIMIT=100`、`loadGraph` 清栈 |
| presence 在线状态协议 | **零** | 无状态枚举/心跳/TTL/成员列表/光标 |
| 实时推送通道（SSE/WS 扇出） | **零** | `logEvent` 仅日志，无订阅者 |
| 多端并发 actor 模型 | **零** | 现状=整文档乐观锁+409+整图 reload，无连接层/无并发 actor 协调 |

## 5. G22 契约核落点（本审计配套产物）

`collabContract.cjs`（纯模块，未挂载）把「零」的部分先固化为契约，供后续 Gate 实现：

- `PRESENCE_STATES`：`online/away/offline/busy` 枚举 + `presenceTtlMs`（心跳过期）——补 presence 协议的状态字面量契约。
- `validateCommandEnvelope`：G22 版命令信封校验（`id/actorId/kind/clientSeq/payload` 正交于 G00 `validateCommand` 的 `commandId/actor/type` 字段命名，为协作写路径专用）。
- `conflictPolicy(kind)`：按 kind 声明冲突策略（structural→reject-409、参数 patch→last-write-wins、列表/边→merge、追加类→append、未知→reject-409），映射表与依据见模块内注释——补「逐命令冲突策略」的决策契约。

> 边界声明：本文只审计 + 新增契约核与测试，**未改动** `envelopes.cjs / studioCanvasPersistence.cjs / store.ts / server.js`，未挂载任何新路由，无数据库变更。
