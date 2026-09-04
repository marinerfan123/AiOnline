# MOLING_VIDEO_RUNTIME_AUDIT_V2 — Phase 0 现状盘点

> 规范：`MOLING_VIDEO_RUNTIME_ARCH_V2.md`（§139 输出清单 / §4 术语 / §46 phase / §150 叶子字段）
> 实施仓：`github_ai_online`（只读盘点，未改代码、未 git、未 ssh）
> 方法：纯 grep / 读码 / 读迁移 SQL，所有结论附证据行号；未运行任何生产行为。
> 唯一产出：本文件 `docs/product-v2/28-video-runtime-audit-v2.md`

---

## A) 代码路径盘点（4 条生成执行链）

### A1. legacy `/api/generate` 链（主力生产链，server.js + dispatcher.cjs + assetFinalize.cjs + uploadQueue.cjs）

| 环节 | 位置 | 关键证据 |
|---|---|---|
| HTTP 入口 | server.js:3712 `POST /api/generate` | 限流(3714)→鉴权(3724)→幂等键校验(3726-3727) |
| 幂等查重 | server.js:3730 | `SELECT ... WHERE idempotency_key=$1`；failed 可复用键重试(3734-3737) |
| 模型解析 | server.js:3749 | `modelHubResolver.resolveModelIdentity` |
| 定价 | server.js:3757 | `accounting.getModelPrice`（model_pricing→history→models 双读） |
| 池解析 | server.js:3774 | `billing.resolvePayment`（reward 优先→recharge 回退） |
| 预扣 | server.js:3787 | `billing.reserveCredits`（CAS `UPDATE ... WHERE col>=amount`） |
| 分发 | server.js:3828 | `dispatcher.generateAsync` |
| 影子双写 | server.js:3840 | `generationV2Shadow.writeShadowBatch`（非阻断，mode='shadow'） |
| 异步入口 | dispatcher.cjs:1048 `generateAsync` | CPU shed(1051)→INSERT generation_tasks(1065-1070)→client_request_id(1078)→fire-and-forget `generate`(1090) |
| 主调度 | dispatcher.cjs:900 `generate` | loadDispatchPairs(925)→syncKeyPool(933)→按子任务 `dispatchOne`(957) |
| 单任务路由 | dispatcher.cjs:864 `dispatchOne` | buildDispatchSequence(V3 路由,875)→attemptOnAccount(883)→success/timeout/failed 终态(888-891) |
| 账号尝试 | dispatcher.cjs:562 `attemptOnAccount` | acquireRateLimitSlots(543)→熔断 cbAdmit→imageGenerate/videoGenerate→genericVideoPoll(90min 轮询) |
| 完成结算 | dispatcher.cjs:1011 `completeViaQueue` | commitCredits(1013)→recordConsumption(1019)→`uploadQueue.enqueueFinalize`(1030) |
| 上送队列 | uploadQueue.cjs:27/46/253 | `asset_upload_jobs` 表 + `FOR UPDATE SKIP LOCKED` worker + `recoverUploadJobs` 崩溃恢复 |
| 资产最终化 | assetFinalize.cjs:253 `finalizeUrl` | fetchBytes(SSRF/dataURI/stream)→OSS PUT→insertMedia(ON CONFLICT id)→recordAssetVersion |
| 看门狗 | dispatcher.cjs:1738 `scanStuckTasks` | 90min 硬上限 / 10min 扫描(1735-1736,1764) |
| 崩溃恢复 | dispatcher.cjs:1211 `resumeRunningTasks` | 续轮询已持久化 provider_task_id 的 running 任务 |

### A2. V2 studioRunEngine（Studio DAG 执行，Postgres 权威）

| 环节 | 位置 | 证据 |
|---|---|---|
| 引擎 | server/modules/project-foundation/studioRunEngine.cjs (1153 行) | 硬规则：无内存权威、短事务、不可变 revision 绑定、多 worker `FOR UPDATE SKIP LOCKED`(1-14) |
| 表 | 0015_studio_run_engine.sql | studio_runs / studio_run_nodes / studio_run_node_edges / studio_run_events |
| Worker | server/studio-worker.cjs | 消费 studio_run_nodes lease |
| 事件中继 | runEventRelay.cjs → runEventStore.cjs | `run_events`(run_id,seq) append-only + advisory lock 原子分配 seq(43-48)；run_event_counters(0049) |
| 边界 | studioRunEngine.cjs:14 | "M05-D1 never calls real AI / Generation V2 / billing"（占位执行器，不接真 Provider） |
| 媒体执行器 | server/modules/media/executors.cjs | probe 走 ffprobe；缺二进制返 `MEDIA_*_UNAVAILABLE`（诚实占位，不假造） |

