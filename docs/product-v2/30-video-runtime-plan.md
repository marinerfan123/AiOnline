# MOLING_VIDEO_RUNTIME_V2 — 叶级执行计划（Phase 0-10）

> 规范上位：`MOLING_VIDEO_RUNTIME_ARCH_V2.md`（§4 术语 / §46 phase / §48 outbox / §57 inbox / §133-135 reconciler / §139-149 phase / §150 叶子字段 / §151 Gate）
> 盘点依据：`docs/product-v2/28-video-runtime-audit-v2.md`（Phase 0，已产出）
> 唯一可写产物：本文件 `docs/product-v2/30-video-runtime-plan.md`
> 原则：**EXTEND 不 DUPLICATE**（§3/§157）；纯规划，未改码/未 git/未 ssh/未实测。
> 迁移链现状 head = **0057**；新迁移号从 **0058** 起预留。测试约定：`node --test`（generation-v2 用 `--test-concurrency=1`；迁移用 `NODE_ENV=test node --test server/db/migration.test.cjs`）。
> 备注：`29-video-runtime-digest-v2.md` 在写本计划时未落盘（并行叶未完成），本计划以 28 盘点 + 规范为准。

---

## 0. Top10 差距清单（源于 28-audit，对齐 §4/§44-48/§57/§78/§84-88/§133-134）

| # | 差距 | 审计证据 | 对应规范 | 归属 Phase |
|---|---|---|---|---|
| G1 | Operation Registry 缺失（Operation 非一等对象） | 28:B `model_operations` 无 | §4.3/§7 | 1 |
| G2 | 逻辑/物理模型未分离，无不可变 revision 实体 | 28:B 4.1/4.2 | §4.1-4.2/§7.1-7.2 | 1 |
| G3 | Schema 无 revision 化 / UI Schema / Semantic Map 未建模 | 28:E Phase1 | §8-14 | 1/7 |
| G4 | Activity 实体完全缺失（可独立重试步骤） | 28:B 4.9「缺失」 | §4.9/§42/§44 | 2 |
| G5 | Outbox 有表未接线：legacy 分发走进程内 fire-and-forget，dual-write 风险 | 28:B 1.7 + D#2 | §48（P0） | 2 |
| G6 | Job/Attempt 语义分散 6 套，无统一 phase/reason，状态单调未实现 | 28:B 4.7/4.8 + C6 + D#1 | §45-47/§62 | 2/3 |
| G7 | Webhook Inbox 完全缺失，webhook 无→纯轮询 | 28:B 1.8 + D 无 | §57-58/§60 | 3 |
| G8 | Reconciler 阈值分散且不按 phase/provider/service_class 配置 | 28:C2 + D#3 | §133-134 | 3 |
| G9 | Provider Success ≠ Job Success 未完全（先 commit 后 finalize） | 28:C4 | §79-80/§78 | 5 |
| G10 | Billing 三段(estimated/actual/user_charge)缺 + Pricing Calculator 缺 + max_cost_authorized 缺 | 28:C3 | §84-88 | 5 |
| G11 | Router 两层未分离；Quota Scope/Certification/Resolve 缺失 | 28:C5 + D#6 | §29/§24/§19/§36 | 6 |
| G12 | 重复实现 TOP8：5 套执行引擎 / 3 套 outbox / 3 套 reconciler / 3 套 finalize / 3 套账 | 28:D | §3（EXTEND） | 贯穿 |

> 注：G12 非独立 Phase，是每叶「EXTEND 现模块、不新建平行系统」的贯穿约束；每条叶子必须落在「现表/现模块」上。

---

## A+B. 叶级清单总表（Phase → 叶子 → EXTEND 目标 → 迁移 → 依赖 → 串行/并行）

**符号**：🟥=串行点（server.js / 迁移链同段 / 单写者文件）；🟩=可并行；依赖列 `←` 后为前置叶。

