# 32 · video-runtime Gate 验收证据账（Gate 1-20 / §151）

> 产物性质：验收证据账（只读盘点，未改码 / 未 git / 未 ssh / 未重跑测试）。
> 依据来源（只读）：
> - `docs/product-v2/30-video-runtime-plan.md`（§C Gate 映射 + §D Phase 门槛 + §A 叶级清单）
> - **LEDGER**（治理仓 `moling-control/runtime/blueprint-v2/gates/LEDGER.md`，batch 复核记录 / pass 数 / sha256 / 迁移 applied 计数）
> - 主仓提交链 `git log --oneline`（fc5d456 … d3369ad）
> - 各叶测试文件存在性（`ls` 实测，未 `node --test` 重跑）
> 证据口径：**pass 数引用 LEDGER batch 复核记录与提交体；LEDGER 未单列的套件以「存在 + 归入父线批次总数」注明，不虚标精确数。**

---

## 0. 结论速览

- **实施叶 L1-L55**：已合入 **53** 叶（L1–L52 + L54），待发布 **2** 叶（L53 流量切换、L55 legacy 删除）。
- **Gate 1-20 验收叶**：20/20 全部叶已合入；其中 **18 Gate 证据齐**（16 完整套件绿 + 2 套件名偏移但行为有覆盖），**2 Gate 未验**（G18 job-snapshot、G19 replay 无专用验证套件）。
- **迁移链**：0058–0072 全链 72/72 文件落库，HEAD=0072；容器 build10(640db91) DEPLOY_OK，build11(fc2080d) 收敛 + 0065/66 checksum 同步 **deferred:container-apply**（待晨间）。
- **接线待翻转**：新路径（durable events relay tick / poll 经 applyProviderEvent / driver 工厂 / 新路由 / 新 driver）均已合入但 **flag 默认 off**，`entry 注入点翻转` + `FF_VIDEO_DURABLE_EVENTS=1` 属生产行为变更，留晨间（不深夜盲切）。

---

## 1. Gate 1-20 验收证据表（§151）