### A3. generation-v2 shadow / executors（影子 + 独立 worker daemon）

| 环节 | 位置 | 证据 |
|---|---|---|
| 影子 | generation-v2/shadow.cjs | 非阻断双写 `createBatchWithItems(mode='shadow')`(14-34)，canary 门控 |
| worker 主程 | generation-v2/entry.cjs | 独立 Pool + generation/upload/reconcile/outbox 四类 tick(6-7) |
| 表 | 0002/0003 | generation_batches_v2 / generation_items_v2 / generation_item_attempts_v2 / generation_credit_holds_v2 / generation_outbox_v2 / generation_worker_heartbeats_v2 |
| reconciler | generation-v2/reconciler.cjs | claimReconciling(lease CAS)→resolveReconcilingItem→reconcile_wait/review_required(25-61)；publishOutbox(64-95) |
| 状态路由 | generation-v2/provider-status-router.cjs | queryProviderStatus 轮询 |
| 租约 | generation-v2/lease.cjs, key-lease.cjs, lease-guard.cjs | reapExpiredLeases / 租约围栏 |

### A4. batchRunner / storyboardBatch（分镜批量生成）

| 环节 | 位置 | 证据 |
|---|---|---|
| 存储 | script/batchTaskStore.cjs | storyboard_batch_tasks(0051)，5 态 CHECK 状态机，`UNIQUE(script_id,shot_id,kind,batch_id)` |
| 执行缝 | script/batchRunner.cjs | QUEUED→RUNNING→SUCCEEDED/FAILED；claim 走 `WHERE status='QUEUED'` CAS(18-29)；缺省 executor 立即 FAILED{EXECUTOR_UNCONFIGURED}(69) |
| 计划/指纹 | script/storyboardBatchPlan.cjs / 0052 locks / 0053 source_trace / 0054 plan_fingerprint | 幂等去重指纹 |

---

## B) 现有表盘点 → §4 术语差距矩阵

| §4 术语 | 现有表（证据） | 差距 |
|---|---|---|
| Logical Model (4.1) | `models`(0001:23) + `ai_capabilities`/`ai_parameter_schemas`(0010) | 有 Logical Model，但无独立 `logical_models` 表；逻辑/物理未分离 |
| Model Revision (4.2) | `models.revision`(0001:90) + modelhub/revision.cjs + `model_price_history` | 版本列为整型 counter，无不可变 revision 实体/快照 |
| Operation (4.3) | 无独立表；`models.capabilities` JSONB + `supported_types` | **Operation Registry 缺失**（一等对象） |
| Provider (4.4) | `providers`(0001:6) | 有 |
| Binding (4.5) | `provider_model_bindings`(0001:96) UNIQUE(model_id,provider_id) | 有，但绑定不带 revision |
| Credential (4.6) | `api_keys`(0006) + `providers.api_key`(legacy 单 key) + `agent_providers` | 有（api_keys 为业务权威，0010 注释明示） |
| **Job (4.7)** | `generation_tasks`(0001:155) + `generation_jobs`(0001:173, 每子任务一 job) + `generation_batches_v2`/`generation_items_v2`(0002) + `studio_runs`(0015) + `media_jobs`(0036) + `storyboard_batch_tasks`(0051) | **Job 被拆成 6 套实体，无统一 Job 语义**；legacy `generation_jobs` job_id=`task_id__i`(dispatcher.cjs:950) |
| **Attempt (4.8)** | `generation_attempts`(0001:189, legacy) + `generation_item_attempts_v2`(0002:53) + `studio_run_nodes.attempt`(0015:54, 计数列非表) + `storyboard_batch_tasks.attempt`(0051:19, int) | Attempt 实体存在但分散；studio/storyboard 仅 int 计数器，无 attempt 行 |
| **Activity (4.9)** | **无 `generation_activity_runs` 表**；最近似：`generation_items_v2.status` 枚举伪活动(provider_accepted/reconciling/uploading)、`asset_upload_jobs`(finalize 单步)、`studio_run_nodes`(execution_kind) | **Activity 作为可独立重试步骤完全缺失**（§44 建议实体未建） |
| Artifact (4.10) | `media`(0001:42) + `asset_versions`(0032) + `media_derived_artifacts`(0050) + `project_assets`(0013) | 有（Artifact≈media + asset_versions kind=upload/generated/derived） |
| Workflow (4.11) | studioRunEngine DAG + storyboardBatch（proto-workflow）；无 workflow_revisions/workflow_runs | Workflow Revision/Run/Step 缺（§94-96） |
| **Outbox (1.7/§48)** | `outbox`(0001:248, 通用) + `generation_outbox_v2`(0002:93, lease 化) + `event_outbox`(0025, idempotency_key+retry) | **3 套 outbox 表，但 legacy 生成分发不写 outbox**——`generateAsync` 走进程内 fire-and-forget Promise 链(dispatcher.cjs:1090)，dual-write 风险仍在 |
| **Inbox (1.8/§57)** | `webhook_events`(0008:31) 仅为**支付** webhook 幂等(channel_trade_no/out_trade_no)；无 provider webhook inbox | **Provider Webhook Inbox 缺失；webhook 无→纯轮询**（genericVideoPoll / provider-status-router queryProviderStatus） |
| Ledger (账务) | `credit_transactions`(0001:228, ref/kind 唯一) + `consumption_ledger` + `generation_credit_holds_v2`(0002:71) + `project_budgets`/`project_budget_spends`(0031/0044) + `model_pricing`/`model_price_history`/`model_cost_rates`/`provider_model_costs` | 有，但**三套账**（用户双池 / V2 hold / 项目预算）并立 |