| ID | Phase | 叶子标题 | 差距 | EXTEND 目标（现表/现模块） | 迁移 | 依赖 | 串/并 |
|---|---|---|---|---|---|---|---|
| L1 | 1 | `logical_models` + `model_revisions` 表 | G2 | EXTEND `models`(0001) 之上加逻辑层表 | 0058 | — | 🟩 组A |
| L2 | 1 | `model_operations` + `model_operation_revisions` 表 | G1 | 新表（现无对应） | 0059 | — | 🟩 组A |
| L3 | 1 | Operation Registry 服务 | G1 | EXTEND `modelhub/jobs.cjs`+`resolver.cjs` | — | L1,L2 | 🟩 组B |
| L4 | 1 | Input Schema 校验运行时（JSON Schema 2020-12） | G3 | EXTEND `modelhub/modelSchema.cjs` | — | L2 | 🟩 组B |
| L5 | 1 | UI Schema + Semantic Map + capability_descriptor 存储 | G3 | EXTEND `modelhub/modelSchema.cjs` | — | L2 | 🟩 组B |
| L6 | 1 | capability_signature（canonical JSON SHA-256） | G3 | EXTEND `modelhub/bindings.cjs` | — | L2 | 🟩 组B |
| L7 | 1 | Feature Flag 脚手架（8 个 VIDEO_*） | G3 | EXTEND 现有 flag 机制 | — | — | 🟩 组A |
| L8 | 2 | `generation_activity_runs` 表 | G4 | 新表（EXTEND generation_items_v2 之上） | 0060 | — | 🟩 组C |
| L9 | 2 | Activity 执行循环（8 类 activity 各自 retry/timeout/idempotency） | G4 | EXTEND `generation-v2/generation-worker.cjs` | — | L8 | 🟥 单写 generation-worker |
| L10 | 2 | Worker Lease 扩到 Activity（lease_owner/heartbeat/expiry） | G4 | EXTEND `generation-v2/lease.cjs`+`lease-heartbeat.cjs` | — | L8 | 🟥 单写 lease |
| L11 | 2 | Outbox 接线 legacy 分发（事务内写 dispatch_outbox） | G5 | EXTEND `dispatcher.cjs`+`generation-v2/shadow.cjs` | — | — | 🟥 server.js/dispatcher |
| L12 | 2 | `phase`+`reason` 列 + CHECK 单调（External/Internal 分离） | G6 | EXTEND `generation_tasks`(0001)/`generation_items_v2`(0002) | 0061 | — | 🟥 迁移链同段 |
| L13 | 2 | `generation_events` append-only 事件日志 | G6 | EXTEND `runEventStore.cjs` 模式（复用 0043/0049） | 0061 | L12 | 🟥 迁移链同段 |
| L14 | 2 | SUBMIT_UNKNOWN 恢复序（6 步，禁自动重提） | G6 | EXTEND `generation-v2/reconciler.cjs` | — | L9,L10,L11 | 🟥 单写 reconciler |
| L15 | 2 | Internal Idempotency 对齐（tenant+endpoint_scope+key 唯一） | G5 | EXTEND `billing.cjs`+`generation-v2/intake.cjs` | 0061 | L11 | 🟥 单写 billing |
| L16 | 3 | `webhook_inbox` 表 | G7 | 新表（复用 0008 webhook_events 幂等思路） | 0062 | — | 🟩 组D |
| L17 | 3 | Webhook 安全（验签/timestamp 防重放/constant-time） | G7 | EXTEND `webhook_events` 校验模式 | — | L16 | 🟩 组D |
| L18 | 3 | 内部 Event Envelope（CloudEvents 风格） | G7 | 纯库，新 `eventEnvelope.cjs` | — | — | 🟩 组D |
| L19 | 3 | Event Reducer `applyProviderEvent()`（唯一状态入口） | G7 | EXTEND `generation-v2/provider-status-router.cjs` | — | L16,L18 | 🟥 单写 provider-status-router |
| L20 | 3 | 状态单调推进 + `provider_event_anomaly` 记录 | G6 | EXTEND `generation-v2/reconciler.cjs` | — | L19,L12 | 🟥 单写 reconciler |
| L21 | 3 | Poll Policy provider-specific + 4 类 deadline | G8 | EXTEND `generation-v2/provider-status-router.cjs` | 0063 | L19 | 🟥 单写 provider-status-router |
| L22 | 4 | Driver Contract 接口 + normalizeStatus/Error/Result | G1 | EXTEND `generation-v2/provider-adapter.cjs` | 0064 | L3 | 🟥 单写 provider-adapter |
| L23 | 4 | Provider Driver: volcengine（直连） | G12 | EXTEND `generation-v2/provider-adapter.cjs` | — | L22 | 🟩 组E |
| L24 | 4 | Provider Driver: fal（聚合） | G12 | 同上 | — | L22 | 🟩 组E |
| L25 | 4 | Provider Driver: vidu（多 Operation） | G12 | 同上 | — | L22 | 🟩 组E |
| L26 | 4 | Golden Compile/Normalize Fixture + Contract Tests | G1 | EXTEND `generation-v2/fake-provider.cjs` | — | L22 | 🟩 组E |
| L27 | 5 | OutputManifest（artifacts[] + provider_metadata） | G9 | EXTEND `assetFinalize.cjs`+`resultFinalize.cjs` | 0065 | L19 | 🟥 单写 assetFinalize |
| L28 | 5 | Finalize 独立重试（provider result snapshot） | G9 | EXTEND `assetFinalize.cjs` | — | L27 | 🟥 单写 assetFinalize |
| L29 | 5 | Media Metadata 扩展（checksum/codec/duration/缩略图） | G9 | EXTEND `media`(0001)+`media_derived_artifacts`(0050) | 0065 | L27 | 🟥 迁移链同段 |
| L30 | 5 | Billing 三段分离（estimated/actual/user_charge） | G10 | EXTEND `credit_transactions`(0001)+`generation_credit_holds_v2`(0002) | 0066 | L15 | 🟥 单写 billing |
| L31 | 5 | Pricing Rule 计算器（versioned calculator，禁任意 JS） | G10 | EXTEND `modelhub/pricing.cjs` | 0066 | L3 | 🟥 单写 pricing |
| L32 | 5 | max_cost_authorized 重估闸 | G10 | EXTEND `billing.cjs`+`server.js` 预扣段 | — | L30,L31 | 🟥 server.js |
| L33 | 5 | Ledger Idempotency `settle:{attempt_id}` | G10 | EXTEND `generation-v2/ledger.cjs` | — | L30 | 🟥 单写 ledger |
| L34 | 6 | `provider_quota_scopes` 表 | G11 | 新表（替换资源池语义） | 0067 | — | 🟩 组F |
| L35 | 6 | Quota Admission（ALL MATCHED SCOPES） | G11 | EXTEND `generation-v2/provider-admission.cjs` | — | L34 | 🟥 单写 provider-admission |
| L36 | 6 | Provider Certification（fidelity_class + 状态机） | G11 | EXTEND `modelhub/bindings.cjs` | 0067 | L3 | 🟩 组F |
| L37 | 6 | Binding Router（下层，手动模型不跨模型） | G11 | EXTEND `modelhub/router.cjs` | — | L35,L36 | 🟥 单写 router |
| L38 | 6 | Auto Model Router（上层，13 道 admission 固定序） | G11 | EXTEND `modelhub/router.cjs` | — | L37 | 🟥 单写 router |
| L39 | 6 | Resolve / Dry-run API（POST /api/generation/resolve） | G11 | EXTEND `server.js`+`modelhub/routerDecision.cjs` | — | L38 | 🟥 server.js |
| L40 | 6 | Routing Policy 版本化 + 决策快照 | G11 | EXTEND `modelhub/routingAudit.cjs`（并 0033/0010 两表） | 0068 | L37 | 🟥 单写 routingAudit |
| L41 | 7 | Schema→UI Form 生成器 | G3 | EXTEND `modelhub/studioModelsApi.cjs`+前端 | — | L5 | 🟩 组G |
| L42 | 7 | Custom Renderer Registry | G3 | 新 `rendererRegistry.cjs`（EXTEND studioNodeRegistry 模式） | — | L41 | 🟩 组G |
| L43 | 7 | Projection Report（exact/adjusted/parked/dropped） | G3 | EXTEND `modelhub/projectDirector.cjs` | — | L5 | 🟩 组G |
| L44 | 7 | Parked State 保存/恢复 | G3 | EXTEND canvas 参数态 + 新 `semantic_parked_state` | 0069 | L43 | 🟩 组G |
| L45 | 8 | `generation_group` 表 + 组执行 | G12 | 新表（对齐 shot 语义） | 0070 | L9 | 🟥 单写 generation-worker |
| L46 | 8 | Canvas Video Node（semantic/parked/job_id） | G12 | EXTEND `studioCanvasPersistence.cjs` | — | L44 | 🟩 组H |
| L47 | 8 | Lineage 链接（parent_job_id/source_asset_ids） | G12 | EXTEND `assetLineage.cjs`+`shotLineage.cjs` | 0070 | L27 | 🟥 单写 assetLineage |
| L48 | 8 | 连续镜头（last_frame→first_frame 服务器资产链） | G12 | EXTEND `script/storyboardBatchExecutor.cjs` | — | L47 | 🟩 组H |
| L49 | 9 | `workflow_definitions`+`workflow_revisions` 表 | G12 | 新表 | 0071 | — | 🟩 组I |
| L50 | 9 | `workflow_runs`+`workflow_step_runs` 表 + DAG | G12 | 新表（复用 0015 studio_run DAG 语义） | 0072 | L49 | 🟩 组I |
| L51 | 9 | Workflow 执行（经 Generation V2 Job，不直连 Provider） | G12 | EXTEND `studioRunEngine.cjs` | — | L50,L9 | 🟥 单写 studioRunEngine |
| L52 | 9 | Workflow Revision pinning（禁 latest，Gate 20） | G12 | EXTEND `studioRunEngine.cjs` | — | L51 | 🟥 单写 studioRunEngine |
| L53 | 10 | Traffic Switch（flag 全量 + shadow 对齐） | G12 | EXTEND `server.js` 入口 + canary | — | L39,L51 | 🟥 server.js |
| L54 | 10 | 稳定窗口观测（metrics + 回滚预案） | G12 | EXTEND `generation-v2/observability.cjs` | — | L53 | 🟩 组J |
| L55 | 10 | 删除 legacy 路径（流量=0 后） | G12 | 清理 `dispatcher.cjs` legacy 路由/旧表 | DROP 迁移 | L54 | 🟥 单写 dispatcher |

