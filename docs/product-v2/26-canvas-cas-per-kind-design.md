# 26 — Canvas CAS 按 kind 差异化执行设计

日期: 2026-09-04
性质: 纯读 + 设计文档，不改代码、不 git、不 ssh。所有「现状」描述均来自仓库已读文件（迁移 SQL 与模块源码，逐处标注行号）；「目标/建议/未实现」为设计主张，与现状明确区分。
范围: 仓库 /mnt/c/Users/Administrator/github_ai_online。只新建本文件，不动其它。
上游依据: `docs/product-v2/18-collaboration-g22-audit.md`（G22 审计）、`docs/product-v2/23-project-truth-three-view.md`（三视图域真值）、`server/modules/studio-contracts/collabContract.cjs`（CONFLICT_POLICY_BY_KIND 契约）、`server/db/migrations/0046_command_log.sql` + `commandLogStore.cjs`（命令日志地基）。

---

## 0. 结论摘要（先看这段）

- **现状一句话**: 服务端只有「整画布单 revision CAS」——任何 mutation（含纯参数 patch、viewport）都 `revision+1`，CAS 失败一律 409 + 整图 reload。`CONFLICT_POLICY_BY_KIND`（LWW/merge/append/reject-409）是**声明性契约，零实现底座**（collabContract.cjs 注释自认，L131-137）。
- **核心裁决（第 2 节）**: **命令日志作为真源 + 投影表**，**不做** per-kind revision 域（N 个 revision 计数器会炸 schema 且无全局回放序）。`canvas_command_log`（0046 已建）本就是 append-only + seq 单调 + 幂等的天然真源；`studio_canvases/nodes/edges` 是它的投影（可快照 + listAfter 回放重建）。reject-409 拓扑类**保留整画布 CAS** 作为投影之上的安全门。
- **迁移路径（第 4 节）**: dual-mode 灰度。Phase 1 现状全量整画布 CAS（日志已 warn-only 旁路记录）；Phase 2 用 env 开关把 LWW/merge/append 类切到「命令日志投影 + kind 窗口」，reject-409 仍走整画布 CAS；Phase 3 日志转权威真源、投影可重建。开关关闭即回滚到 Phase 1，零 schema 破坏。
- **conflict 响应形状扩展（第 5 节）**: 409 body 从 `{serverRevision, canvasId}` 增为 `{kindPolicy, serverRevision, commandSeq, canvasId}`——旧字段不变（additive passthrough），新字段供客户端按 kind 决定「整图 reload vs 增量 rebase」。

---

## 1. 现状精确盘点（行号）

### 1.1 单 revision 表结构（迁移 0014_studio_canvas_persistence.sql）

| 表 | 行号 | 关键列 |
|---|---|---|
| `studio_canvases` | L5-20 | **`revision INT NOT NULL DEFAULT 1 CHECK (revision >= 1)`（L10，唯一整画布版本计数器）**；`schema_version`（L11）；`viewport_json JSONB`（L12） |
| `studio_canvas_nodes` | L25-39 | `node_id`（业务主键，`UNIQUE(canvas_id,node_id)` L40）；`data_json JSONB`（L36）；`position_x/y/width/height/z_index`（L31-35） |
| `studio_canvas_edges` | L43-57 | `edge_id`（`UNIQUE(canvas_id,edge_id)` L58）；source/target FK 指向节点（L55-56） |
| `studio_canvas_versions` | L63-77 | 快照 `snapshot_json`（L70）+ 独立 `revision`（L66）+ `version_number`（L67） |
| `studio_canvas_mutations` | L79-89 | 幂等表：`base_revision`（L83）、`resulting_revision`（L84）、`response_json`（L85）、**`UNIQUE(canvas_id, client_mutation_id)`（L88）** |

> 结论：revision 是**画布级单值**，无任何 per-kind/per-entity 版本域。节点/边行内无 revision 列。

### 1.2 CAS 校验点（studioCanvasPersistence.cjs）

| 点 | 行号 | 内容 |
|---|---|---|
| PATCH CAS UPDATE | **L201** | `UPDATE studio_canvases SET revision=revision+1, viewport_json=... WHERE id=$1 AND revision=$2 RETURNING *`（`revision=$2`=client baseRevision） |
| PATCH 409 | **L202** | `sendErr(409, 'CONFLICT', { serverRevision, canvasId })` |
| RESTORE CAS UPDATE | **L245** | 同构 CAS（`WHERE id=$1 AND revision=$2`），409 body 同 L202 |
| 幂等回放 | **L199-200** | 先查 `studio_canvas_mutations` 命中则 `{...response_json, idempotent:true}` 直接 200 |
| 幂等落库 | **L232** | `INSERT INTO studio_canvas_mutations ...`（commit 前） |
| 命令日志旁路记录 | **L237** | `recordCanvasPatch({...})`（commit 后，warn-only） |
| `recordCanvasPatch` | **L160-171** | 只记录 **ops 计数**（`nodeUpserts/nodeDeletes/edgeUpserts/edgeDeletes`），非完整 ops 载荷 |
| `commandLog` 初始化 | **L149-159** | 优先注入 `deps.commandLogStore`，否则自建 `createCommandLogStore({pg})`；失败 warn-only |

