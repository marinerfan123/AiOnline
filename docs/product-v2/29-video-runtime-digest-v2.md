# 29 · 墨渊视频运行时架构规范 V2.0 精读消化（§5–§138）

> 源: `governance/blueprint-v2.0/references/moyuan-video-runtime-v2/MOLING_VIDEO_RUNTIME_ARCH_V2.md`（5091 行）
> 范围: §5–§138（§0–4 术语/结论与 §139–151 迁移/验收已另叶覆盖）
> 性质: **纯阅读消化，无实测**。本叶不声明已验证任何现系统代码行为，现系统对照词基于规范 §3 自查清单 + 已知 legacy `generation_tasks`/dispatcher 单表状态机口径。

---

## 0. 阅读前提（§3 自查清单 + §4 术语基线）

规范第一原则：**AUDIT EXISTING SYSTEM → EXTEND，禁止 DUPLICATE**。墨渊已存在：`ModelHub` / `provider_model_bindings` / `Generation V2` / `generation_jobs` / `generation_attempts` / `reconciler` / `assetFinalize` / `uploadQueue` / `ledger` / `monitor` / `SSE`。

| 术语(§4) | 定义一句话 | 现系统对照词 |
|---|---|---|
| Logical Model | 用户看到的模型（`video.seedance-2.5`），不知道 API Key/Endpoint | ModelHub 现有 model 行 |
| Model Revision | Logical Model 的不可变版本描述，生产使用后 IMMUTABLE | 无独立表（现有 model 版本字段/别名） |
| Operation | 原子生成能力（`video.image_to_video`…） | 无（现有 task type / kind 混写） |
| Provider | 真正执行模型的服务 | 现有 provider 实体 |
| Binding | Revision+Operation+Provider 的执行映射 | `provider_model_bindings` |
| Credential | API Key/OAuth/Service Account | 现有 credential |
| Job | 一次用户意图，≠HTTP 请求 | `generation_jobs`（V2）/ legacy `generation_tasks` |
| Attempt | Job 的一次 Provider 执行尝试 | `generation_attempts` |
| Activity | Attempt 内可独立失败/重试的副作用步骤 | 无（现有状态机内混在一起） |
| Artifact | 一次生成输出的一个物理产物 | 现有 output/asset |
| Workflow | 多个 Atomic Operation 的复合流程 | 无（现有 production graph 部分重叠） |

---

## 1. §5 架构分层 + §6 Source of Truth

| 节 | 决策点 | 数据/结构要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §5 | 分层必须为 `Studio/Canvas/Workflow → ModelHub → Generation Resolve → Universal Generation Envelope → Generation V2 → Job Runtime(Job/Attempt/Activities) → Provider Driver → Provider API → Webhook/Poll → Event Reducer → PROVIDER_SUCCEEDED → Asset Finalize → Media Store(Ledger/Lineage/Canvas)` | 每层边界固定，Generation Resolve 内顺序 validate→capability admission→data policy→cost estimate→model routing→binding routing | 代码/DB 中每一状态只属一层权威 | 现系统有 ModelHub/Generation V2/Job Runtime/reconciler/assetFinalize/uploadQueue/ledger/SSE，缺 Event Reducer 层与独立 Resolve 层 |
| §6 | **Source of Truth 写死，禁止两个模块同时自认权威** | 12 项映射：用户意图=`generation_jobs`；一次 Provider 调用=`generation_attempts`；Provider task ID=attempt；Job 当前状态=generation_jobs；状态历史=append-only events；模型能力=model_operation_revision；Provider 参数=binding/compiler revision；Provider 原始状态=provider events；永久媒体=media/assets；成本=ledger；路由历史=routing snapshot；工作流定义=workflow_revision；运行配置=job execution snapshot | 任一状态字段只能由唯一 owner 写 | 现有单表 `generation_tasks` 同时承载意图/执行/Provider状态=权威重叠（核心冲突点） |

---

## 2. §7 Registry 数据模型（DDL 要点）

| 实体 | 关键列 | 状态枚举 / 关键约束 |
|---|---|---|
| `logical_models` | id, code, media_type, display_name, vendor_family, status, created_at | status ∈ ACTIVE/DEPRECATED/DISABLED/RETIRED |
| `model_revisions` | id, logical_model_id, revision_code, upstream_vendor, upstream_model_family, released_at, status, metadata, created_at | 不可变；生产使用后禁 UPDATE |
| `model_operations` | id, code, media_type, **kind=ATOMIC**, display_name, status | 明确 kind=ATOMIC |
| `model_operation_revisions` | id, model_revision_id, operation_id, revision, input_schema, output_schema, ui_schema, semantic_map, capability_descriptor, **schema_hash**, status, created_at, activated_at | status ∈ DRAFT/VALIDATING/CANARY/ACTIVE/DEPRECATED/RETIRED；**一旦 ACTIVE 且被执行→禁 UPDATE schema 内容，改动=新建 revision** |

决策点：Operation 是一等对象（Vidu 证明）；Revision 不可变。数据要求：`schema_hash` 必须落库。验证：ACTIVE 后 schema 内容不可变、改版走新 revision。现系统对照：ModelHub 无 revision 表/无 operation 独立表/无 schema_hash。

---

## 3. §8–§12 Schema 体系（+§13 Custom Renderer）