**预计总叶数 ≈ 55 实施叶**（L1-L55；另有 Phase 0 计划叶 L0=本文件）。

### 并行批次分组（每批内文件不交叠；🟥 为跨批串行锚点）

| 批次 | 叶集合 | 说明 |
|---|---|---|
| 组A | L1, L2, L7 | 表定义互不交叠（0058/0059 分属 L1/L2） |
| 组B | L3, L4, L5, L6 | 依赖 L1/L2 完成后并行；各写独立新文件 |
| 组C | L8 | 单叶（建 activity 表，后续锚点） |
| 组D | L16, L17, L18 | inbox 表/验签/信封库互不交叠 |
| 组E | L23, L24, L25, L26 | 三个 provider driver 各写独立文件 |
| 组F | L34, L36 | quota 表 vs bindings 认证，互不交叠 |
| 组G | L41, L42, L43, L44 | UI/投影/ parked 各独立文件（L44 依赖 L43 但文件独立，可同批排后） |
| 组H | L46, L48 | canvas node vs storyboard 连续镜头 |
| 组I | L49, L50 | 两个新表迁移文件独立 |
| 组J | L54 | 观测，无冲突 |

> 20-30 线程投放：同组内叶并行 + 跨组仅当依赖叶已合入（🟩 组可整组并发；🟥 单写者文件按叶串行，但不同单写者文件之间可并发）。

---