### 1.3 409 语义（现状）

- **服务端**: 任何 mutation 都 revision+1；CAS 失败（0 行）→ 409 `CONFLICT` + `{serverRevision, canvasId}`（L202/L245）。节点/边 upsert 是单获胜 CAS patch 内的全行覆写（L229/L230 `ON CONFLICT ... DO UPDATE SET data_json=EXCLUDED...`）——**跨客户端并发改不同节点同样 409**，非节点级 LWW。
- **前端契约**: `CanvasConflictResponseSchema = { error:'CONFLICT', serverRevision, canvasId }`（schemas.ts **L289-293**）；`StudioCanvasApiError.serverRevision/canvasId`（studio-canvas-client.ts **L15-28**）。
- **前端处理**（useStudioCanvasPersistence.ts）: `ConflictInfo` 仅 `{serverRevision, canvasId}`（**L19**）；409 检测（**L66-68**）；F1 rebase 重放一次（**L83-99**）；仍冲突 → conflict-panel 整图 reload、本地 buffer 保留；F2 flush 互斥单飞（**L111-126**）。

### 1.4 mutation 行（handlePatch 主写链）

| 行号 | 动作 |
|---|---|
| L227 | `DELETE FROM studio_canvas_edges ...`（deleteEdgeIds） |
| L228 | `DELETE FROM studio_canvas_nodes ...`（deleteNodeIds） |
| L229 | 节点 upsert（for 循环逐条，全行覆写） |
| L230 | 边 upsert（for 循环逐条，全行覆写） |
| L231 | `loadGraph` + `fresh` + 组装 resp |
| L232 | 写 `studio_canvas_mutations` 幂等行 |
| L203-226 | 权威绑定校验（`validateAuthoritativeBindings`，已接线 W2-06） |

### 1.5 命令日志地基（已就绪，未挂载为真源）

| 位置 | 内容 |
|---|---|
| `0046_command_log.sql` **L25-36** | `canvas_command_log(canvas_id, seq BIGSERIAL, command_id, type, actor_id, base_revision, payload JSONB, received_at)`；**PK `(canvas_id, seq)` L34**；**UNIQUE `(canvas_id, command_id)` L35**；`base_revision INT` L31 |
| `commandLogStore.cjs` | `INSERT_SQL` L40-45（`ON CONFLICT DO NOTHING RETURNING seq`）；`LIST_SQL` L47-51（`seq > cursor` 游标回放）；`LAST_SEQ_SQL` L53-56；`appendCommand` L176-185；`listAfter` L209-215；`lastSeq` L221-226 |

> ⚠️ 0046 注释（L9-14）已明确：seq 由全局 BIGSERIAL 分配、跨画布共享、重复尝试留洞 ⇒ 只能用 `seq > cursor` 游标语义，**绝不可用 seq 做计数/差值**。

### 1.6 按 kind 冲突契约（collabContract.cjs，纯声明，零执行）

| 策略 | 行号 | kind 集合 |
|---|---|---|
| `last-write-wins` | **L142-155** | `canvas.viewport.update`、`node.move/resize/update`、`group.update`、`director.*.update`、`script.row.update`、`shot.update`、`timeline.clip/track.update`、`asset.bindActiveVersion` |
| `merge` | **L156-165** | `edge.create/delete`、`script.row.create/delete/reorder`、`timeline.clip/track.create/delete` |
| `reject-409` | **L166-179** | `node.create/delete`、`group.create/delete`、`director.*.create/delete`、`shot.create`、`workflow.save/apply`、`run.create/cancel/retry`、`group.run` |
| `append`（前缀） | **L183-188** | `presence.`/`comment.`/`annotation.`/`chat.`/`log.`（未进 COMMAND_TYPES，预留） |
| `conflictPolicy()` | **L194-198** | 未知 kind 保守 → reject-409 |

> ⚠️ L131-137 注释自认：2)/3)/4) 目前是**声明性目标策略**，改造前任何客户端都不能依赖 LWW/merge/append 生效。