> 差距核心：**Job≈generation_tasks(generation_jobs) 近似成立；Attempt 分散（legacy 表 + V2 表 + 计数列）；Activity 完全缺；Outbox 有表未接线；Inbox 完全缺；webhook 无→poll**。

---

## C) 能力点逐项实测

### C1. 幂等（多套，均已测/有唯一约束）

| 键 | 约束 | 证据 |
|---|---|---|
| `generation_tasks.idempotency_key` | partial unique `ux_gt_idem` | 0001:266；路由层查重 server.js:3730 |
| `generation_batches_v2 (user_id, idempotency_key)` | full unique（0040 修复 partial→full） | 0040_g20 |
| `generation_items_v2 (provider_id, provider_request_id)` | unique | 0002:50 |
| `generation_item_attempts_v2 (client_request_id)` | unique | 0002:68 |
| `credit_transactions (ref, kind)` | unique → reserve/commit/release 幂等 | 0001 隐含 + billing.cjs:72/87/107 |
| `generation_credit_holds_v2 (ref, kind)` / `(hold_id)` | unique | 0002:83 / 0003:163 |
| `media_jobs (asset_id, kind)` active + `idempotency_key` | partial unique | 0036:29-35 |
| `studio_runs (canvas_id, idempotency_key)` | unique | 0015:30 |
| `storyboard_batch_tasks (script_id, shot_id, kind, batch_id)` | unique（含批） | 0051:29-30 |
| `asset_versions.version_id` | **确定性派生** `av-{mediaId}-{taskId}`（防重放） | assetFinalize.cjs:410 + 测试 asset-finalize-version-id.test.cjs |
| `webhook_events (provider_id, channel_trade_no, event_type)` | unique（支付） | 0008:40 |
| `project_budget_spends.idempotency_key` | unique | 0044 |

### C2. Reconciler / 看门狗

| 机制 | 阈值 | 证据 |
|---|---|---|
| dispatcher `scanStuckTasks` 看门狗 | **硬编码 90min**，每 10min | dispatcher.cjs:1735-1736,1764 |
| `billing.findDanglingReserves` | 30min（running 无 commit） | billing.cjs:119-130 |
| generation-v2 `reconciler` | lease CAS + reconcile_wait/review_required | reconciler.cjs:25-61 |
| `productReconciler` | orphan job 健康报告 + repair plan | productReconciler.cjs:9-29 |
| `resumeRunningTasks` / `resumeWaitingArea` | 崩溃恢复续轮询 | dispatcher.cjs:1211/1377 |

