# 23 — 三视图共享域真值设计（script / storyboard / canvas / run）

日期: 2026-09-04
性质: 纯读 + 文档盘点，不写代码。所有"现状"描述均来自仓库内已读文件（迁移 SQL 与模块源码，逐处标注）；"建议/未实现"为设计主张，与现状明确区分。
范围: 仓库 /mnt/c/Users/Administrator/github_ai_online。只新建本文件，不动其它。

---

## 0. 结论摘要（先看这段）

- 四层实体各自有独立 id 空间与单写者，**但中间缺了两条关键绑定**，导致三视图无法 join：
  1. **计划 shot 与执行 shot 是两个 id 空间，尚无绑定列**（见 §1.5）。
  2. **canvas 节点的 shotId/structureNodeId 绑定是自由字符串，校验函数存在但从未接入生产路由**（见 §1.3、§1.6）。
- 权威判定（15-infinite-canvas-v2-decision.md D1 已定，非本文件新建议）：**canvas 不是独立域，是"shot-centric 生产事实层的可视化绑定"**——节点要么绑定权威实体、要么是生成执行块，不复制实体数据进节点。但现实实现里 canvas 是完整独立的 CAS-revisioned 图存储，绑定仅靠约定字符串，未强制。
- 域真值建议：**每层单写者 + 计划层做"投影 + 校验" + canvas 做"绑定 + 校验"**，运行层纯追加只读。同步走显式触发链（§3），不做自动图漂移传播。

---

## 1. 四层实体盘点（id / 权威 / 写点 / 冲突）

### 1.1 script_rows（迁移 0039）—— 脚本内容权威

| 项 | 内容 |
|---|---|
| 主键 / 定位 | `id` TEXT（`sr-{uuid}`，scriptApi POST 生成）；`(project_id, episode_id, scene_index, row_index)` 索引定位 |
| 权威性 | 脚本唯一内容载体。**当前 schema 无独立 `scripts` 表**（0045 注释自述），script 的归属 = `project_id` + 该 project 的 script_rows |
| 单写者 | `server/modules/script/scriptApi.cjs`（POST /rows 批量、PATCH /rows/:id、PUT /order 重排、DELETE /rows/:id） |
| 写语义 | 无版本号、无 revision；PATCH 为 merge 更新（重校验全行），DELETE 硬删（无 deleted_at），POST 按 scene 内 MAX(row_index)+1 自增。**last-write-wins** |
| 关键字段 | `kind`（dialogue/action/transition/parenthetical/header/shot_direction）、`scene_index`/`row_index`（位置）、`speaker`/`text`/`beat`/`timing_ms`（整数毫秒）、`continuity_notes` JSONB |

写点冲突点：
- **script 编辑 → plan 静默漂移**：编辑/删除 script_rows **不会**失效 project_shots_rows。持久化的计划行停留在旧 version，直到有人再 POST `/storyboard/apply` 重算。GET `/storyboard`（plan view）是实时重算的（不落库），所以"看实时计划"和"读持久化计划"可能不一致。
- 无单调时钟可检测 script→plan 端到端 staleness（script_rows 无版本，project_shots_rows 有 version，canvas 有 revision，三者不同源）。

### 1.2 project_shots_rows（迁移 0045）—— storyboard 计划（投影层）

| 项 | 内容 |
|---|---|
| 主键 / 定位 | `id`（`psr-{uuid}`）；`UNIQUE(script_id, shot_id)`；索引 `(script_id, ordering)`、`(project_id, script_id)` |
| 权威性 | **派生投影，非独立可编辑实体**。G13 计划镜头在画布绑定前无 episode/canvas，shotId = `s{scene}:b{beat}:k{shot}`（storyboardPlan 纯位置派生） |
| 单写者 | `server/modules/script/storyboardShots.cjs` 的 `persistStoryboardShots`（经 scriptApi POST `/storyboard/apply`） |
| 写语义 | **服务端恒重算**：rows → buildStoryboardPlan → persistStoryboardShots；请求体忽略，客户端无法伪造。同一 script 重跑 = 单事务内 advisory lock（`pg_advisory_xact_lock(hashtext(project),hashtext(script))`）→ MAX(version)+1 → DELETE 全旧行 + INSERT 全新行（原子替换，`version` 1..N 递增） |
| 关键字段 | `shot_id`（=plan shotId）、`beat_id`、`scene_index/beat_index/shot_index`（位置）、`kind`（默认 'standard'，注释预留 G16 director 回填）、`intent`（dialogue/reaction/action）、`subject_refs` JSONB、`duration_ms`、`ordering`、`version` |
| FK | `project_id` → projects（CASCADE）；`script_id` **无 FK**（无 scripts 表，脚本载体是 script_rows） |