| 节 | 决策点 | 数据/结构要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §8 | 用 **JSON Schema Draft 2020-12** | 允许 oneOf / if-then-else / dependentSchemas / unevaluatedProperties | 校验器需支持 2020-12 关键字 | 现有校验方式未统一 |
| §9 | 复杂组合 Schema **优先 unevaluatedProperties:false**（替代 additionalProperties） | allOf/oneOf/$ref/conditional 下用 unevaluatedProperties 避免误判合法字段 | 组合 Schema 用例不误拒合法字段 | — |
| §10 | **Schema 不负责所有事情**，拆 input_schema/ui_schema/semantic_map/capability_descriptor，禁止塞进 `x-moling-*` | 四份独立文件/字段 | 无 x-moling 泛滥 | 现有 input 定义疑似单 blob |
| §11 | Input Schema 负责类型/required/enum/min-max/数组长度/交叉字段约束/格式，是**服务器验证最终权威** | 完整 JSON Schema | 服务端强制校验 | — |
| §12 | UI Schema 负责显示顺序/分组/控件/提示/**Basic/Advanced**；示例 renderer 引用 `video.asset.first-frame` | ui_schema | UI 由 ui_schema 驱动 | 现有 UI 硬编码模型分支 |
| §13 | Custom Renderer Registry：**禁止 `if(model==="kling")`**，允许 `renderer_id=video.motion-control` | renderer registry（First/Last Frame、Motion Control、Camera…） | 新增模型不加代码分支 | 现有 `if model===...` 分支（冲突点） |

---

## 4. §14–§16 Semantic Map / Projection / Parked

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §14 | Semantic Layer **不是模型请求格式**，只负责跨模型迁移/UI 兼容/Auto Router capability reasoning；示例 `duration→{semantic:video.duration, transfer:nearest}` | semantic_map（semantic 标识 + transfer 策略：nearest/asset…） | 迁移不泄漏 Provider 格式 | 无语义层 |
| §15 | 参数切换**必须产生 Projection Report**：`{exact, converted, adjusted, parked, dropped, warnings}`，示例 prompt=EXACT、9:16=EXACT、10s→8s=ADJUSTED、camera_fixed=PARKED | 六类投影结果结构化返回 | 切换不静默丢参数 | 现有切换直接替换 input（冲突点） |
| §16 | Parked：不兼容参数**不删除、不发送**，存 `semantic_parked_state`，切回原模型恢复 | semantic_parked_state | 切回可恢复 | 无 parked 概念 |

---

## 5. §17–§21 Provider Binding / 版本冻结 / Certification / Fallback / capability_signature

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §17 | Binding 至少 16 字段：id, model_revision_id, operation_revision_id, provider_id, provider_model_ref, provider_operation_ref, **provider_api_version**, driver_revision, compiler_revision, service_class, certification_status, fidelity_class, capability_signature, pricing_revision_id, enabled, priority | 全字段落库 | binding 关联到 revision 级 | `provider_model_bindings` 缺 revision/api_version/compiler/certification 字段 |
| §18 | **Provider API 版本必须冻结**；`provider_model_ref` 不够，Job Snapshot 必须存 provider_api_version+driver_revision+compiler_revision | 三者进 Job Snapshot | 历史 Job 可复现调用版本 | 现有无 api_version 冻结（冲突点） |
| §19 | 不能因同名模型即视为等价；fidelity_class ∈ EXACT/COMPATIBLE/SIMILAR/UNKNOWN；certification ∈ UNVERIFIED/VERIFIED/DRIFTED/QUARANTINED | fidelity_class + certification_status | 同名不同渠道区分 | 无 certification 概念 |
| §20 | **透明 Fallback 默认只允许 VERIFIED+EXACT**；COMPATIBLE 仅在全部 capability 经 contract verification 后允许 | — | fallback 不越级到 UNVERIFIED/SIMILAR | 现有 fallback 无 fidelity 门槛 |
| §21 | capability_signature = 规范化 JSON 后 SHA-256，含 operation/required+supported semantics/duration ranges/resolution/ratio/asset limits/provider api version/compiler revision；**Provider 更新→signature 变→触发重新 Certification** | signature 落库 | signature 变化触发 re-certification | 无 capability_signature |

---

## 6. §22–§23 Driver Contract / compile() 边界

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §22 | 所有 Provider 统一实现 14 方法：capabilities/validateProviderConstraints/prepareAssets/compile/estimateCost/submit/getStatus/getResult/cancel/verifyWebhook/normalizeStatus/normalizeError/normalizeResult；不支持返回 **UNSUPPORTED**（禁止 return null 让调用方猜） | Driver interface | 每个 driver 全方法可调 | 现有 driver 接口不统一 |
| §23 | **compile() 是 Provider 差异主要边界**；业务输入(Model Operation Input)→Compiler→Provider request；Provider 参数**不得泄漏到 Canvas/Studio/Billing/Router** | Compiler 隔离层 | 上层无 Provider 字段 | 现有 provider 参数可能散落上层 |

---

## 7. §24–§28 Quota Scope / Token Bucket / Managed Queue / Service Class

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §24 | Quota Scope 正式替换旧 `provider_resource_pool`；实体 `provider_quota_scopes`（provider_id, credential_id?/binding_id?/logical_model_id?, scope_type, region?, limit_type, limit_value, **burst_value?**, window_seconds?, queue_behavior, enabled）；scope_type ∈ ACCOUNT/REGION/CREDENTIAL/MODEL/MODEL_FAMILY/MODALITY/OPERATION/ENDPOINT/CUSTOM_GROUP；limit_type ∈ CONCURRENCY/OUTSTANDING/RPM/RPS/DAILY_REQUESTS/MONTHLY_REQUESTS/DAILY_COST/MONTHLY_COST/TOKEN_BUCKET | 多维度 scope + burst/window 字段 | scope 维度可叠加 | 现有 provider_resource_pool 单并发池（冲突点） |
| §25 | 一条 Binding 命中多 Scope（例：Account 1000/day + Credential 100rpm + Veo3.1 5 concurrent），提交须**同时满足 ALL MATCHED SCOPES** | 多 scope 匹配结果 | 所有命中 scope 全通过才放行 | 现有单 pool 判定 |
| §26 | Token Bucket 须区分 **burst(桶容量) 与 sustained(refill rate)**，不只存 `rpm=60` | burst_value + refill | bucket 语义正确 | 现有仅 rpm 单值 |
| §27 | queue_mode ∈ **PROVIDER_MANAGED / LOCAL_MANAGED / HYBRID**；Runway 允许超并发进 THROTTLED/队列，不能所有 Provider 都在墨渊侧全挡 | queue_mode 字段 | 按 Provider 队列语义处理 | 现有统一本地挡并发 |
| §28 | Service Class 统一 interactive/standard/economy/background；映射 Provider 的 normal/off_peak/priority/low_priority；**cheap≠Price Router，须同看 expected latency + service class** | service_class 映射 | 路由含 latency 维度 | 现有无 service class |

---

## 8. §29–§38 Router（双层/Admission 序/Score/策略版本/可解释/Resolve/Data Policy）

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §29 | 严格双层：`Auto Model Router ↓ Provider Binding Router` | 两层分离 | 不越层 | 现有 Router 单层/未分层 |
| §30 | 手动模式：选 Veo 3.1 允许 Veo Provider A→B，**禁止 Veo→Seedance** | 手动锁定 model 级 | 不跨 model fallback | — |
| §31 | Auto Video 模式：仅用户选 `Auto Video` 才允许跨模型(Veo/Seedance/Kling/Vidu/Wan…) | auto 语义开关 | 非 auto 不跨模型 | — |
| §32 | **Admission 固定顺序 13 步**：1 Operation compat 2 Schema compat 3 Required semantic 4 Model lifecycle 5 Data/privacy 6 Region 7 Provider certification 8 Quota 9 Credential 10 Service class 11 Cost ceiling 12 Provider health 13 Score；**禁止先算 score 再发现不支持** | 顺序固化 | score 最后才算 | 现有可能 score 前置 |
| §33 | Router Score P0 稳定可解释，公式示例 `Σ weight×normalized(quality/latency/cost/reliability)`；**不要一开始上 ML Router** | 权重化线性打分 | 可解释 | — |
| §34 | Routing Policy 版本化：`routing_policies` + `routing_policy_revisions`；Job 保存 `routing_policy_revision_id` | 策略 revision 表 | Job 引用 revision | 无策略版本 |
| §35 | 决策可解释，保存 `{eligible, rejected, scores, selected_model, selected_binding, policy_revision, estimated_cost}` | 决策快照 | 每次路由可回溯 | 无决策快照 |
| §36 | 正式 Resolve API `POST /api/generation/resolve`（Dry Run），返回兼容/最终 model/operation/预计 Provider/参数调整/预计成本/服务等级/拒绝原因 | resolve 端点 | dry-run 体验 | 无 dry-run resolve |
| §37 | **Resolve 不具有提交权威性**；`POST /generate` 必须再次 validate+resolve+cost check+quota check，不信客户端回传 binding_id/price | 提交重校验 | 提交不信任 resolve 结果 | — |
| §38 | Data Policy 进入 Router：binding 存 data_retention_class/training_usage_policy/region/data_residency/requires_public_url/provider_storage_policy；Job 可要求 zdr_required/allowed_regions/direct_provider_only/no_training_provider | data policy 字段 | 路由按 data policy 过滤 | 无 data policy 路由 |

---

## 9. §39–§47 Durable Runtime（Job/Attempt/Activity/phase/reason）

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §39 | Durable Runtime 核心 Job/Attempt/Activity（V2.0 最大补充） | 三层分离 | 三层各自状态 | 现有单表状态机 |
| §40 | Job=用户逻辑结果（shot-005 image_to_video），生命周期 **0..N attempts** | generation_jobs | Job 可多 attempt | generation_tasks/generation_jobs |
| §41 | Attempt=一次真实 Provider execution；**一旦得 provider_task_id 必须长期保存** | generation_attempts + provider_task_id | task_id 持久化 | generation_attempts |
| §42 | Activity 类型：PREPARE_ASSETS/ACQUIRE_QUOTA/SUBMIT_PROVIDER/OBSERVE_PROVIDER/FETCH_OUTPUT/VERIFY_OUTPUT/FINALIZE_ASSETS/SETTLE_BILLING；**每个 Activity 独立 retry/timeout/idempotency** | activity 实体 | 单 activity 重试 | 无 activity 层 |
| §43 | **禁止「Job Retry=从第一步重跑」**；Provider 已成功+OSS 失败→只重试 FINALIZE_ASSETS，禁止重新 SUBMIT_PROVIDER | — | 局部重试 | 现有可能整体重跑（冲突点） |
| §44 | `generation_activity_runs`：id, job_id, attempt_id, activity_type, activity_revision, status, attempt_count, started_at, heartbeat_at, next_retry_at, completed_at, error_code；若 Generation V2 已有类似结构直接扩展 | activity run 表 | 心跳/重试时间落库 | 无（可扩展现有） |
| §45 | **External Status 与 Internal Phase 分离**；用户只看 QUEUED/RUNNING/SUCCEEDED/FAILED/CANCELED | 双字段 | 对外稳定枚举 | 现有单 status 字段 |
| §46 | phase ∈ VALIDATING/RESERVING/WAITING_CAPACITY/PREPARING_ASSETS/SUBMITTING/PROVIDER_QUEUE/PROVIDER_RUNNING/FETCHING_OUTPUT/FINALIZING/SETTLING/RECONCILING/CANCELING | phase 字段 | 内部细粒度 | 现有无 phase |
| §47 | reason ∈ PROVIDER_THROTTLED/RATE_LIMIT/WAITING_RETRY/ASSET_DOWNLOAD_RETRY/SUBMIT_UNKNOWN…；**禁止再造 RUNNING_RATE_LIMIT_RETRY 这种状态爆炸** | reason 字段 | 状态不爆炸 | 现有 `RUNNING_*_RETRY` 状态爆炸（冲突点） |

---

## 10. §48–§56 Outbox / PG 权威 / at-least-once / Lease / SUBMIT_UNKNOWN / 双幂等

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §48 | Transactional Outbox：`BEGIN→INSERT generation_job→INSERT billing_reservation→INSERT dispatch_outbox→COMMIT`，再独立 Outbox Dispatcher 投递队列 | dispatch_outbox | DB 写+队列投递同事务 | 现有已有 Transactional Outbox（PRODUCT_CONSTITUTION §19） |
| §49 | **Postgres 是 Durable Authority**；Redis 只做 queue acceleration/rate cache/pub-sub/SSE；Job existence/state/billing state/outbox/inbox 必须 PG 权威；Redis 丢失不能导致 Job 永远消失 | PG 权威存储 | Redis 丢数据不丢 Job | 现有 PG+Redis 分工待核 |
| §50 | 队列默认 **at-least-once**，Worker 必须 idempotent consumer（SQS 即便 visibility timeout 内也可能重复投递） | 幂等消费 | 重复投递不重复副作用 | — |
| §51 | Worker Lease：lease_owner/lease_expires_at/heartbeat_at；crash 后 lease 到期另一 Worker 接手 | lease 字段 | 到期可接管 | 无 lease |
| §52 | **Provider submit 特殊规则**：普通 activity lease 过期→retry，但 Provider Submit 不能无条件重试（HTTP 已到 Provider→任务已建→响应丢失） | — | submit 不盲目重试 | — |
| §53 | 响应丢失→进入 **SUBMIT_UNKNOWN**，禁止立即换 Provider | SUBMIT_UNKNOWN 状态 | 不立即 fallback | 无 SUBMIT_UNKNOWN 概念（冲突点） |
| §54 | SUBMIT_UNKNOWN 恢复顺序 6 步：1 查 client request token 支持 2 查 request/tag/payload 3 搜 provider task 4 等待可判定窗口 5 reconcile 6 **仅确认未创建才允许再次 submit**（AWS Bedrock `clientRequestToken` 佐证） | 恢复状态机 | 不重复建 task | — |
| §55 | Internal Idempotency：每次提交用 `idempotency_key`，DB 唯一范围 `tenant_id + endpoint_scope + idempotency_key`，重复返回原 Job | 唯一约束 | 重复请求返回原 Job | 现有有 idempotency_key（PRODUCT_CONSTITUTION） |
| §56 | Provider Idempotency：透传 clientRequestToken/idempotency-key/request_id/payload passthrough（Vidu `payload` 可带业务标识） | 透传字段 | 尽量透传 | — |

---

## 11. §57–§67 Webhook Inbox / 安全 / Envelope / Event Reducer / 单调 / Poll / 取消语义

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §57 | Webhook Inbox：handler 只做 verify→parse envelope→dedupe→INSERT inbox→2xx；**禁止 webhook 里下载 500MB 视频再回 200** | webhook inbox 表 | 快速返回异步处理 | 现有 webhook 处理路径待核 |
| §58 | 安全：signature/timestamp/event id/replay tolerance/**constant-time comparison**（Replicate: webhook-id/-timestamp/-signature） | 签名字段 | 防重放+恒时比较 | — |
| §59 | 内部 Event Envelope 采用 **CloudEvents 风格**（specversion/id/source/type/subject/time/dataschema/data），核心字段 id/source/specversion/type；不要求引入 CloudEvents 服务 | 统一 envelope | 事件可序列化 | 无统一 envelope |
| §60 | **Event Reducer 是唯一 Provider 状态入口**：Webhook 与 Poller 都必须进 `applyProviderEvent()`，禁止两处直接 UPDATE generation_jobs | applyProviderEvent 单入口 | 无旁路 UPDATE | 现有可能多处直改状态（冲突点） |
| §61 | Reducer 须处理 duplicate/out-of-order/terminal regression/concurrent delivery/same task different representations | 异常分支 | 全覆盖 | — |
| §62 | **状态单调推进**：RUNNING→SUCCEEDED→RUNNING 最后 RUNNING 拒绝，记 `provider_event_anomaly` | anomaly 记录 | 回退拒绝 | 无单调保护 |
| §63 | Poll Policy Provider-specific：initial/min/max interval, backoff, jitter, max_poll_duration；反对固定 setInterval | poll 配置 | 每 binding 独立 | — |
| §64 | **Poll ≠ Job Deadline**，至少 4 种时间：client_wait_timeout / queue_deadline / provider_execution_deadline / job_business_deadline；禁止只用一个 `timeout` | 四时间字段 | 分时语义 | 现有单 timeout（冲突点） |
| §65 | **等待超时≠取消**（Runway SDK wait timeout 不取消 Provider Task）；区分 `STOP_WAITING` 与 `CANCEL_GENERATION` | 两动作 | 超时不误取消 | — |
| §66 | Cancellation 语义 NONE/REQUESTED/PROVIDER_REQUEST_SENT/PROVIDER_CONFIRMED/UNSUPPORTED/TOO_LATE | 状态机 | 取消可追踪 | — |
| §67 | Provider 不支持 cancel：用户可 `DETACHED_FROM_USER` 停止等待，后台仍 Poll/Reconcile 到真实终态（Provider 可能已产生成本） | detached 状态 | 后台继续收敛 | — |

---

## 12. §68–§70 Retry Matrix / Attempt Fallback / Error Taxonomy

| 场景 | 决策（§68） |
|---|---|
| PRE_SUBMIT 网络失败 | retry same attempt |
| SUBMIT_UNKNOWN | **NO AUTOMATIC RESUBMIT** |
| Provider 429/rate limit（task not created） | retry / binding fallback |
| Provider BUSY（task not created） | 允许同模型 Binding fallback |
| INVALID_INPUT | **never retry** |
| CONTENT_POLICY | **never retry** |
| Provider terminal infra failure | 按 error taxonomy + billing semantics + user budget + fallback policy 决定是否产生 Attempt N+1 |

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §69 | Attempt Fallback：Provider Task 已 RUNNING 禁止为「更快」偷偷再提交另一 Binding；除非 **explicit hedged generation** 且用户明确接受双重成本；P0 `hedging=OFF` | hedging 开关 | 不隐式对冲 | — |
| §70 | Error Taxonomy 统一 23 类：AUTH_ERROR/INVALID_INPUT/UNSUPPORTED_OPERATION/UNSUPPORTED_PARAMETER/ASSET_INVALID/ASSET_UNREACHABLE/CONTENT_POLICY/RATE_LIMIT/CONCURRENCY_LIMIT/QUOTA_EXHAUSTED/PROVIDER_QUEUE_FULL/PROVIDER_BUSY/PROVIDER_TIMEOUT/PROVIDER_UNAVAILABLE/PROVIDER_INTERNAL/PROVIDER_TASK_NOT_FOUND/PROVIDER_TASK_EXPIRED/OUTPUT_INVALID/ASSET_DOWNLOAD_FAILED/ASSET_FINALIZE_FAILED/BILLING_FAILED/UNKNOWN | 统一 error class | 归类一致 | 现有 error 归类分散 |

---

## 13. §71–§77 Raw Error / Asset Input / Delivery / Preflight / Signed TTL / Cache

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §71 | Raw Provider Error 存 provider_error_code/provider_http_status/provider_error_class/**redacted_provider_message**；**禁止记录 Authorization/API Key/完整敏感 request** | 脱敏错误字段 | 无敏感信息落库 | — |
| §72 | **Asset Input ≠ URL**：业务层用 asset_id，Provider Driver 决定 HTTPS URL/signed URL/provider upload/base64/GCS URI | asset_id 语义 | 业务层无 URL | 现有可能直接 URL |
| §73 | Asset Delivery Strategy 统一 URL_PULL/PROVIDER_UPLOAD/DATA_URI/CLOUD_NATIVE_URI | 策略字段 | 按策略投递 | — |
| §74 | Asset Preflight：submit 前验证 existence/mime/size/width/height/ratio/fps/codec/duration/reference count/combined duration/size/provider-specific constraints | preflight 结果 | 提交前全验 | — |
| §75 | **Preflight 必须 Provider-specific**（Runway URL 要求 HTTPS/合法 domain/Content-Type/Content-Length/不跟 redirect；Vidu Start-End 要求两图/宽高比接近），不可能靠一个通用文件检查器 | 每 Provider 规则 | 规则隔离 | 现有通用检查器 |
| §76 | Signed URL TTL ≥ 预期 provider queue time + input fetch window + safety margin；未知读取时用 provider_execution_deadline+margin，或优先 Provider Upload | TTL 计算 | URL 不提前失效 | — |
| §77 | Provider Asset Cache：provider_id/credential_scope/asset_checksum/provider_asset_id/expires_at；相同角色图不重复上传 | 缓存表 | 命中不重复上传 | 无 provider asset cache |

---

## 14. §78–§83 OutputManifest / Provider Success≠Job Success / Finalize / 永久存储 / Media Metadata / Lineage

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §78 | Driver 不返回 `video_url`，返回 OutputManifest `{artifacts:[{role, media_type, source}], provider_metadata}`；role 允许 primary_video/preview_video/audio/thumbnail/first_frame/last_frame/image_sequence/alpha_video/metadata | manifest 结构 | 多产物归一 | 现有单一 video_url |
| §79 | **Provider Success ≠ Job Success**：SUCCEEDED→FETCH OUTPUT→VERIFY→PERSIST→MEDIA METADATA→SETTLE→Job SUCCEEDED | 后处理链 | 中间步失败 Job 未成功 | 现有可能 provider 成功即 job 成功（冲突点） |
| §80 | Finalize Activity 独立重试：Provider 成功+OSS 故障→保存 **provider result snapshot**→重试 FINALIZE，绝不能重新生成 | snapshot | 不重生成 | assetFinalize 已有（部分） |
| §81 | 输出永久存储：Runway URL 24–48h 失效、Replicate 默认 1h 删除→最终用户资源必须落 Moling OSS/durable storage | OSS 落库 | 资源永久化 | 已有 OSS/uploadQueue |
| §82 | Media Metadata 至少 checksum/container/codec/width/height/duration/fps/audio_present/audio_codec/size/thumbnail_asset_id/first_frame_asset_id/last_frame_asset_id | metadata 字段 | 元数据齐全 | — |
| §83 | Generation Lineage：Job.parent_job_id + Asset.source_asset_ids，形成 A→image_to_video→B→extend→C→lip_sync→D | lineage 字段 | 链路可追溯 | 现有 provenance 部分（PRODUCT_CONSTITUTION §16） |

---

## 15. §84–§91 Billing（三概念 / Reserve→Settle / 成本维度 / Pricing Rule / max_cost / 已收费失败 / Ledger 幂等 / Atomic 分离）

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §84 | Billing **三概念严格分**：estimated_provider_cost / actual_provider_cost / user_charge，绝不能混 | 三字段 | 不混记 | 现有 ledger 有 reserve/settle（PRODUCT_CONSTITUTION §2 已有 Quote/Reserve/Settle/Release） |
| §85 | Reserve→Settle：生成前 estimate→reserve；完成 actual→settle；失败 release/refund | 状态流转 | 收口正确 | 已有 Reserve/Settle/Release |
| §86 | Provider Cost 可能≠简单时长（Seedance 2.5 受输出秒数+输入/参考视频秒数+分辨率影响）；**禁止 DB 只存 price_per_second** | 多维度成本 | 无单价格字段 | 现有疑似 price_per_second |
| §87 | Pricing Rule 结构化公式 `{calculator:video.seedance2_5.v1, dimensions:[output_seconds, input_video_seconds, resolution]}`；复杂价用 versioned pricing calculator；**禁止后台管理员填任意 JS** | 版本化 calculator | 不可注入 JS | — |
| §88 | max_cost_authorized：生成前 estimate=35/user authorized=40；提交前重算=45 则**停止并要求重新确认，不能静默多扣** | max_cost 字段 | 超限重确认 | — |
| §89 | Provider 已收费但用户生成失败：可 user_charge=refunded，但 **actual_provider_cost 仍记账**（否则平台利润分析错） | 分账 | 成本不抹除 | — |
| §90 | Ledger Idempotency：reserve:{job_id}/settle:{attempt_id}/release:{job_id}/refund:{refund_id} 必须唯一；webhook 重复不能重复 settle | 唯一 key | 不重复 settle | — |
| §91 | **Atomic Operation 与 Workflow 彻底分离**：Atomic=一次 Provider model execution；Workflow=多个 Atomic 编排 | 边界清晰 | 不混 | — |

（§92 例：小说转整集短剧/完整 Scene/多镜头广告=Workflow 非 Atomic；§93 Runway versioned Recipes 佐证 Model Operation≠Business Workflow。）

---

## 16. §94–§100 Workflow DAG / Revision / FailurePolicy / 不直执 / runtime_contract_revision

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §94 | Workflow 数据模型：workflow_definitions / workflow_revisions / workflow_runs / workflow_step_runs | 四表 | 定义与运行分离 | 现有 production graph 部分重叠 |
| §95 | Revision **生产使用后 IMMUTABLE**；Project 存 workflow_revision_id；**禁止默认 latest** | revision_id 引用 | 不默认 latest | — |
| §96 | DAG 每 Step：step_id / operation 或 child workflow / dependencies / input_mapping / output_mapping / retry_policy / failure_policy | DAG 结构 | 依赖正确 | — |
| §97 | Failure Policy 每节点明确 FAIL_WORKFLOW/RETRY_STEP/SKIP_STEP/USE_FALLBACK/WAIT_FOR_USER；**不能让 AI 编排器临时猜** | 策略字段 | 策略显式 | — |
| §98 | **Workflow 不直接执行 Provider**：Workflow→Generation V2 Job→Attempt→Driver，账务/监控/资产不旁路 | 必经 Job 层 | 不旁路 | — |
| §99 | Worker Runtime 也考虑版本：v1 建 Job，20 分钟后 v2 部署，v2 必须能处理 v1 Job | 向后兼容 | 跨版本可处理 | — |
| §100 | Job Snapshot 增加 `runtime_contract_revision` | 字段落库 | 复现运行时契约 | — |

---

## 17. §101–§103 部署 / Event Replay / 暂不 Temporal

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §101 | 短运行 Generation 用 **blue/green**：新 worker 处理新任务，旧 worker drain old jobs | 部署策略 | 无中断 | — |
| §102 | 改 Event Reducer/State Machine/Workflow Engine 必须拿**真实脱敏历史 event fixtures 做 replay**，验证最终状态与旧版一致 | replay fixtures | 状态一致 | — |
| §103 | **V2.0 决定 NO mandatory Temporal**；现有 Node+PG+Redis+Generation V2 上先实现 durable state/outbox/inbox/activity retry/lease/reconciler/version snapshot；工作流持续几天/数百 step 时再单独评估；禁止因提到 Temporal 就大规模引新基建 | — | 不引 Temporal | 现有 Node+PG+Redis |

---

## 18. §104–§108 Observability / OTel / Webhook Trace / 低基数 / Metrics

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §104 | 统一 trace_id/request_id/job_id/attempt_id/activity_id/provider_task_id | 关联字段 | 全链路可查 | — |
| §105 | OTel Context Propagation：API→Outbox→Worker→Activity 保持 trace context | trace 传播 | 跨进程关联 | — |
| §106 | Webhook 无法携带原 traceparent 时新建 span + **Span Link** 关联原 Attempt trace | span link | 关联不丢失 | — |
| §107 | **Metrics 禁止高基数字段**：job_id/provider_task_id/asset_id 放 logs/traces；label 只用 provider/model/operation/binding/status/error_class/service_class，并控制 Model Revision 数量 | 低基数字段 | 无高基数 | — |
| §108 | 关键 Metrics 清单：generation_jobs_total/success_rate/queue_wait_seconds/submit_latency_seconds/provider_queue_seconds/provider_runtime_seconds/finalize_seconds/end_to_end_seconds/provider_errors_total/retry_total/fallback_total/submit_unknown_total/orphan_jobs/webhook_lag/webhook_duplicate_total/poll_requests_total/actual_provider_cost/user_charge/platform_loss | 指标集 | 指标齐全 | 现有 monitor 有基础指标 |

---

## 19. §109–§113 Fair Scheduler / Scheduling Class / 约束 / Generation Group

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §109 | Fair Scheduler 防「一用户 1000 batch 饿死其他用户」；需优先级/隔离/fair queuing（K8s API Priority & Fairness 佐证） | fair queuing | 不饿死 | — |
| §110 | Scheduling Class ∈ INTERACTIVE/NORMAL/BATCH/BACKGROUND | class 字段 | 分级调度 | — |
| §111 | 调度约束至少 per_tenant_inflight/per_user_inflight/per_project_inflight/priority class/quota scopes；P0 可 weighted round robin / deficit-style fairness，不立即上 shuffle sharding | 约束字段 | 约束生效 | — |
| §112 | 正式加入 `generation_group`（Krea 同 prompt 多模型 side-by-side 佐证），例 Shot 010 下 Seedance/Veo/Kling | group 结构 | 多模型并跑 | — |
| §113 | **Group ≠ Auto Router**：Auto Router=选 1 个；Generation Group=主动生成 N 个 | 语义区分 | 不混淆 | — |

---

## 20. §114–§120 Studio UI / Basic / Advanced / 切换 / Auto / Canvas Node / 连续镜头

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §114 | Studio UI 流程 Model→Operations→Schema Form | 表单由 schema 驱动 | 无硬编码 | 现有硬编码表单 |
| §115 | Basic 统一语义 Prompt/Duration/Aspect Ratio/Resolution/Audio，模型支持才出现 | basic 字段 | 按能力显隐 | — |
| §116 | Advanced 显示模型独有 camera/motion/seed/voice/references/model-specific | advanced 字段 | 模型独有隔离 | — |
| §117 | 模型切换必须展示 Projection Report（例 4 retained/1 adjusted/2 parked），**不能静默** | report 展示 | 切换可见 | 现有静默切换 |
| §118 | Auto Video 生成前可先 Resolve，展示预计模型/费用/参数调整 | resolve 预展示 | 透明 | — |
| §119 | Canvas Video Node 只存 logical_model/model_revision(optional pin)/operation/semantic_state/input_state/parked_state/job_id/output_asset_ids；**不得存 Provider Secret/request payload/endpoint** | node 字段白名单 | 无 Provider 泄漏 | — |
| §120 | 连续镜头走**服务器资产链**（Shot01 last_frame asset→Shot02 first_frame），禁止 Browser Download→Screenshot→Upload | 服务器链路 | 不经浏览器 | — |

---

## 21. §121 三 API 验证抽象

| Provider | 佐证结论 |
|---|---|
| Seedance/fal | 大量 images/videos/audio 各有数量时长约束 → **Operation Schema 必须独立** |
| Vidu | Start-End 是独立 endpoint，Image-to-Video 又不同 duration/resolution/audio → **不能一个 giant schema** |
| Veo/Google | generateVideos→long-running operation→operations.get() 反复查询 → **Async Runtime 必须是基础能力** |

---

## 22. §122–§128 Onboarding / Golden Fixture / Contract / Drift / 禁自动改产

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §122 | Provider Onboarding 12 步：provider profile/auth strategy/API version/Driver/error map/status map/asset strategy/webhook strategy/poll policy/quota scopes/data policy/contract tests | 12 项清单 | 新 Provider 全过 | — |
| §123 | Model Onboarding 10 步：Logical Model/Revision/Operations/Schema/UI Schema/Semantic Map/Pricing/Binding/Certification/Golden Fixtures | 10 项清单 | 新模型全过 | — |
| §124 | Golden Compile Fixture：每个 Model×Operation×Binding 存 Moling input→expected Provider request | fixture | compile 结果一致 | — |
| §125 | Golden Normalize Fixture：Provider response→expected Moling normalized result | fixture | normalize 一致 | — |
| §126 | Contract Tests 覆盖 validate input/compile/submit mock/poll normalize/webhook normalize/success/failure/cancel/cost/artifact manifest | 测试集 | 全路径 | — |
| §127 | Drift Detection：定期 metadata check/contract probe/optional low-cost canary；发现变化 VERIFIED→**DRIFTED**，禁止透明 fallback | 探测机制 | 漂移即降级 | — |
| §128 | **Provider 文档变化不能自动改生产**：禁止「爬文档→AI 自动改 ACTIVE Schema」；正确 detect→DRAFT revision→contract tests→canary→activate | 变更流程 | 生产不经 AI 直改 | — |

---

## 23. §129–§138 Admin ModelHub / UI 范围 / DB 约束 / Event Log / Reconciler / Orphan / Snapshot / 脱敏 / 三种 Drift / Feature Flags

| 节 | 决策点 | 数据要求 | 验证要求 | 现系统对照词 |
|---|---|---|---|---|
| §129 | Admin ModelHub 需看到 Model/Revision/Operation/Schema/Semantic Mapping/Binding/API Version/Driver Revision/Certification/Quota/Pricing/Health/Latency/Success Rate/Data Policy/Last Contract Test | 展示字段 | 全可见 | — |
| §130 | **不是所有字段第一期都做后台 UI**，第一期 code/config managed，不要为后台阻塞 Runtime | 分阶段 | 不阻塞 | — |
| §131 | 核心 DB 约束至少 4 条：UNIQUE(tenant+endpoint_scope+idempotency_key) / UNIQUE(job_id+attempt_no) / UNIQUE(provider+credential_scope+provider_task_id) / UNIQUE(provider+provider_event_id)；无 event_id 用 Provider-specific dedupe | 唯一约束 | 重复被挡 | — |
| §132 | Append-only Event Log `generation_events`（event_id/job_id/attempt_id/type/source/provider_event_id/payload_hash/created_at）用于 debug/audit/replay；**不要求完整 Event Sourcing**，当前状态仍存 generation_jobs | event log 表 | 追加不删改 | 现有 append-only events（部分） |
| §133 | Reconciler 周期找 SUBMIT_UNKNOWN/provider task missing updates/provider terminal but finalize incomplete/cancel pending/billing unsettled/activity lease expired/outbox stuck/inbox stuck | 扫描项 | 异常收敛 | 现有 reconciler 有基础 |
| §134 | **Orphan 阈值按 Phase 配置**（phase/provider/service_class/operation 共同决定），禁止「所有 RUNNING>10min 算 orphan」（Vidu off-peak 可 48h） | 分维度阈值 | 不误判 | 现有固定阈值（冲突点） |
| §135 | Job Execution Snapshot 保存 20 项：logical_model_id/model_revision_id/operation_revision_id/schema_revision-hash/semantic_map_revision/routing_policy_revision/binding_revision/provider_api_version/driver_revision/compiler_revision/pricing_revision/runtime_contract_revision/workflow_revision_id?/normalized_input/resolved_input/**compiled_request_redacted** | snapshot 全字段 | 历史可复现 | 现有 snapshot 不全 |
| §136 | compiled_request 脱敏：删 Authorization/API Keys/signed secret headers/full base64 media；Asset 只记 asset_id+checksum | 脱敏字段 | 无敏感落库 | — |
| §137 | **三种 Drift 分开**：SCHEMA_DRIFT / PROVIDER_API_DRIFT / RUNTIME_CODE_DRIFT，禁止统称「model update」 | 三类区分 | 分别处置 | 现有未区分 |
| §138 | Feature Flags 至少 8 个：VIDEO_OPERATION_REGISTRY / VIDEO_SCHEMA_RUNTIME / VIDEO_NEW_DRIVER_RUNTIME / VIDEO_DURABLE_EVENTS / VIDEO_NEW_ROUTER / VIDEO_SCHEMA_UI / VIDEO_CANVAS_RUNTIME / VIDEO_WORKFLOW_RUNTIME | flag 集合 | 灰度开关 | 现有已有 Feature Flags 体系 |

---

## 24. 与现系统关键冲突点清单（规范 vs 现有 generation_tasks/dispatcher 单表状态机）

> 基于规范 §3 自查清单 + legacy `generation_tasks` 单表 + dispatcher 状态机口径。**无实测**，冲突项为「规范要求 vs 已知现有形态」的结构性差异，待 Phase 0 Audit 实测确认。

| # | 冲突点 | 规范要求 | 现有 generation_tasks/dispatcher 形态 |
|---|---|---|---|
| 1 | **单表承载多重职责** | Source of Truth 写死：Job/Attempt/Activity/Provider 状态分层，各自唯一权威（§6,§39-42） | 单表 `generation_tasks` 同时承载用户意图/执行/Provider 状态，权威重叠 |
| 2 | **状态机爆炸** | External Status(QUEUED/RUNNING/SUCCEEDED/FAILED/CANCELED) 与 Internal phase/reason 分离，禁止 `RUNNING_*_RETRY` 状态（§45-47） | 单 status 字段造 `RUNNING_RATE_LIMIT_RETRY`/`RUNNING_UPLOAD_RETRY` 等状态爆炸 |
| 3 | **无 Activity 层** | 8 类 Activity 各自独立 retry/timeout/idempotency；禁止 Job Retry=从头重跑（§42-44） | dispatcher 单步整体推进，失败整体重跑 |
| 4 | **无 SUBMIT_UNKNOWN** | 提交响应丢失进 SUBMIT_UNKNOWN，禁自动换 Provider，6 步恢复（§53-54） | 无该状态，提交失败可能立即 fallback/重提 |
| 5 | **Provider Success=Job Success** | Provider SUCCEEDED 后必须 FETCH→VERIFY→PERSIST→METADATA→SETTLE 才 Job SUCCEEDED（§79） | 现有 provider 成功即任务成功，后处理缺失 |
| 6 | **状态多入口直改** | Event Reducer 唯一入口 applyProviderEvent()，Webhook/Poller 都进它（§60） | webhook/poller/dispatcher 可能各自直接 UPDATE 状态 |
| 7 | **单一 timeout** | 四时间分离 client_wait/queue/provider_execution/job_business deadline（§64） | 单一 timeout 字段 |
| 8 | **Orphan 固定阈值** | 阈值按 phase/provider/service_class/operation 配置（§134） | 「RUNNING 超 N 分钟算 orphan」固定规则 |
| 9 | **Quota 单并发池** | Quota Scope 多维度(ACCOUNT/REGION/CREDENTIAL/MODEL/...)+limit_type(CONCURRENCY/RPM/TOKEN_BUCKET)+burst/sustained（§24-26） | 现有 provider_resource_pool 单并发池 |
| 10 | **无 revision/version 冻结** | logical_models/model_revisions/model_operations/model_operation_revisions 四表 + provider_api_version/driver/compiler revision 冻结 + schema_hash（§7,§18） | 现有单 model 表无 revision 分层，无 API 版本冻结 |

**Top5（Phase 0 需最先实测确认）**：① 单表多重职责 → ② 状态机爆炸（status vs phase/reason）→ ③ 无 Activity 层/整体重跑 → ④ 无 SUBMIT_UNKNOWN → ⑤ Provider Success 即 Job Success。

---

## 25. Phase 1 首个 Registry 叶子的精确范围建议

**叶子定位**：只做 `logical_models` + `model_revisions` + `model_operations` + `model_operation_revisions` 四表 + `schema_hash` 的**只读映射与落库**（EXTEND 现有 ModelHub，不 DUPLICATE，不改 Runtime 执行路径）。

**范围边界（In Scope）**：
- 四张 registry 表 DDL（含 §7 全部字段、status 枚举、`kind=ATOMIC`、`schema_hash`）；
- 现有 ModelHub model 数据 → `logical_models`/`model_revisions` 的**映射脚本**（code/upstream_vendor 等对齐）；
- `model_operation_revisions` 的 schema 内容 **ACTIVE 后禁 UPDATE，改动=新 revision** 的约束/校验；
- JSON Schema Draft 2020-12 校验器接入（§8），`unevaluatedProperties:false` 组合校验（§9）；
- 落库输出：一个「现有表 → 四表映射对照 + 缺口清单」报告（供后续叶子消费）。

**Out of Scope（本叶不做，避免越界）**：
- Binding/Driver/Certification/capability_signature（§17-21，属 Phase 3 前）；
- Router/Quota Scope/Service Class（§24-38）；
- Job/Attempt/Activity 改造与 generation_tasks 迁移（Phase 2）；
- Webhook/Event Reducer/Billing/Workflow（Phase 2-4+）；
- UI/Canvas 改造（Phase 7-8）。

**验证要求（本叶出口 Gate）**：
1. 四表 DDL 与 §7 字段/枚举逐一对应，无缺列；
2. `schema_hash` 对已 ACTIVE 数据不可变（写入即锁定）；
3. 组合 Schema（allOf/oneOf/$ref）在 unevaluatedProperties:false 下不误判合法字段（§9 用例）；
4. 映射报告覆盖现有 ModelHub 全部 model 行，零遗漏。