---

## 2. 目标裁决：命令日志真源 + 投影（**否** per-kind revision 域）

### 2.1 二选一论证

| 方案 | 优点 | 致命缺陷 | 裁决 |
|---|---|---|---|
| **A. per-kind revision 域**（每 kind/实体一个 revision 计数器） | 冲突检测天然 per-entity | (1) N 个 kind/实体 = N 列或 N 表，schema 爆炸且未来 kind 扩展要迁移；(2) 无全局回放序，rebase/重建/审计跨 kind 无法排序；(3) 与已有 0046 日志重复造轮子；(4) reject-409 拓扑类仍要画布级原子门（悬挂引用），单实体 revision 反而破坏原子性 | ❌ 否决 |
| **B. 命令日志真源 + 投影表**（本次采用） | (1) 复用 0046 已建 append-only 日志；(2) `seq` 单调给出全序回放/审计/重建；(3) 投影表 = 现状三表，零破坏；(4) reject-409 保留整画布 CAS 作安全门 | 需新增「日志→投影」apply 逻辑；seq 全局序列有洞（已由 0046 游标语义兜底） | ✅ 采用 |

### 2.2 分层模型（真源 vs 投影）

```
真源:   canvas_command_log  (append-only, seq 单调, (canvas_id,command_id) 幂等)
           │  apply(policy by kind)   ← 唯一写投影的入口
           ▼
投影:   studio_canvases (revision 安全门 + viewport 投影)
        studio_canvas_nodes / studio_canvas_edges  (图状态投影)
           ▲
           └─ reject-409 拓扑命令: 先过整画布 CAS(revision 门) → 再 append 日志 + 更新投影
```

- **真源** = 命令日志：每条 mutation 一行，`base_revision` 记录客户端所见画布 revision，`seq` 由 PG 分配给出全序。投影任意时刻可「快照 + listAfter 回放」重建。
- **投影** = 现状三表：`studio_canvases.revision` 退化为「拓扑安全门 + viewport 单值」，`nodes/edges` 退化为「按实体 key 的 LWW/merge 投影」。投影不承载版本语义，版本语义全在日志。
- **reject-409 的 CAS 门保留**：拓扑类（node/group create/delete、shot.create、workflow.save/apply、run.*）必须 `base_revision == 当前 canvas.revision` 才 append+apply，否则 409——这是「悬挂引用/重复实体/快照丢失」的原子防线，不能靠单实体 LWW 替代。

### 2.3 按 kind 差异化执行矩阵

| 策略 | 触发 kind（见 §1.6） | 执行语义 | 409 是否可能 |
|---|---|---|---|
| **reject-409** | 拓扑建删/整图快照 | 整画布 CAS（`revision` 门）通过 → append 日志 → 更新投影 | ✅ 唯一会 409 的类 |
| **last-write-wins** | 参数/几何 patch | 无 CAS；append 日志；投影按实体 key 取「LWW 窗口内最新 seq」覆写 | ❌ |
| **merge** | 边/列表元素级操作 | 无 CAS；append 日志；投影按元素独立主键做并集（create/delete/reorder） | ❌ |
| **append** | presence/comment/annotation | 无 CAS；append 日志；纯追加不改既有结构 | ❌ 永不冲突 |

> LWW 窗口（kind-scoped optimistic window）：为容忍乱序/在途 patch，LWW 应用不是「立即覆盖」，而是「在 (canvas_id, entity_key) 上比较 seq，取窗口期内最大 seq 的载荷」；窗口过期后仍以最新 seq 为准（收敛）。窗口存在的意义是避免旧 base 的慢 patch 晚到覆盖新值——实现上以 `base_revision`/`seq` 双游标判定，而非墙钟。

---

## 3. 迁移路径（dual-mode 灰度，不破坏现 revision 兼容）

### 3.1 三阶段

| 阶段 | 开关 | 行为 | 破坏性 |
|---|---|---|---|
| **Phase 1（现状 = legacy canvas-wide CAS）** | `STUDIO_CANVAS_KIND_SCOPED` 未设 | 所有 mutation 整画布 CAS + 409；日志 warn-only 旁路记录（现状 L237） | 无 |
| **Phase 2（kind-scoped 灰度）** | `STUDIO_CANVAS_KIND_SCOPED=1` | LWW/merge/append 类走命令日志投影 + kind 窗口（跳过整画布 CAS）；reject-409 仍走整画布 CAS | 无（additive） |
| **Phase 3（日志权威化）** | 同上 + 投影重建 | 日志转真源（记录完整 ops 而非计数）；投影可「快照 + listAfter」重建；reject-409 仍是投影之上的 CAS 门 | 无（日志 append-only，不滚） |