> 差距：orphan 阈值**不按 phase/provider/service_class/operation 配置**（§134 禁止单一 10min；现状是 90min/30min 硬编码且分散 3 处）。

### C3. Billing（reserve/commit/release 三阶段 + W1C）

| 能力 | 现状 | 证据 |
|---|---|---|
| reserve/commit/release | ✅ 完整，CAS + (ref,kind) 幂等 + balance_after(W1C) | billing.cjs:61/82/99 |
| 双池 reward→recharge | ✅ | billing.cjs:40-56 |
| 版本化定价 | ✅ `model_pricing` + `model_price_history` | 0010 域 + accounting.getModelPrice |
| **estimated/actual/user_charge 三段分离**（§84） | ❌ 无——flat unit price，无 estimated_provider_cost / actual_provider_cost / user_charge | server.js:3764 仅 creditCost/rewardRequired |
| **Pricing Rule 计算器**（§87） | ❌ 无结构化 calculator；禁止任意 JS 已隐式满足（无 eval） | — |
| **max_cost_authorized**（§88） | ❌ 无重估再确认闸 | server.js 预扣后不再重估 |
| settle 幂等键 | ⚠️ (ref,kind) 有，但非 §90 建议的 `settle:{attempt_id}` 粒度（legacy 按 idempotency_key） | billing.cjs:82 |

### C4. assetFinalize（资产最终化）

| 能力 | 现状 | 证据 |
|---|---|---|
| 流式收集 | ✅ content-length→流式；chunked→buffer 兜底；data URI | assetFinalize.cjs:104-113,74-87 |
| local-disk 写 | ✅ | assetFinalize.cjs:170-183 + localMediaStore.cjs |
| express/签名读 | ✅ OSS GET 7d 重签 + 视频边缘抽帧 | assetFinalize.cjs:219-222,296-302 |
| 幂等 | ✅ media ON CONFLICT(id) + 确定性 version_id | assetFinalize.cjs:338,410 |
| 兜底 | ✅ pending_upload 占位 + reaper 续传（provider_url 已持久化） | assetFinalize.cjs:280,367 |
| 限界 | 50MB / 30s / SSRF 拒内网 | assetFinalize.cjs:23-24,90 |
| **Provider Success ≠ Job Success**（§79） | ⚠️ 部分：media status success/pending_upload 分开，但 generation_tasks 在 completeViaQueue 先 commit 后 finalize，finalize 失败任务仍算 done | dispatcher.cjs:1013 vs 1030 |

### C5. Router（多层，但未按 §29 严格两层切分）

| 层 | 位置 | 能力 |
|---|---|---|
| legacy dispatcher 路由 | dispatcher.cjs:836 buildDispatchSequence + ROUTING_V3_ENABLED kill-switch(774) | 权重 + 重排，可回退 |
| modelhub V3 智能路由 | modelhub/router.cjs | **7 道门**(58-70) + 评分(scoreCandidate) + 种子化加权选择(weightedSelect) + 熔断(CLOSED/OPEN/HALF_OPEN) |
| 解析 | modelhub/resolver.cjs / bindings.cjs(loadDispatchPairs) / fallbackPolicy.cjs | 模型身份 + 绑定加载 + 回退策略 |
| 路由审计 | modelhub/routingAudit.cjs → `ai_routing_decisions`(0010) + `routing_audit`(0033) | **两套审计表**（重复） |
| V2 状态路由 | generation-v2/provider-status-router.cjs | 轮询 provider 状态 |

> 差距：Auto Model Router 与 Provider Binding Router **未分离**（都揉在 dispatcher+modelhub）；无 Quota Scope(§24)、无 Provider Certification(§19)、无 Resolve/dry-run API(§36)。

### C6. 状态机（status 词表 vs §46 phase 单调）