| Gate | 规范条款（§C 验收内容） | 验收叶(L#) | 合入 commit | 测试证据（套件 + pass + 环境） | 迁移依赖 | 缺口注明 |
|---|---|---|---|---|---|---|
| G1 | 新模型零核心修改：加 `video.future-test` 不改 5 核心 switch | L1–L7 | fc5d456 | modelhub/*.test.cjs **92/92**（registry-schema 13 + modelSchema 13 + semanticMap 25 + capabilitySignature 16 + flags 6 + registry）+ migration 22/22；本地 PG(59 applied) | 0058, 0059 | 证据齐（diff 不含 dispatcher/server.js core 由父线单写约束保证，见 §C 备注） |
| G2 | 新 Operation 仅 Registry/Schema/Driver 即可跑 | L2,L3,L4,L22 | fc5d456, cbe4c27 | registry.test.cjs 存在（含于 92/92）+ driver-contract 15/15；本地+PG | 0058, 0059, 0064 | 证据齐 |
| G3 | 参数切换产生 exact/adjusted/parked | L5,L43,L44 | fc5d456, 40b3671, 29964bd | semanticMap 25/25 + projectDirector 14/14 + 0069 parked；本地+PG(71 applied) | 0058, 0059, 0069 | 证据齐 |
| G4 | Duplicate API Request：1 Job + 1 reserve | L11,L15 | 34162d3, c03ff89 | intake.test.cjs **10**；本地+PG(62 applied) | 0061(idem idx) | 证据齐 |
| G5 | DB成功/Queue失败：outbox 恢复后 provider 只提交一次 | L9,L10,L11 | 34162d3 | outbox-recovery.test.cjs **9/9**（位于 `server/tests/unit/`，非计划 generation-v2 路径）；本地 | 0060, 0061 | 证据齐（套件路径与计划 §C 名不同，已存在） |
| G6 | Worker Crash：lease 到期他 worker 接手 | L9,L10 | 34162d3 | lease.test.cjs（activity-runner+lease 5fn **26/26**）；本地 | 0060 | 证据齐 |
| G7 | Submit Unknown：不创建第二任务 | L11,L14 | 34162d3, c03ff89 | no-blind-resubmit.test.cjs **8**；本地+PG | 0060, 0061 | 证据齐 |
| G8 | Duplicate Webhook：Finalize once / Settle once | L16,L19,L33 | c03ff89, 2f868db | **webhookInbox.test.cjs 不存在**；由 eventReducer 15/15（dedupe 幂等）+ webhookVerify 21 覆盖；本地 PG 5433 | 0062, 0066-B | 证据齐（**套件名偏移**：计划 §C 命名的 webhookInbox.test.cjs 未建，去重/单次 settle 由 eventReducer + ledger settleByAttempt 覆盖） |
| G9 | Out of Order：RUNNING→SUCCEEDED→RUNNING 终 SUCCEEDED | L19,L20 | c03ff89 | eventReducer.test.cjs **15/15**（含 5 集成，PG 5433）+ reconciler 10 | 0061, 0062 | 证据齐 |
| G10 | Provider Success/OSS Fail：只重试 Finalize，生成次数=1 | L27,L28 | cbe4c27, 2f868db | oss-failure.test.cjs 存在；LEDGER batch5 记 finalize 断点重试 **7**（L28 核心）；套件独立 pass 未单列（含于 203/203） | 0065 | 证据齐（oss-failure 套件独立计数未单列） |
| G11 | Wait Timeout：用户超时 Provider 继续，Job 最终完成 | L19,L20,L21 | c03ff89, cbe4c27 | provider-status-router.test.cjs + poll policy **18/18**（4 deadline，等待≠取消）；本地+PG(68 applied) | 0061, 0062, 0063 | 证据齐 |
| G12 | Cancel Unsupported：记 actual provider cost | L21,L30,L33 | cbe4c27, 2f868db | ledger.test.cjs 存在 + billing 三段 **5**（0066-B 列 + settleByAttempt）；本地 | 0063, 0066 | 证据齐（ledger 套件独立计数未单列） |
| G13 | Manual Model：全 Veo binding 失败禁调 Seedance | L37 | 29964bd | router.test.cjs（两层 **36 新 + 58 旧回归**）；本地+PG(71 applied) | — | 证据齐 |
| G14 | Auto Model：能力过滤后才 score | L38 | 29964bd | 同上 router.test.cjs（13 道 admission 固定序 + 原因链） | — | 证据齐 |
| G15 | Unknown Provider Equality：certification=UNVERIFIED 禁透明 fallback | L36,L37 | cbe4c27, 29964bd | bindings.test.cjs + quota-cert **24**（cert 状态机）；本地+PG | 0067 | 证据齐 |
| G16 | Quota Scope：Account/Credential/Model 三层同时作用 | L34,L35 | cbe4c27, 40b3671 | provider-admission.test.cjs **15**（ALL MATCHED 4 级序）；本地 | 0067 | 证据齐 |
| G17 | Pricing：参考视频时长↑ → 预估成本正确变 | L30,L31 | 2f868db, cbe4c27 | pricing.test.cjs **21/21**（白名单公式，禁任意 JS）；本地 | 0066 | 证据齐 |
| G18 | Historical Snapshot：改 Schema/Routing/Pricing/Driver 旧 Job 仍显旧 revision | L27,L30,L33,L40 | cbe4c27, 2f868db, 640db91 | **job-snapshot.test.cjs 不存在**；由 routingPolicy/routingAudit 决策快照 **11+4**（policy_snapshot 禁更新触发器）部分覆盖；无「旧 Job 回显旧 revision」专用验证 | 0065, 0066, 0068 | **未验**（快照不可变性有覆盖，历史 Job 复现未专用验证） |
| G19 | Runtime Upgrade Replay：新 Reducer 回放旧 fixture 同终态 | L13,L19,L20 | c03ff89 | **replay.test.cjs 不存在**；eventLog 6（append-only）+ eventReducer 15/15 + reconciler 10 覆盖 reducer 行为；无「旧 fixture 回放终态一致」专用验证（§102 未落） | 0061 | **未验**（replay fixture 未专用验证） |
| G20 | Workflow Pinning：WF V2 上线旧 Project pin V1 重跑继续 V1 | L49,L52 | cbe4c27, 29964bd | **studioRunEngine.test.cjs 不存在**；实际 `studioWorkflowExecutor.test.cjs`（workflow executor **10** + pin/禁 latest **15**）；本地+PG(72 applied) | 0071, 0072 | 证据齐（**套件名偏移**：计划 §C 命名 studioRunEngine，实为 studioWorkflowExecutor） |

> 套件名偏移说明（3 处）：G5 outbox-recovery 在 `server/tests/unit/`（非 generation-v2）；G8 webhookInbox 未建（eventReducer 覆盖）；G20 studioRunEngine 未建（studioWorkflowExecutor 覆盖）。均已在表中注明，不以「文件不存在」虚标为「套件绿」。

---

## 2. 总实施叶 L1-L55 状态表

| 叶 | 标题 | 迁移 | 合入 commit | 状态 |
|---|---|---|---|---|
| L1 | logical_models + model_revisions 表 | 0058 | fc5d456 | 已合 |
| L2 | model_operations + model_operation_revisions 表 | 0059 | fc5d456 | 已合 |
| L3 | Operation Registry 服务 | — | fc5d456 | 已合 |
| L4 | Input Schema 校验运行时 | — | fc5d456 | 已合 |
| L5 | UI Schema + Semantic Map + capability_descriptor | — | fc5d456 | 已合 |
| L6 | capability_signature | — | fc5d456 | 已合 |
| L7 | Feature Flag 脚手架（8 VIDEO_*） | — | fc5d456 | 已合 |
| L8 | generation_activity_runs 表 | 0060 | 34162d3 | 已合 |
| L9 | Activity 执行循环 | — | 34162d3 (+2f868db worker mount) | 已合 |
| L10 | Worker Lease 扩到 Activity | — | 34162d3 | 已合 |
| L11 | Outbox 接线 legacy 分发 | — | 34162d3 | 已合 |
| L12 | phase+reason 列 + CHECK 单调 | 0061 | 34162d3 | 已合 |
| L13 | generation_events append-only 日志 | 0061(追加段) | c03ff89 | 已合 |
| L14 | SUBMIT_UNKNOWN 恢复序 | — | c03ff89 | 已合 |
| L15 | Internal Idempotency 对齐 | 0061(索引) | c03ff89 | 已合 |
| L16 | webhook_inbox 表 | 0062 | c03ff89 | 已合 |
| L17 | Webhook 安全（验签/防重放/constant-time） | — | c03ff89 | 已合 |
| L18 | 内部 Event Envelope | — | c03ff89 | 已合 |
| L19 | Event Reducer applyProviderEvent() | — | c03ff89 | 已合 |
| L20 | 状态单调推进 + provider_event_anomaly | — | c03ff89 | 已合 |
| L21 | Poll Policy provider-specific + 4 deadline | 0063 | cbe4c27 | 已合 |
| L22 | Driver Contract 接口 | 0064 | cbe4c27 | 已合 |
| L23 | Provider Driver: volcengine | — | 2f868db | 已合 |
| L24 | Provider Driver: fal | — | 2f868db | 已合 |
| L25 | Provider Driver: vidu | — | 2f868db | 已合 |
| L26 | Golden Compile/Normalize Fixture + Contract Tests | — | 2f868db | 已合 |
| L27 | OutputManifest | 0065 | cbe4c27 | 已合 |
| L28 | Finalize 独立重试 | — | 2f868db | 已合 |
| L29 | Media Metadata 扩展 | —(注释追加) | 2f868db | 已合 |
| L30 | Billing 三段分离 | 0066-B | 2f868db | 已合 |
| L31 | Pricing Rule 计算器 | 0066 | cbe4c27 | 已合 |
| L32 | max_cost_authorized 重估闸 | — | 40b3671 | 已合 |
| L33 | Ledger Idempotency settle:{attempt_id} | — | 2f868db | 已合 |
| L34 | provider_quota_scopes 表 | 0067 | cbe4c27 | 已合 |
| L35 | Quota Admission（ALL MATCHED） | — | 40b3671 | 已合 |
| L36 | Provider Certification | 0067 | cbe4c27 | 已合 |
| L37 | Binding Router（下层） | — | 29964bd | 已合 |
| L38 | Auto Model Router（上层 13 道） | — | 29964bd | 已合 |
| L39 | Resolve / Dry-run API | — | 640db91 (+52d692d auth 集成 3/3) | 已合 |
| L40 | Routing Policy 版本化 + 决策快照 | 0068 | 640db91 | 已合 |
| L41 | Schema→UI Form 生成器 | — | 40b3671 | 已合 |
| L42 | Custom Renderer Registry | — | 640db91 | 已合 |
| L43 | Projection Report | — | 40b3671 | 已合 |
| L44 | Parked State 保存/恢复 | 0069 | 29964bd | 已合 |
| L45 | generation_group 表 + 组执行 | 0070 | 40b3671 | 已合 |
| L46 | Canvas Video Node | — | 29964bd | 已合 |
| L47 | Lineage 链接 | 0070(追加) | 29964bd | 已合 |
| L48 | 连续镜头（last_frame→first_frame 服务器链） | — | 640db91 | 已合 |
| L49 | workflow_definitions + workflow_revisions 表 | 0071 | cbe4c27 | 已合 |
| L50 | workflow_runs + workflow_step_runs 表 + DAG | 0072 | 2f868db | 已合 |
| L51 | Workflow 执行（经 Generation V2 Job） | — | 40b3671 | 已合 |
| L52 | Workflow Revision pinning（Gate 20） | — | 29964bd | 已合 |
| L53 | Traffic Switch（flag 全量 + shadow 对齐） | — | — | **待发布**（release-gated：单写 server.js，生产行为变更，需 shadow 对齐+稳定窗口+canary） |
| L54 | 稳定窗口观测 + 回滚预案 | —(无 DDL) | d3369ad | 已合（纯函数 PREP，生产惰性） |
| L55 | 删除 legacy 路径 | DROP 迁移 | — | **待发布**（依赖 L54 + 破坏性 DROP + 容器 apply） |

**计数**：已合 53（L1–L52 + L54），待发布 2（L53、L55）。迁移 0058–0072 全部 15 个文件落库，全链 72/72。

---

## 3. Phase 门槛对照（§D 判据 vs 现状）

| Phase | §D 迁移 head | §D 测试判据 | 现状 | 判定 |
|---|---|---|---|---|
| 0 | — | `28-video-runtime-audit-v2.md` 已产出 | f18a503 已产出 28-audit（+6f59071 digest + 630d3c6 plan） | ✅ 达成 |
| 1 | 0059 | modelhub/*.test.cjs ≥6 新用例全绿 | fc5d456：92/92 + migration 59 applied | ✅ 达成（超判据） |
| 2 | 0061 | activity/lease/outbox/submit_unknown ≥10 全绿；Gate 4-7 通过 | 34162d3+c03ff89：81/81+86/86，Gate 4-7 证据齐 | ✅ 达成（超判据） |
| 3 | 0063 | reducer/monotonic/inbox ≥8 全绿；Gate 8-9/11-12 通过 | c03ff89+cbe4c27：eventReducer 15、poll 18、ledger 5；Gate 8/9/11/12 证据齐 | ✅ 达成（超判据） |
| 4 | 0064 | 3 provider contract tests + golden fixtures 全绿；Gate 1-2 真实 credential shadow 通过 | 2f868db：volc17/fal19/vidu21 + golden 57 样本/contract 63 | ⚠️ **部分**：contract tests 绿，但「真实 credential shadow」归容器/Final Gate 未做（driver 未实例化，DRIVER_NOT_INSTANTIATED） |
| 5 | 0066 | pricing/finalize-retry/ledger ≥8 全绿；Gate 10/17 通过 | cbe4c27+2f868db：pricing 21、finalize 7、billing 5；Gate 10/17 证据齐 | ✅ 达成（超判据） |
| 6 | 0068 | router 两层/quota/cert ≥8 全绿；Gate 13-16 通过 | 29964bd+40b3671：router 36+58、admission 15、cert 24；Gate 13-16 证据齐 | ✅ 达成（超判据） |
| 7 | 0069 | form/projection/parked ≥5 全绿；Gate 3 通过 | 40b3671+29964bd：FormGenerator 21、projectDirector 14、parked 0069；Gate 3 证据齐 | ✅ 达成（超判据） |
| 8 | 0070 | group/lineage/连续镜头 ≥5 全绿；手工 3 模型并跑 lineage 链完整 | 40b3671+29964bd+640db91：group 9、lineage 11+4、continuity 13+12 | ⚠️ **部分**：单测全绿；**手工 3 模型并跑真链未做**（需真实 credential，归容器/Final Gate） |
| 9 | 0072 | workflow pin/DAG ≥5 全绿；Gate 20 通过 | cbe4c27+2f868db+29964bd：workflow 10、pin 15、runs 8；Gate 20 证据齐 | ✅ 达成（超判据） |
| 10 | 0072(回退) | 全量回归 + legacy 删除后 core 全绿；legacy traffic=0 + 稳定窗口≥1 周期 | L53/L55 未发布；build11(fc2080d) 收敛 + entry 注入点翻转 deferred:container-apply | ❌ **未达成**（发布动作留晨间，规范「不深夜盲切」） |

**Phase 门槛小结**：Phase 0-9 达标（Phase 4 真实 credential shadow、Phase 8 手工 3 模型并跑两项「手工/真实凭据」判据未做，属 Final Gate 范畴）；Phase 10 整体未达成（L53/L55 + entry 注入点翻转 + build11 收敛待晨间）。

---

## 4. 接线待翻转 / 缺口清单（不虚标）

1. **entry 注入点翻转**（deferred:container-apply）：poll re-route 经 `applyProviderEvent` 已 DI 门控（`createEventReducerStore`），未注入 = 旧路径逐字节不变；生产翻转需翻转 entry 注入点 + `FF_VIDEO_DURABLE_EVENTS=1`。
2. **driver 工厂注册表**：volc/fal/vidu 自注册但未实例化（`DRIVER_NOT_INSTANTIATED`）——真实调用待 L53 流量切换。
3. **容器 build11(fc2080d) 收敛**：未执行（build10/640db91 DEPLOY_OK 后 build11 未收敛）+ 0065/66 checksum 已同步（审批放行）但 build11 镜像未建。
4. **G18 / G19 无专用验证套件**：job-snapshot.test.cjs、replay.test.cjs 未建（§102 replay 未落）。
5. **Phase 4/8 手工判据未做**：真实 credential shadow（Gate 1-2）、3 模型并跑 lineage 手工链——需真实凭据/容器，非本账范围。

---

## 5. 验收计数回传

- **产物路径**：`docs/product-v2/32-video-runtime-gate-acceptance.md`
- **Gate 1-20 验收计数**：证据齐 **18/20**（其中 16 完整套件绿 + 2 套件名偏移但行为覆盖：G8、G20）；未验 **2/20**（G18 job-snapshot、G19 replay）。
- **实施叶**：L1-L55 已合 53 / 待发布 2（L53、L55）。
- **Phase**：0-9 达标（Phase 4/8 各留 1 项手工/真实凭据判据）；Phase 10 未达成（发布动作留晨间）。