### 3.2 兼容策略（关键约束）

1. **legacy canvas-wide CAS 永不删除**：reject-409 拓扑类 + 未开开关时的全量路径都依赖它。代码里 L201 的 CAS 分支保留为「reject-409 执行器」，LWW/merge/append 只是旁路。
2. **命令日志承接命令真源 + seq 单调**：`canvas_command_log` 已在 L237 被写（Phase 1 起就积累数据），Phase 2 只是把 payload 从「ops 计数」升级为「完整 kind 分解 ops」并把写日志从 warn-only 升为准入前必须。
3. **响应形状向后兼容**：新字段（§5）是 additive passthrough，旧客户端只看 `serverRevision/canvasId` 仍工作（`CanvasConflictResponseSchema.passthrough()` 已存在，schemas.ts L293）。
4. **回滚 = 关开关**：`STUDIO_CANVAS_KIND_SCOPED` 清空即回到 Phase 1 全量 CAS。日志是投影的超集、append-only，回滚不删日志（投影仍正确，因为 Phase 1 的 CAS 更新投影与日志记录同事务/同路径）。

### 3.3 灰度切换语义

- Phase 2 中同一条 PATCH 可能**混合 kind**（e.g. 一次 PATCH 同时 node.move + node.create）：拆解后按 kind 分组——`node.create` 走 reject-409 门，`node.move` 走 LWW 投影。**门与投影在同一事务内**，门失败整事务回滚（保持原子性，避免半应用）。
- 命令日志 `type` 字段沿用 `canvas.patch`（现状），payload 内加 `ops[]`（kind 分解后的子命令）；或直接每条 kind 子命令各 append 一行（推荐，`type`=具体 kind 如 `node.move`），使 `CONFLICT_POLICY_BY_KIND[type]` 可直接查表——**建议后者**，让日志类型注册表与冲突契约同源。

---

## 4. conflict 响应形状扩展

现状（L202/L245 + schemas.ts L289-293）：

```json
{ "ok": false, "error": "CONFLICT", "serverRevision": 7, "canvasId": "canvas-..." }
```

目标（additive，旧字段不变）：

```json
{
  "ok": false,
  "error": "CONFLICT",
  "kindPolicy": "reject-409",        // 本次触发 409 的 kind 对应策略（仅 reject-409 会出 409）
  "serverRevision": 7,                // legacy 画布级 revision（reject-409 rebase 依据，不变）
  "commandSeq": 42,                   // 最新 canvas_command_log.seq（LWW/merge 增量 rebase 游标）
  "canvasId": "canvas-..."
}
```

| 字段 | 语义 | 消费者 |
|---|---|---|
| `kindPolicy` | `reject-409`/`last-write-wins`/`merge`/`append`——客户端据此决定冲突 UI | 前端 conflict-panel 分类展示 |
| `serverRevision` | 保持原义（整画布 revision），reject-409 rebase 用 | 现有 `retry()`/rebase 逻辑不变 |
| `commandSeq` | 最新日志 seq（游标），LWW/merge 客户端「从该游标拉增量」用 | 未来增量同步（Phase 2+） |

> 注意：LWW/merge/append **不产生 409**（服务端直接按策略应用），因此 `kindPolicy` 实际只在 reject-409 场景出现在 409 body；LWW/merge 的成功响应里通过 `applied` 响应携带新 `revision`/`seq`（对齐现有 `{applied:true, clientMutationId}` 的 extra 通道，L231）。

---

## 5. 拆叶清单（8 叶，文件归属 + 回滚路径）

> 依赖顺序：叶 1→叶 3→叶 4 是主链（叶 2 可与叶 1 并行）；叶 5/7 可并行于主链；叶 6/8 收尾。每叶独立可回滚。