写点冲突点：
- **与 shots（0017）的关系是"additive/不改 shots"**：0045 注释明确"association table，不改 0017 shots"。所以计划 shot 与执行 shot 完全平行，无引用。
- `kind` 字段注释预留"G16 director 层可回填精修 kind"——这是 project_shots_rows 的**潜在第二写者**。当前代码里 directorizeRows.cjs 是纯函数（只产 ShotDirective，不落库），尚未形成实际双写。
- 属主校验两层：project 存在（404）+ plan 每个 `beat.scriptRowIds` 在 `script_rows(project_id, id)` 全命中（404，否则无 scripts 表前无法证明 script 属主）。

### 1.3 canvas nodes/edges（迁移 0014）—— 图存储（绑定层 + 执行层）

| 项 | 内容 |
|---|---|
| 表 | `studio_canvases`（revision CAS）、`studio_canvas_nodes`、`studio_canvas_edges`、`studio_canvas_versions`（snapshot）、`studio_canvas_mutations`（幂等响应） |
| 节点主键 / 定位 | 行 `id`（`scn-{uuid}`）；业务 `node_id` + `UNIQUE(canvas_id, node_id)`；`data_json` JSONB |
| 权威性 | 每个 project 一个 primary canvas（`UNIQUE(project_id) WHERE is_primary AND archived_at IS NULL`）；图状态 PostgreSQL 权威 + `revision` 乐观冲突（CAS，`UPDATE ... WHERE revision=$base`） |
| 单写者 | `server/modules/project-foundation/studioCanvasPersistence.cjs`（GET/POST/PATCH/versions/restore） |
| 写语义 | PATCH = `{clientMutationId, baseRevision, upsertNodes, deleteNodeIds, upsertEdges, deleteEdgeIds, viewport}`；CAS revision++；mutation 幂等（同 clientMutationId 回放） |
| 绑定字段 | `data_json` 内 `durableNodeData` 保留 `shotId`、`structureNodeId`（W2-06 注释"authoritative structure/Shot binding survives durability"）；`nodeKind`/`nodeType`/`schemaVersion`/`title`/`status`/`parameters`/`assetId`/`prompt`/`frameLabel` |

写点冲突点：
- **`data.shotId` 是自由字符串，无强制校验**：`validateAuthoritativeBindings(nodes, {shotIds, structureNodeIds})` 已导出并有单测（studioCanvasBinding.test.cjs），但**生产路由（handlePatch 等）从未调用它**（全仓库只出现在定义处 + 测试处）。任何非法 shotId 都能落库。
- **shotId 语义歧义**：`validateAuthoritativeBindings` 的 `shotIds` 参数是调用方传入的"权威 project shot"列表，但权威 shot 到底指 `shots.id`（执行 shot）还是 `project_shots_rows.shot_id`（计划 shot）？代码未定义，生产也未接线（见 §1.5）。
- canvas 有独立 version 体系（revision + snapshot versions + restore），与 script_rows（无版本）/project_shots_rows（version 1..N）互不感知。

### 1.4 run 层（0015 studio_run_* + 0043 run_events）—— 执行快照 + 事件

| 项 | 内容 |
|---|---|
| run 表 | `studio_runs`（canvas_id、canvas_revision、compiled_graph_json 快照、idempotency_key 幂等） |
| run 节点/边 | `studio_run_nodes`（`studio_node_id` = canvas node_id，status/lease/attempt）、`studio_run_node_edges`（source/target studio node id） |
| 事件表① | `studio_run_events`（迁移 0015：IDENTITY id、run_id、run_node_id、event_type、payload）——由 studioRunEngine.emitEvent 写，**G21 审计发现"从无人读回"**（无 replay/resume 读者） |
| 事件表② | `run_events`（迁移 0043：PK `(run_id, seq)`，FK → studio_runs CASCADE）——run 级 SSE 日志；`run_event_counters` 原子分配 seq |
| 写者 | 引擎：studioRunEngine.cjs（studio_run_events + relay bridge）；run_events：runEventStore.cjs（append/appendNext/list/lastSequence）+ runEventRelay.cjs（bridge） |
| 读者 | runEventStore.listRunEvents / lastSequence；SSE 读端（studioRunApi createRunEventsSse）；CLI `mlg status` |