## C. Gate 映射（§151 全量 20 Gate；任务简报写「19」→ 以规范 §151 为准，Gate 20 仅 Phase 9 生效）

| Gate | 验收内容 | 合体验收叶 | 验收命令（容器内） |
|---|---|---|---|
| G1 新模型零核心修改 | 加 `video.future-test` 不改 5 核心 switch | L1-L7 | 新增 seed 后跑 `node --test server/modules/modelhub/*.test.cjs` + 核对 diff 不含 dispatcher/server.js core |
| G2 新 Operation | `video.future_operation` 仅 Registry/Schema/Driver 即可跑 | L2,L3,L4,L22 | `node --test server/modules/modelhub/registry.test.cjs` |
| G3 参数切换 | 产生 exact/adjusted/parked | L5,L43,L44 | `node --test server/modules/modelhub/projectDirector.test.cjs` |
| G4 Duplicate API Request | 1 Job + 1 reserve | L11,L15 | `node --test server/modules/generation-v2/intake.test.cjs` |
| G5 DB成功/Queue失败 | outbox 恢复后 provider 只提交一次 | L9,L10,L11 | `node --test server/modules/generation-v2/outbox-recovery.test.cjs` |
| G6 Worker Crash | lease 到期他 worker 接手 | L9,L10 | `node --test server/modules/generation-v2/lease.test.cjs` |
| G7 Submit Unknown | 不创建第二任务 | L11,L14 | `node --test server/modules/generation-v2/no-blind-resubmit.test.cjs` |
| G8 Duplicate Webhook | Finalize once / Settle once | L16,L19,L33 | `node --test server/modules/generation-v2/webhookInbox.test.cjs` |
| G9 Out of Order | RUNNING→SUCCEEDED→RUNNING 终 SUCCEEDED | L19,L20 | `node --test server/modules/generation-v2/eventReducer.test.cjs` |
| G10 Provider Success/OSS Fail | 只重试 Finalize，生成次数=1 | L27,L28 | `node --test server/modules/generation-v2/oss-failure.test.cjs` |
| G11 Wait Timeout | 用户超时 Provider 继续，Job 最终完成 | L19,L20,L21 | `node --test server/modules/generation-v2/provider-status-router.test.cjs` |
| G12 Cancel Unsupported | 记 actual provider cost | L21,L30,L33 | `node --test server/modules/generation-v2/ledger.test.cjs` |
| G13 Manual Model | 全 Veo binding 失败禁调 Seedance | L37 | `node --test server/modules/modelhub/router.test.cjs` |
| G14 Auto Model | 能力过滤后才 score | L38 | 同上 router.test.cjs |
| G15 Unknown Provider Equality | certification=UNVERIFIED 禁透明 fallback | L36,L37 | `node --test server/modules/modelhub/bindings.test.cjs` |
| G16 Quota Scope | Account/Credential/Model 三层同时作用 | L34,L35 | `node --test server/modules/generation-v2/provider-admission.test.cjs` |
| G17 Pricing | 参考视频时长↑ → 预估成本正确变 | L30,L31 | `node --test server/modules/modelhub/pricing.test.cjs` |
| G18 Historical Snapshot | 改 Schema/Routing/Pricing/Driver 旧 Job 仍显旧 revision | L27,L30,L33,L40 | `node --test server/modules/generation-v2/job-snapshot.test.cjs` |
| G19 Runtime Upgrade Replay | 新 Reducer 回放旧 fixture 同终态 | L13,L19,L20 | `node --test server/modules/generation-v2/replay.test.cjs` |
| G20 Workflow Pinning | WF V2 上线旧 Project pin V1 重跑继续 V1 | L49,L52 | `node --test server/modules/project-foundation/studioRunEngine.test.cjs` |

---

## D. Phase 门槛（完成判据）

| Phase | 迁移 head | 测试判据 | 容器验 |
|---|---|---|---|
| 0 | — | `28-video-runtime-audit-v2.md` 已产出 | 盘点全绿（无生产行为变更） |
| 1 | 0059 | `modelhub/*.test.cjs` ≥ 6 新用例全绿 | 3 个 Operation 可 registry 查询，schema 可校验 |
| 2 | 0061 | activity/lease/outbox/submit_unknown 用例 ≥ 10 全绿 | Gate 4-7 通过 |
| 3 | 0063 | reducer/monotonic/inbox 用例 ≥ 8 全绿 | Gate 8-9/11-12 通过 |
| 4 | 0064 | 3 provider contract tests + golden fixtures 全绿 | Gate 1-2 以真实 credential shadow 通过 |
| 5 | 0066 | pricing/finalize-retry/ledger 用例 ≥ 8 全绿 | Gate 10/17 通过 |
| 6 | 0068 | router 两层/quota/cert 用例 ≥ 8 全绿 | Gate 13-16 通过 |
| 7 | 0069 | form/projection/parked 用例 ≥ 5 全绿 | Gate 3 通过 |
| 8 | 0070 | group/lineage/连续镜头用例 ≥ 5 全绿 | 手工：组内 3 模型并跑，lineage 链完整 |
| 9 | 0072 | workflow pin/DAG 用例 ≥ 5 全绿 | Gate 20 通过 |
| 10 | 0072(回退) | 全量回归 + legacy 路径删除后 core 全绿 | legacy traffic=0 + 稳定窗口≥1 观测周期 |

---