| 叶 | 内容 | 文件归属 | 回滚路径 | 依赖 |
|---|---|---|---|---|
| **叶 1** | 命令日志转权威：`recordCanvasPatch` 从 warn-only 升为准入前必须 + payload 从「ops 计数」升级为「完整 kind 分解 ops」（或每 kind 子命令各 append 一行，`type`=具体 kind） | `server/modules/project-foundation/studioCanvasPersistence.cjs`（L160-171、L237）；`server/modules/collaboration/commandLogStore.cjs`（批量 append） | 还原 L160-171/L237 为 warn-only（payload 兼容，不删表） | 无 |
| **叶 2** | kind 拆解器（纯函数）：把 legacy PATCH `{upsertNodes, deleteNodeIds, upsertEdges, deleteEdgeIds, viewport}` → 子命令列表（`node.create/delete/move/resize/update`、`edge.create/delete`、`canvas.viewport.update`），复用 `CONFLICT_POLICY_BY_KIND` | 新 `server/modules/collaboration/canvasCommandDecomposer.cjs`（或 studio-contracts 内）；单测 `canvasCommandDecomposer.test.cjs` | 删文件，无接线 | 无（可并行叶 1） |
| **叶 3** | dual-mode 开关 + 按 kind 分派：handlePatch 按 `STUDIO_CANVAS_KIND_SCOPED` 分流——reject-409 走现有整画布 CAS（L201-232 保留），LWW/merge/append 走命令日志投影路径；混合 kind 同事务分组执行 | `server/modules/project-foundation/studioCanvasPersistence.cjs`（handlePatch L188-240 重构） | 开关清空即回 Phase 1 全量 CAS（分支保留，不删） | 叶 2 |
| **叶 4** | 投影 apply 执行器：per-entity LWW（按 seq 窗口）+ merge 并集（边/列表元素独立主键）+ append 纯追加；供叶 3 调用 | 新 `server/modules/collaboration/canvasProjection.cjs`（或扩展 commandLogStore）；单测 | 删文件，叶 3 回退全量 CAS | 叶 3 |
| **叶 5** | conflict 响应形状扩展：409 body 增 `{kindPolicy, commandSeq}`（§4）；同步三处契约 | `studioCanvasPersistence.cjs`（L202/L245）；`src/shared/api/contract/schemas.ts`（L289-293 `CanvasConflictResponseSchema`）；`src/shared/api/contract/studio-canvas-client.ts`（L15-28 `StudioCanvasApiError`） | 还原 schema（additive passthrough，旧字段不变；回滚=去掉两新字段） | 无 |
| **叶 6** | append/presence 接入：presence 心跳 + comment/annotation 走 append 策略（无 CAS）；presence 用现有 `presencePgStore.cjs`，append 前缀走 `isAppendKind` | `server/modules/collaboration/presencePgStore.cjs`（已存在）；`collabContract.cjs`（`APPEND_KIND_PREFIXES` L183 已就绪，补路由） | n/a（当前无生产路由，纯新增） | 叶 4 |
| **叶 7** | 客户端 rebase 升级：reject-409 保留 conflict-panel + 整图 reload（现状）；LWW/merge 用成功响应的新 `revision/seq` 增量 rebase 保留本地 buffer，不做整图替换 | `src/features/studio-v2/useStudioCanvasPersistence.ts`（L59-126 `attempt/doFlush/flush`、L179-193 `retry`）；`src/features/studio-v2/persistence.ts`（`DirtyOperationBuffer` 增量 commit） | 还原现有 F1/F2 rebase（revision 单值路径） | 叶 5 |
| **叶 8** | 投影重建 + 集成测试：快照 + `listAfter` 回放重建投影；按 kind 四策略各一集成测试（reject-409 并发 409 / LWW 并发不冲突 / merge 并集 / append 幂等） | 新测试 `server/tests/integration/studio-canvas-kind-cas.test.cjs`；扩展 `commandLogStore.test.cjs`、`studioCanvasPersistence.test.cjs` | n/a（测试，删即回滚） | 叶 4、叶 5 |

---

## 6. 未验证项 / 边界（诚实声明）

- 本节所有「现状」均来自对下列文件的**读取**（非运行时实测）：`0014/0046` 迁移 SQL、`studioCanvasPersistence.cjs`、`commandLogStore.cjs`、`presencePgStore.cjs`、`collabContract.cjs`、`src/features/studio-v2/useStudioCanvasPersistence.ts`、`src/shared/api/contract/schemas.ts`、`studio-canvas-client.ts`、`docs/18`、`docs/23`。
- **未运行任何 DB/API**，未验证运行时行为（如 seq 全局序列在真实 PG 并发下的留洞表现、LWW 窗口在乱序在途 patch 下的收敛、混合 kind 同事务分组的原子性）。
- `recordCanvasPatch` 当前 warn-only 的判定基于源码阅读（L160-171、L237 注释），非运行时日志实测；Phase 1 起日志是否已实际积累数据未验证。
- 「命令日志作为真源 + 投影」是**设计主张**，非现状描述；现状命令日志是「旁路地基、未挂载为权威」（0046 注释「地基, 未挂载」、18 审计「命令总线零」）。
- 叶 6（presence/append 路由）依赖 G22 命令总线/传输层（SSE/WS），当前仓库**零实时通道**（18 审计 §3），故叶 6 是「预留契约接入」，非可立即落地的执行端点。