写点冲突点：
- **不可变 revision 绑定**：run 创建时 `SELECT ... FOR UPDATE` 锁 canvas 行 → 校验 requestedRevision === canvas.revision → 编译快照 → 落 run 节点。执行中**绝不重读 live canvas**（STEP 4）。
- **事件双表并存**：studio_run_events（引擎写、无读者）+ run_events（relay 桥写、有读者）。同一事件可能双写两表，run_events 的 `payload.run_node_id` 由 relay 折叠（runEventRelay 约定），两边无 join 一致性保证。
- run_events 是追加只读，**从不向上游实体写回**；lineage（shotId → studio_node_id → run_id → run_events）无端到端查询接口。

### 1.5 关键发现：三个 Shot id 空间互相未绑定

这是三视图无法 join 的根因：

| Shot 空间 | id 形态 | 权威表 | 被谁引用 |
|---|---|---|---|
| **执行 shot** | `shot-{uuid}` | `shots`（0017 + 0022 扩展列 + 0023），`episode_id`/`canvas_node_id` NOT NULL，`seq` | `project_structure_nodes.shot_id`（studioStructureApi.ensureShotExists 校验 shots+episodes+project）；timeline_clips.shot_id |
| **计划 shot** | `s{scene}:b{beat}:k{shot}` | `project_shots_rows.shot_id`（0045） | storyboardBatchPlan 的 taskId（`${shotId}::image_gen`）；generation intake 的 shotId |
| **canvas 绑定 shot** | 自由字符串 | canvas `data_json.shotId`（无权威表约束） | run 编译快照 safeNodeInput 透传 shotId |

- `project_structure_nodes.shot_id` 收敛到 **shots.id**（执行 shot），不是计划 shot。
- `project_shots_rows.shot_id` 是**计划 shot**，与 shots 无任何引用关系（0045 明确"不改 0017 shots"）。
- canvas 节点 `data.shotId` 本应指向哪个空间？W2-06 与 validateAuthoritativeBindings 语义上指"权威 Shot"（= shots.id），但生产未校验，实际可以是任意串。
- **计划 shot → 执行 shot 的绑定列不存在**。因此：脚本行 → 计划 shot → 执行 shot → canvas 节点 → run 节点的整条 lineage 在 DB 层面是断的，只能靠约定字符串（shotId 格式）手工对。

### 1.6 canvas 是另一域还是 plan 投影？（直接回答）

- **设计定调（已有文档，非本文件新议）**：15-infinite-canvas-v2-decision.md D1 已定——canvas 是"项目生产空间的可视化事实层（single visual source of production truth）"，节点绑定权威实体（structure/Shot/Character/...）或为生成块，**不复制实体数据**。即：canvas 应被当作**绑定/投影层**，不是独立真值域。
- **实现现实**：canvas 是一个完整独立的、CAS-revisioned、带 snapshot/version/restore 的图存储；其节点 `data_json` 里存的 shotId/structureNodeId 是未经校验的自由字符串；脚本/计划变更**没有任何代码路径**触发 canvas 图更新。
- 结论：**语义上是"绑定投影"，工程上是"独立图域"——两者脱节**。域真值设计的任务就是把这两者对齐：要么（推荐）把 canvas 明确收敛为绑定层并接线校验，要么显式承认 canvas 为独立域、把 script/plan 与 canvas 之间的同步降级为"只读参考 + 人工 apply"。

---

## 2. 域真值设计建议（单写者 vs 投影 + 校验）

### 2.1 分层真值模型

| 层 | 真值语义 | 写者数量 | 规则 |
|---|---|---|---|
| L1 script_rows | **真源（single writer）** | 1（scriptApi） | 脚本内容唯一权威，无版本（或补 revision） |
| L2 project_shots_rows | **投影 + 校验**（materialized，非独立实体） | 1（persistStoryboardShots） | 恒服务端重算；DELETE+INSERT 原子替换；version 1..N；禁止旁路写 |
| L3 canvas nodes/edges | **绑定层 + 执行层**（D1 定位） | 1（studioCanvasPersistence） | 节点绑定权威实体（shotId/structureNodeId/assetId）或为生成块；绑定必须过校验 |
| L4 run 层 | **只读快照 + 追加事件** | 引擎/relay（追加 only） | 创建时编译快照，此后 immutable；事件只追加不写回 |