## E. 前 3 批可直接派发简报（每批 6-10 叶，§150 字段）

### 批次 1（Phase 1 Registry，7 叶）— 依赖：无（Phase 0 已完成）

#### L1 — logical_models + model_revisions 表
- **Goal**：建逻辑模型与不可变 revision 两张表，把现有 `models`(0001) 物理层之上补逻辑层
- **Why**：§4.1-4.2 要求 Logical Model 与 Model Revision 分离；现状 `models.revision` 仅整型 counter，无不可变实体
- **Reuse**：`models`(0001:23/90)、`model_price_history`（versioned 思路）、`server/db/migrate.cjs` 迁移框架
- **Files**：`server/db/migrations/0058_logical_models.sql`(新)、`server/modules/modelhub/registry-schema.cjs`(新)
- **DB**：+`logical_models(id, code, media_type, display_name, vendor_family, status ACTIVE/DEPRECATED/DISABLED/RETIRED, created_at)`；+`model_revisions(id, logical_model_id FK, revision_code, upstream_vendor, upstream_model_family, released_at, status, metadata JSONB, created_at)`
- **迁移**：0058 forward-only additive（IF NOT EXISTS），不触 0001-0057
- **Rollback**：DROP 两表（未接线前无依赖）
- **Tests**：`node --test server/modules/modelhub/registry-schema.test.cjs` — 唯一约束、revision 不可变（UPDATE 拒绝）、status 词表
- **AcceptCmd**：`node --test server/modules/modelhub/registry-schema.test.cjs` 全绿 + `NODE_ENV=test node --test server/db/migration.test.cjs` 0058 落库

#### L2 — model_operations + model_operation_revisions 表
- **Goal**：Operation 一等对象 + 不可变 operation revision（input/output schema、ui_schema、semantic_map、capability_descriptor、schema_hash）
- **Why**：§4.3/§7.3-7.4 Operation Registry 缺失（审计 G1）；Vidu Start-End 等证明 operation 不能 giant schema
- **Reuse**：`ai_capabilities`/`ai_parameter_schemas`(0010)、`modelhub/modelSchema.cjs`（schema 校验雏形）
- **Files**：`server/db/migrations/0059_model_operations.sql`(新)
- **DB**：+`model_operations(id, code, media_type, kind='ATOMIC', display_name, status)`；+`model_operation_revisions(id, model_revision_id FK, operation_id FK, revision, input_schema JSONB, output_schema JSONB, ui_schema JSONB, semantic_map JSONB, capability_descriptor JSONB, schema_hash, status DRAFT/VALIDATING/CANARY/ACTIVE/DEPRECATED/RETIRED, created_at, activated_at)`
- **迁移**：0059 additive；ACTIVE 后禁 UPDATE schema（应用层 + trigger 兜底）
- **Rollback**：DROP 两表
- **Tests**：`registry-schema.test.cjs` 追加 operation revision 不可变 + schema_hash 一致性
- **AcceptCmd**：`node --test server/modules/modelhub/registry-schema.test.cjs` 全绿 + migration.test 0059

#### L3 — Operation Registry 服务
- **Goal**：registry 查询/登记 API：listOperations、resolveOperationRevision、activateRevision
- **Why**：§129 Admin ModelHub 需要；Operation 成为 resolver 输入
- **Reuse**：`modelhub/jobs.cjs`（现有 job 语义）、`modelhub/resolver.cjs`（模型身份解析）
- **Files**：`server/modules/modelhub/registry.cjs`(新) + `.test.cjs`(新)
- **DB**：读 L1/L2 新表，无新增
- **迁移**：无
- **Rollback**：删 registry.cjs（未接线）
- **Tests**：`node --test server/modules/modelhub/registry.test.cjs` — 登记/查询/激活/不可变
- **AcceptCmd**：`node --test server/modules/modelhub/registry.test.cjs` 全绿

#### L4 — Input Schema 校验运行时（JSON Schema 2020-12）
- **Goal**：用 ajv（Draft 2020-12，unevaluatedProperties）校验 operation input
- **Why**：§8-9 服务器验证最终权威；组合 schema 需 unevaluatedProperties
- **Reuse**：`modelhub/modelSchema.cjs`（现有校验逻辑 EXTEND）
- **Files**：`server/modules/modelhub/modelSchema.cjs`(改)、`modelSchema.test.cjs`(改)
- **DB**：无（读 L2 input_schema）
- **迁移**：无
- **Rollback**：git revert 单文件
- **Tests**：组合 schema oneOf/allOf 不误判 + required/min/max/交叉字段约束
- **AcceptCmd**：`node --test server/modules/modelhub/modelSchema.test.cjs` 全绿

#### L5 — UI Schema + Semantic Map + capability_descriptor 存储/读取
- **Goal**：为 operation revision 提供 ui_schema/semantic_map/capability_descriptor 的存取
- **Why**：§10-14 Schema 不塞 x-moling-*；semantic 层管迁移/UI 兼容/路由推理
- **Reuse**：`modelhub/modelSchema.cjs`、`modelhub/shortcuts.cjs`（参数快捷）
- **Files**：`server/modules/modelhub/semanticMap.cjs`(新) + `.test.cjs`(新)
- **DB**：读 L2 列，无新增
- **迁移**：无
- **Rollback**：删新文件
- **Tests**：semantic 字段映射（duration→video.duration, transfer=nearest/asset）
- **AcceptCmd**：`node --test server/modules/modelhub/semanticMap.test.cjs` 全绿