| 表 | status 词表 | 约束 | 证据 |
|---|---|---|---|
| `generation_tasks`（legacy） | running / waiting / canceled / failed / done / review_required | **无 CHECK，无 phase，无 reason**；字符串态 | dispatcher.cjs:1097-1149 + server.js:3741 |
| `generation_items_v2` | queued/leased/generating/provider_accepted/reconciling/reconcile_wait/generated/uploading/retry_wait/review_required/done/failed/canceled (13 态) | ✅ CHECK | 0003:93-96 |
| `studio_runs` | QUEUED/RUNNING/WAITING/COMPLETED/FAILED/CANCELLED/BLOCKED (7) | ✅ CHECK | 0015:14-15 |
| `studio_run_nodes` | BLOCKED/READY/LEASED/RUNNING/WAITING/SUCCEEDED/FAILED/CANCELLED/SKIPPED (9) | ✅ CHECK | 0015:50-51 |
| `storyboard_batch_tasks` | QUEUED/RUNNING/SUCCEEDED/FAILED/SKIPPED (5) | ✅ CHECK | 0051:27-28 |
| `media_jobs` | queued/running/done/failed/cancelled (5) | ✅ CHECK | 0036:13-14 |

> 差距：§45「External Status 与 Internal Phase 分离」未实现——V2 的 13 态把 `provider_accepted/reconciling/uploading`（内部）与 `done/failed`（外部）混在同一 status 列；无独立 `phase`+`reason` 列。§46 单调推进仅靠 CHECK 兜底（禁反向状态），无显式 phase 单调状态机。§47 reason 词表部分存在于 `last_error_code`(PROVIDER_FAILED/PROVIDER_PENDING/RECONCILE_UNKNOWN 等)，非系统化。

---

## D) 重复实现风险点名（TOP 8）

| # | 重复域 | 并行实现 | 风险 |
|---|---|---|---|
| 1 | **生成执行引擎** | legacy dispatcher / generation-v2 worker-daemon / studioRunEngine / media jobs / storyboard batchRunner **5 套**，各自 lease/status/retry/queue 表 | Job/Attempt/Activity 语义重复 5 次，迁移期多头写 |
| 2 | **Outbox** | `outbox`(0001) / `generation_outbox_v2`(0002) / `event_outbox`(0025) **3 张表**，legacy 分发均未接线 | dual-write 不一致（§48 P0）未被解决 |
| 3 | **Reconciler** | dispatcher.scanStuckTasks(90min) / billing.findDanglingReserves(30min) / generation-v2 reconciler / productReconciler | 阈值口径不一，重复扫描 |
| 4 | **资产最终化** | assetFinalize.cjs(media 表) / media localMediaStore+mediaJobs / generation-v2 upload-worker+upload-finalize | 同一 finalize 职责三处 |
| 5 | **账务/计费** | billing.cjs(credit_transactions 双池) / generation_credit_holds_v2 / project_budgets+spends | 三套 ledger，对账复杂 |
| 6 | **路由** | dispatcher legacy 路由 / modelhub V3 router / provider-status-router；审计表 `ai_routing_decisions` + `routing_audit` 两套 | 路由权威未定，kill-switch 并存 |
| 7 | **模型注册/绑定** | `models`+`provider_model_bindings`(legacy) / modelhub resolver+bindings+revision / ai-control contracts+adapters+repositories | 多套 binding 概念 |
| 8 | **事件/SSE** | realtime.cjs(SSE) / studio_run_events / run_events / generation_outbox_v2 | 4 条事件通道 |

---

## E) Gap → Phase 映射（§140-§149，Phase 0-10）