### 2.2 每层具体建议

1. **L1 script_rows 补 stale 指纹**（建议，未实现）：scriptApi 每次写（POST/PATCH/PUT order/DELETE）touch 一个 `plan_dirty` 或记录 `max(updated_at)`；或 persistStoryboardShots 在 apply 时记录"源 script_rows 指纹"（hash/max updated_at）。让"持久化计划是否落后于脚本"可被查询。当前现状：无此字段，漂移不可检测。

2. **L2 计划层 = 投影，绝不独立编辑**（现状已符合大半）：`/storyboard/apply` 已做到"恒重算 + 幂等替换 + advisory lock 串行化"，方向正确。缺的是：**加 source fingerprint 列**（记录 apply 时的 script_rows 指纹）以支持 staleness 查询；`kind` 字段若由 G16 director 回填，需把它定为"L2 内的第二个受控写点"，并在同一事务内写（或由 persist 层统一写入，禁止第三方直写表）。

3. **L3 canvas = 绑定 + 校验**（核心接线缺口）：
   - **接线 `validateAuthoritativeBindings` 到 handlePatch**：PATCH 前装载权威 `shotIds`（= shots.id）与 `structureNodeIds`（= project_structure_nodes.id），对 upsert 节点校验，非法绑定返回 400 或标 STALE。
   - **统一 shotId 语义**：canvas `data.shotId` 指向 **shots.id（执行 shot）**（与 project_structure_nodes.shot_id 一致），计划 shot 不直接进 canvas 节点 data，避免双空间污染。

4. **L4 run 层**：保持现状（快照 immutable + 事件追加）。补一个**只读 lineage 查询**（§3.5），不做任何上游写。

### 2.3 关于"canvas 图漂移"的裁决

**不做自动图传播（script 编辑 → 自动改 canvas 节点）**。理由：
- canvas 是用户手绘的绑定/执行图，自动重排节点会破坏用户布局（revision CAS 也会被程序性写轰炸）。
- 正确语义是**投影 + 校验 + STALE 标记**：script/plan 变更后，绑定到受影响 shotId 的 canvas 节点标 STALE（前端已有 STALE 状态与传播机制，store.ts `isIdentityChange`/`directDownstreamIds`），由用户显式刷新或重新 apply，而非后台静默重写图。

---

## 3. 同步触发点（链）

```
script_rows 写
   │  (1) 本地失效计划缓存（GET /storyboard 本就实时重算，天然 fresh）
   │  (2) 若已 apply 过 → project_shots_rows 落后（靠 §2.2-1 指纹可查询）
   ▼
POST /storyboard/apply（显式）
   │  (3) 重算 + DELETE/INSERT（version+1）→ 发事件/SSE 通知 storyboard 视图
   │  (4) canvas 绑定 shotId 的节点 → 标 STALE（若绑定的 shot 消失/重分块）
   ▼
canvas PATCH（用户手绘绑定）
   │  (5) handlePatch 接线 validateAuthoritativeBindings → 非法绑定拒绝/STALE
   ▼
run create（POST /studio/runs）
   │  (6) FOR UPDATE 锁 canvas → 校验 revision → 编译快照 → studio_run_nodes/edges
   │  (7) run_events 追加（relay bridge）
   ▼
agent 视图（§3.5）= plan + run
```

### 3.1 触发点细则

| # | 触发 | 动作 | 落点 |
|---|---|---|---|
| 1 | script_rows insert/patch/delete/reorder | 失效计划缓存；touch plan_dirty | scriptApi.cjs |
| 2 | script_rows 变更后读取持久化计划 | 返回"计划落后于脚本"标记（若 §2.2-1 落地） | scriptApi GET /storyboard 或新查询 |
| 3 | POST /storyboard/apply | 重算 + 替换 + version+1 + 事件通知 | storyboardShots.cjs / scriptApi.cjs |
| 4 | apply 后（shotId 集变更） | 校验 canvas 绑定节点 shotId 仍存在，否则 STALE | studioCanvasPersistence（校验）+ 前端 STALE |
| 5 | canvas PATCH | 绑定校验（shotId/structureNodeId） | studioCanvasPersistence.cjs handlePatch |
| 6 | run create | revision 门 + 编译快照 | studioRunEngine.cjs |
| 7 | run 事件 | 追加 run_events | runEventStore/runEventRelay |