#### L6 — capability_signature（canonical JSON SHA-256）
- **Goal**：按 §21 计算 capability 签名（operation+semantics+duration/resolution/ratio/asset limits+api version+compiler revision）
- **Why**：§21 Provider 更新→签名变→触发重认证
- **Reuse**：`modelhub/bindings.cjs`（绑定读取）、现有 `0037 media_checksum` 哈希工具
- **Files**：`server/modules/modelhub/capabilitySignature.cjs`(新) + `.test.cjs`(新)
- **DB**：无
- **迁移**：无
- **Rollback**：删新文件
- **Tests**：canonical 序列化确定性（键序无关）、字段变更→签名变
- **AcceptCmd**：`node --test server/modules/modelhub/capabilitySignature.test.cjs` 全绿

#### L7 — Feature Flag 脚手架（8 个 VIDEO_*）
- **Goal**：`VIDEO_OPERATION_REGISTRY/VIDEO_SCHEMA_RUNTIME/VIDEO_NEW_DRIVER_RUNTIME/VIDEO_DURABLE_EVENTS/VIDEO_NEW_ROUTER/VIDEO_SCHEMA_UI/VIDEO_CANVAS_RUNTIME/VIDEO_WORKFLOW_RUNTIME` 开关
- **Why**：§138 渐进上线；Phase 1 默认 off
- **Reuse**：现有 feature-flag 机制（若 modelhub 已有 flag，EXTEND）
- **Files**：`server/modules/modelhub/flags.cjs`(新) + `.test.cjs`(新)
- **DB**：无
- **迁移**：无
- **Rollback**：删新文件
- **Tests**：8 flag 默认值 + 读取接口
- **AcceptCmd**：`node --test server/modules/modelhub/flags.test.cjs` 全绿

### 批次 2（Phase 2 Durable Job Core 前半，6 叶）— 依赖：批次 1

#### L8 — generation_activity_runs 表
- **Goal**：Activity 一等实体表（job_id/attempt_id/activity_type/activity_revision/status/attempt_count/heartbeat/next_retry/error_code）
- **Why**：§44 建议实体；审计 G4「Activity 完全缺失」；禁止 Job Retry=从第一步重跑（§43）
- **Reuse**：`generation_items_v2`(0002)/`generation_item_attempts_v2`(0002)、`studio_run_nodes.attempt`(0015) 计数列语义
- **Files**：`server/db/migrations/0060_generation_activity_runs.sql`(新)
- **DB**：+`generation_activity_runs(id, job_id, attempt_id, activity_type CHECK(PREPARE_ASSETS/ACQUIRE_QUOTA/SUBMIT_PROVIDER/OBSERVE_PROVIDER/FETCH_OUTPUT/VERIFY_OUTPUT/FINALIZE_ASSETS/SETTLE_BILLING), activity_revision, status, attempt_count, started_at, heartbeat_at, next_retry_at, completed_at, error_code, lease_owner, lease_expires_at)`
- **迁移**：0060 additive
- **Rollback**：DROP 表
- **Tests**：`activity-run.test.cjs`（见 L9）复用；本叶仅 schema 校验 + CHECK 词表
- **AcceptCmd**：`NODE_ENV=test node --test server/db/migration.test.cjs` 0060 落库

#### L9 — Activity 执行循环
- **Goal**：每 activity 独立 retry/timeout/idempotency 的执行器（8 类 activity 调度）
- **Why**：§42 每 activity 自己的重试；§43 只重试失败步骤不重跑
- **Reuse**：`generation-v2/generation-worker.cjs`（worker 主循环 EXTEND）、`generation-v2/retry-policy.cjs`
- **Files**：`server/modules/generation-v2/activity-runner.cjs`(新) + `.test.cjs`(新)；`generation-worker.cjs`(改，挂载)
- **DB**：读写 generation_activity_runs(0060)
- **迁移**：无
- **Rollback**：删 activity-runner.cjs，worker 回退
- **Tests**：activity 失败仅重试该步（不重跑 submit）、timeout 独立、幂等重入
- **AcceptCmd**：`node --test --test-concurrency=1 server/modules/generation-v2/activity-runner.test.cjs` 全绿

#### L10 — Worker Lease 扩到 Activity
- **Goal**：activity 行级 lease（lease_owner/lease_expires_at/heartbeat_at）+ 到期接管
- **Why**：§51 Worker crash 后他 worker 接手（Gate 6）
- **Reuse**：`generation-v2/lease.cjs`/`lease-heartbeat.cjs`/`lease-guard.cjs`（已实现 lease 机制，EXTEND 到 activity）
- **Files**：`generation-v2/lease.cjs`(改)、`lease.test.cjs`(改)
- **DB**：读 0060 列
- **迁移**：无
- **Rollback**：git revert
- **Tests**：lease 到期→另一 worker claim 成功、heartbeat 续租、fencing
- **AcceptCmd**：`node --test --test-concurrency=1 server/modules/generation-v2/lease.test.cjs` 全绿