| Phase | 规范目标 | 现有% | 缺项（关键） | 首个叶子建议 |
|---|---|---|---|---|
| 0 Audit | §139 盘点 | 100 | — | 本文件（已产出） |
| 1 Registry | Operation / Revisioned Schema / UI Schema / Semantic Map | ~40 | Operation Registry、不可变 revision 实体、UI Schema、Semantic Map | 建 `logical_models`/`model_revisions`/`model_operations` 表 + Operation Registry |
| 2 Durable Job Core | Job/Attempt/Activity + Outbox + Worker Lease + Idempotency + SUBMIT_UNKNOWN | ~55 | Activity 实体、outbox 接入 legacy 分发、SUBMIT_UNKNOWN 完整恢复序 | 建 `generation_activity_runs` + Activity 执行循环 |
| 3 Provider Event Runtime | Webhook Inbox / Poll Policy / Event Reducer / Monotonic State / Reconciler | ~35 | **Webhook Inbox 缺失**、Event Reducer 缺失、phase 单调、reason 词表 | 建 `webhook_inbox` 表 + inbox 分发器 |
| 4 Pilot | 3 Provider 差异验证 | ~30 | 直连/聚合/多 Operation 各一认证 | 按现有 credential 认证 3 Provider（volcano/minimax/agnes） |
| 5 Asset+Billing Hardening | Provider Success→Finalize→Settle 完整 | ~60 | estimated/actual/user_charge 三段、Pricing Calculator、max_cost_authorized | 定价计算器 + settle 幂等键 |
| 6 Router | Quota Scope / Certification / Binding Router / Resolve / Auto Router | ~50 | Quota Scope、Provider Certification、Router 两层严格分离、Resolve/dry-run | 建 `quota_scope` 表 + Resolve API |
| 7 UI | Schema Form / Custom Renderer / Projection / Parked | ~40 | Schema→UI 生成、Projection Report | schema→UI form 生成器 |
| 8 Canvas | Video Node / Lineage / Generation Group / Continuous Shot | ~45 | Generation Group、完整 Lineage | generation_group + lineage 链接 |
| 9 Workflow | Workflow Revision / Run / Step | ~30 | workflow_revisions/runs/steps 表 | 建 `workflow_revisions` |
| 10 Legacy Retirement | 生产流量=0 后删旧路径 | 0 | 流量切换 + 稳定窗口 | traffic switch + 观测窗口 |

---

## F) §150 叶子字段模板（示例 1 条）

**Leaf: Phase 3 首个叶子 — 建立 Provider Webhook Inbox**

```
Goal          : 建 webhook_inbox 表 + 认证校验 + 幂等去重，接收 provider 异步回执
Why           : §57 要求 webhook 不能直接 UPDATE job；§1.8 webhook 至少一次；现状纯轮询，
                无法承载 provider 即时终态/乱序/重复事件，reconciler 只能事后兜底
Existing      : webhook_events(0008, 支付幂等模式可复用其 UNIQUE(provider_id,key,event_type) 思路)、
modules reused    modelhub/bindings.cjs(绑定/凭证读取)、generation-v2/reconciler.cjs(事件→状态归约可参照)、
                api_keys(凭证)
Files touched : server/db/migrations/0058_webhook_inbox.sql（新）、server/modules/generation-v2/webhookInbox.cjs（新）、
                server/modules/generation-v2/entry.cjs（挂载 inbox consumer）
DB changes    : +webhook_inbox(id, provider_id, provider_event_id, event_type, payload, signature_state,
                dedupe UNIQUE(provider_id, provider_event_id), status new/processing/reduced/failed, attempts, next_attempt_at)
Migration     : forward-only additive（IF NOT EXISTS），不触 legacy 0001-0057
Rollback      : DROP TABLE webhook_inbox（未接线前无依赖）
Tests         : 重复事件只 reduce 一次；乱序事件降级为 reconcile_wait；验签失败转 failed 不 reduce；
                旧事件(终态后)幂等忽略
Acceptance    : node --test server/modules/generation-v2/webhookInbox.test.cjs 全绿；
command         手动 curl 带签名打一次 inbox，观察 generation_items_v2 状态归约正确
Observed      : （Phase 3 实施后回填真实输出，本条为模板示例）
result
```

---

## 附：关键证据索引（快速定位）

| 主题 | 文件:行 |
|---|---|
| legacy 入口 | server/server.js:3712 |
| dispatcher 主链 | server/dispatcher.cjs:900/864/562/1011/1048 |
| 看门狗 90min | server/dispatcher.cjs:1735-1764 |
| assetFinalize 流式 | server/assetFinalize.cjs:104-113,253 |
| billing 三阶段 | server/billing.cjs:61/82/99 |
| V3 路由 7 门 | server/modules/modelhub/router.cjs:58-70 |
| V2 schema 13 态 | server/db/migrations/0003:93-96 |
| studio DAG 表 | server/db/migrations/0015 |
| storyboard 5 态 | server/db/migrations/0051 |
| 幂等索引对齐 | server/db/migrations/0040 |
| 支付 webhook（非 provider） | server/db/migrations/0008:31 |

> 声明：本盘点全部结论来自读码/读 SQL 证据行号，未对任何未实测量能力（如 Activity 表、webhook inbox）声称存在；所有「缺失/无」均经 grep 全仓确认无对应建表或实现。