### 3.2 "agent 视图 = plan + run" 定义

agent（CLI mlg / 未来 agent 面板）看到的应是**读视图**，join 两个真值：
- **plan**：`project_shots_rows`（最新 version，或实时 `buildStoryboardPlan(script_rows)`）—— 回答"计划做什么"。
- **run**：`studio_runs` + `studio_run_nodes` + `run_events` —— 回答"执行到哪了"。
- 连接键：`shotId` → `studio_node_id`（run 节点）→ `run_id` → `run_events`。这条键链当前**缺 plan shot → 执行 shot → canvas node** 的前半段（§1.5），须先补绑定（§4 叶 4）。

---

## 4. 落地拆叶清单（每叶文件归属；均未实现，纯规划）

> 依赖顺序：叶 4（统一 shot 绑定）是叶 5/6 的前置；叶 1/2 可并行。

| 叶 | 内容 | 文件归属 | 依赖 |
|---|---|---|---|
| 叶 1 | script_rows 加 plan 指纹/dirty 标记（可检测 plan 落后） | 新迁移 `server/db/migrations/XXXX_script_plan_fingerprint.sql`；`server/modules/script/scriptApi.cjs`（写后 touch）；`server/modules/script/storyboardShots.cjs`（apply 记录指纹） | 无 |
| 叶 2 | 接线 `validateAuthoritativeBindings` 到 canvas PATCH | `server/modules/project-foundation/studioCanvasPersistence.cjs`（handlePatch 装载权威集并校验）；`studioCanvasBinding.test.cjs`（扩展） | 无 |
| 叶 3 | 权威绑定源解析器（shotIds ← shots.id；structureNodeIds ← project_structure_nodes.id；统一 shotId 语义 = 执行 shot） | 新 `server/modules/project-foundation/studioBindingAuthority.cjs` 或 studioCanvasPersistence 内 helper | 无 |
| 叶 4 | 计划 shot → 执行 shot 显式绑定列（打通 lineage 前半段） | 新迁移 `XXXX_plan_shot_execution_binding.sql`（project_shots_rows 加 `execution_shot_id` 或 join 表）；`storyboardShots.cjs` 或 shots API 建立映射 | 无 |
| 叶 5 | run lineage 只读查询（shotId → studio_node_id → run_id → run_events） | `server/modules/project-foundation/studioRunApi.cjs` 或 `runEventStore.cjs` 增 reader | 叶 4 |
| 叶 6 | agent 视图 = plan + run（mlg 新子命令，join 三表） | `server/cli/mlg.cjs`（`mlg plan <scriptId>` / `mlg project <id>`）；`mlg.test.cjs` | 叶 4、叶 5 |
| 叶 7 | canvas STALE 传播（script/plan 变更 → 绑定节点 STALE） | `src/features/studio-v2/store.ts`（复用 STALE 机制）；SSE 桥（`studioRunApi.cjs` createRunEventsSse 扩展或新事件） | 叶 2 |
| 叶 8 | storyboard/script 节点注册补全（Blueprint base kind 未进 registry 10 kind；补 shotId 绑定字段） | `src/features/studio-v2/registry.ts`、`src/features/studio-v2/types.ts` | 叶 3 |

---

## 5. 未验证项 / 边界（诚实声明）

- 本节所有"现状"均来自对下列文件的**读取**（非运行时实测）：0039/0045/0043/0014/0017/0022 迁移 SQL、scriptApi.cjs、storyboardPlan.cjs、storyboardShots.cjs、storyboardBatchPlan.cjs、directorizeRows.cjs、studioCanvasPersistence.cjs、studioRunEngine.cjs、studioRunGraph.cjs、runEventStore.cjs、studioStructureApi.cjs、studioRunApi.cjs、mlg.cjs、studio-v2/{types,store,graphRules,registry}.ts、docs/15。
- **未运行任何 DB/API**，未验证运行时行为（如 advisory lock 在真实 PG 的并发表现、validateAuthoritativeBindings 确无隐藏调用点之外的生产接线）。
- `validateAuthoritativeBindings` "从未在生产调用"的判定基于全仓库 grep（server/ 与 src/），仅命中定义处 + 测试处；不排除未来分支/动态 require 引用，但当前主干未接线。
- 叶 4 的"计划 shot → 执行 shot 绑定"目前**不存在**，§1.5 的断裂是结构性结论（两张表无 FK、无引用列），非推测。