#### L11 — Outbox 接线 legacy 分发
- **Goal**：`POST /api/generate` 事务内写 dispatch_outbox，消除进程内 fire-and-forget dual-write
- **Why**：§48 P0；审计 G5「legacy 分发不写 outbox，dispatcher.cjs:1090 进程内 Promise 链」
- **Reuse**：`generation-v2/shadow.cjs`（writeShadowBatch 已非阻断双写）、`outbox`(0001)/`generation_outbox_v2`(0002)/`event_outbox`(0025) 三表（选 `generation_outbox_v2` 为权威，另两表退役规划）
- **Files**：`server/dispatcher.cjs`(改)、`server/modules/generation-v2/shadow.cjs`(改)、`outbox-recovery.test.cjs`(新)
- **DB**：复用 generation_outbox_v2；无新表（如需加 `dispatch_outbox` 段则并入 0061）
- **迁移**：0061 段（如需列）
- **Rollback**：kill-switch 回退 fire-and-forget 路径
- **Tests**：DB 成功 + queue 失败 → outbox 恢复后 provider 只提交一次（Gate 5）
- **AcceptCmd**：`node --test --test-concurrency=1 server/modules/generation-v2/outbox-recovery.test.cjs` 全绿

#### L12 — phase + reason 列 + CHECK 单调
- **Goal**：`generation_tasks`/`generation_items_v2` 增加 `phase`(§46 词表) + `reason`(§47 词表)，External status 与 Internal phase 分离
- **Why**：§45-47；审计 C6「无 phase、无 reason、13 态混内外」
- **Reuse**：`generation_tasks`(0001:155)、`generation_items_v2`(0002/0003 status CHECK)
- **Files**：`server/db/migrations/0061_phase_reason.sql`(新)
- **DB**：+`phase` 列（VALIDATING/RESERVING/WAITING_CAPACITY/PREPARING_ASSETS/SUBMITTING/PROVIDER_QUEUE/PROVIDER_RUNNING/FETCHING_OUTPUT/FINALIZING/SETTLING/RECONCILING/CANCELING）+`reason` 列（PROVIDER_THROTTLED/RATE_LIMIT/WAITING_RETRY/ASSET_DOWNLOAD_RETRY/SUBMIT_UNKNOWN...）；CHECK 禁反向 phase
- **迁移**：0061 additive（与 L13 同段，串行）
- **Rollback**：DROP 列
- **Tests**：`phase-monotonic.test.cjs` — 反向 phase 更新被拒
- **AcceptCmd**：`NODE_ENV=test node --test server/db/migration.test.cjs` 0061 落库

### 批次 3（Phase 2 后半 + Phase 3 前半，7 叶）— 依赖：批次 2

#### L13 — generation_events append-only 日志
- **Goal**：append-only 事件表（event_id/job_id/attempt_id/type/source/provider_event_id/payload_hash/created_at）
- **Why**：§132 用于 debug/audit/replay；Gate 19 replay 依赖
- **Reuse**：`runEventStore.cjs`（run_events(0043)+run_event_counters(0049) advisory-lock 分配 seq 模式）
- **Files**：`server/db/migrations/0061_phase_reason.sql`(同段追加，串行) 或 0061b；`server/modules/generation-v2/eventLog.cjs`(新)
- **DB**：+`generation_events`
- **迁移**：与 L12 同段（迁移链串行）
- **Rollback**：DROP 表
- **Tests**：append-only（禁 UPDATE/DELETE）、payload_hash
- **AcceptCmd**：`node --test --test-concurrency=1 server/modules/generation-v2/eventLog.test.cjs` 全绿

#### L14 — SUBMIT_UNKNOWN 恢复序
- **Goal**：实现 §54 六步恢复（查 clientRequestToken→查 payload→搜 task→等待窗口→reconcile→确认未创建才重提）
- **Why**：§52-54；审计 G6；禁 timeout 后立即重提（§152 禁止项）
- **Reuse**：`generation-v2/reconciler.cjs`（claimReconciling lease CAS）、`no-blind-resubmit.test.cjs`（已有测试先例）
- **Files**：`generation-v2/reconciler.cjs`(改)、`reconciler.test.cjs`(改)
- **DB**：读写 generation_activity_runs + generation_items_v2
- **迁移**：无
- **Rollback**：git revert
- **Tests**：submit 响应丢失 → 不建第二任务（Gate 7）
- **AcceptCmd**：`node --test --test-concurrency=1 server/modules/generation-v2/no-blind-resubmit.test.cjs` 全绿

#### L15 — Internal Idempotency 对齐
- **Goal**：`UNIQUE(tenant_id + endpoint_scope + idempotency_key)`（§55/§131）
- **Why**：§55 重复请求返回原 Job；Gate 4（1 Job 1 reserve）
- **Reuse**：`billing.cjs`（reserve/commit CAS + ref/kind 幂等）、`generation-v2/intake.cjs`
- **Files**：`billing.cjs`(改)、`generation-v2/intake.cjs`(改)、`intake.test.cjs`(改)
- **DB**：唯一索引（并入 0061 段）
- **迁移**：0061 段（串行）
- **Rollback**：DROP 索引
- **Tests**：同 key 二次请求返回原 Job + 不二次 reserve（Gate 4）
- **AcceptCmd**：`node --test --test-concurrency=1 server/modules/generation-v2/intake.test.cjs` 全绿

#### L16 — webhook_inbox 表
- **Goal**：inbox 表（provider_id/provider_event_id/event_type/payload/signature_state/status/attempts/next_attempt_at）
- **Why**：§57 webhook 只 verify→parse→dedupe→INSERT→2xx，禁止 handler 内下载/上传；审计 G7 缺失
- **Reuse**：`webhook_events`(0008:40) UNIQUE(provider_id,channel_trade_no,event_type) 幂等思路、`generation-v2/reconciler.cjs` 归约参照
- **Files**：`server/db/migrations/0062_webhook_inbox.sql`(新)、`server/modules/generation-v2/webhookInbox.cjs`(新) + `.test.cjs`(新)
- **DB**：+`webhook_inbox(id, provider_id, provider_event_id, event_type, payload JSONB, signature_state, dedupe UNIQUE(provider_id, provider_event_id), status new/processing/reduced/failed, attempts, next_attempt_at)`
- **迁移**：0062 additive
- **Rollback**：DROP 表
- **Tests**：重复事件只 reduce 一次（Gate 8）、乱序降级 reconcile_wait、验签失败不 reduce
- **AcceptCmd**：`node --test --test-concurrency=1 server/modules/generation-v2/webhookInbox.test.cjs` 全绿

#### L17 — Webhook 安全（验签/防重放/constant-time）
- **Goal**：signature/timestamp/event id/replay tolerance/constant-time comparison（§58）
- **Why**：§58 Replicate 签名含 webhook-id/timestamp/signature；防重放
- **Reuse**：`webhook_events` 支付验签模式（0008）、`api_keys`(0006) 凭证读取
- **Files**：`server/modules/generation-v2/webhookVerify.cjs`(新) + `.test.cjs`(新)
- **DB**：无
- **迁移**：无
- **Rollback**：删新文件
- **Tests**：合法签名通过、篡改/过期 timestamp 拒绝、constant-time 比较
- **AcceptCmd**：`node --test --test-concurrency=1 server/modules/generation-v2/webhookVerify.test.cjs` 全绿

#### L18 — 内部 Event Envelope（CloudEvents 风格）
- **Goal**：统一 envelope（specversion/id/source/type/subject/time/dataschema/data）（§59）
- **Why**：§59 不要求引 CloudEvents 服务，用其 envelope 语义
- **Reuse**：纯库，无现模块依赖
- **Files**：`server/modules/generation-v2/eventEnvelope.cjs`(新) + `.test.cjs`(新)
- **DB**：无
- **迁移**：无
- **Rollback**：删新文件
- **Tests**：envelope 构建/解析/校验必填字段（id/source/specversion/type）
- **AcceptCmd**：`node --test --test-concurrency=1 server/modules/generation-v2/eventEnvelope.test.cjs` 全绿

#### L19 — Event Reducer `applyProviderEvent()`
- **Goal**：Webhook 与 Poller 唯一状态入口（§60），处理 duplicate/out-of-order/terminal regression/concurrent delivery
- **Why**：§60 禁止两处直接 UPDATE generation_jobs；Gate 8/9/11
- **Reuse**：`generation-v2/provider-status-router.cjs`（queryProviderStatus 轮询 EXTEND）、`generation-v2/reconciler.cjs`
- **Files**：`generation-v2/provider-status-router.cjs`(改)、`eventReducer.test.cjs`(新)
- **DB**：写 generation_items_v2 phase/reason（0061）+ inbox 状态
- **迁移**：无
- **Rollback**：git revert
- **Tests**：duplicate 幂等、out-of-order 降级、terminal regression 拒绝（Gate 9）
- **AcceptCmd**：`node --test --test-concurrency=1 server/modules/generation-v2/eventReducer.test.cjs` 全绿

#### L20 — 状态单调推进 + provider_event_anomaly
- **Goal**：RUNNING→SUCCEEDED→RUNNING 拒绝并记 provider_event_anomaly（§62）
- **Why**：§62 单调推进；Gate 9/11
- **Reuse**：`generation-v2/reconciler.cjs`（异常记录 EXTEND）
- **Files**：`generation-v2/reconciler.cjs`(改)、`reconciler.test.cjs`(改)
- **DB**：写 provider_event_anomaly（并入 generation_events type）
- **迁移**：无
- **Rollback**：git revert
- **Tests**：反向事件被拒 + anomaly 记录
- **AcceptCmd**：`node --test --test-concurrency=1 server/modules/generation-v2/reconciler.test.cjs` 全绿

---

## 附：关键串行锚点与单写者清单（派发前必读）

- **单写者文件（跨叶串行）**：`server.js`(L11/L32/L39/L53)、`dispatcher.cjs`(L11/L55)、`billing.cjs`(L15/L30/L32)、`assetFinalize.cjs`(L27/L28)、`generation-v2/reconciler.cjs`(L14/L20)、`generation-v2/provider-status-router.cjs`(L19/L21)、`modelhub/router.cjs`(L37/L38)、`modelhub/pricing.cjs`(L31)、`modelhub/routingAudit.cjs`(L40)、`generation-v2/ledger.cjs`(L33)、`generation-v2/generation-worker.cjs`(L9/L45)、`generation-v2/lease.cjs`(L10)、`studioRunEngine.cjs`(L51/L52)
- **迁移链同段（串行）**：0061 段 = L12+L13+L15；0065 段 = L27+L29；0066 段 = L30+L31；其余迁移号单叶独占
- **冲突报警**：任何两叶若同时声称写上述同一文件，必须先合入前一叶再派发后一叶（§157 冲突先报 SPEC_CONFLICT 不硬改）
