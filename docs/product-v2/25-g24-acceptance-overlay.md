# 25 — G24 Acceptance Overlay（narrative 10 must_pass + 5 north_star × G24 四判据 + 验收跑单草案）

日期: 2026-09-04
性质: **纯读 + 文档盘点**。本文件未运行任何代码、未执行 migration、未做运行时验证、未 git / 未 ssh。
证据规则: 所有「现状/证据」均为**文件级静态证据**，逐处标注 `文件:行` 或 `文件:静态计数`；「计数」= 对 `^\s*(test|it)\(` 的正则行匹配统计（node:test / vitest 用例数近似，**非运行结果**，误差 ±1）。「建议/缺口」为设计主张，与现状明确区分，**禁止据此宣称任何 PASS**。

依据:
- `blueprint-v2.0/05_ACCEPTANCE_EXECUTION_SPEC_V2.0.md:167-171` — G24 Final Production Acceptance 四判据（end-to-end complete episode/ad workflow / disaster test / billing audit / export）
- `blueprint-v2.0/references/narrative-productization-v2.0/MOLING_NARRATIVE_GOOD_REVIEW_ACCEPTANCE_V2.0.json:3-21` — 10 must_pass + 5 north_star（Good Review 验收层）
- `blueprint-v2.0/references/narrative-productization-v2.0/README-vs-blueprint.md:6-22` — must_pass→现门映射（收编稿，与本仓当前 HEAD 有出入处以本仓文件为准）
- `blueprint-v2.0/DIRECTION_2026-09-04.md:10` — north_star 5 指标为 G24 验收 overlay 候选（不自动并门，达标自证制）
- `moling-control/runtime/blueprint-v2/gates/G24_acceptance.json:1-7` — 门 annex 现状 `IN_PROGRESS`，仅记 providerWave1（22-frontend-parity + studioInteractionGaps 11/11），四判据未落账

本文件角色: G24 门 annex 的 **overlay 输入/跑单草案**，通过后由执行者写回 `runtime/.../G24_acceptance.json`（本文不写回）。

---

## 0. 术语速查（下文引用）

| 代号 | 含义 |
|---|---|
| 服务面 | `server/` API 路由 + 模块 + 迁移 + 服务层测试 |
| UI 面 | `src/` 页面/组件/交互测试 |
| 闭 / 缺 / 未建 | 有实现且有测试证据 / 无实现或无测试证据 / 明确不存在 |
| annex | 门验收台账（`moling-control/runtime/blueprint-v2/gates/G*_acceptance.json`） |
| 叶 (leaf) | flash 最小交付项；本文新增叶统一 `G24-<域>-L<n>`（属 G00–G24 收尾 annex，依 `docs/product-v2/24-community-wave-phases.md:25` 不另立波） |

V2 服务端路由注册总览（口径锚）: `server/server.js:1442`(ai-control) `1459`(workspaces/projects) `1474`(assets) `1500`(timelines) `1513`(bible) `1526`(script rows) `1539`(continuity) `1552`(presence) `1564`(uploads) `1604`(canvas) `1619`(episodes) `1634`(shots) `1649`(runs) `1680`(structure)，分发 `:2609-2681`。
V2 UI 路由口径锚: `src/app/router/V2App.tsx:133-149`（真页仅 `projects` / `projects/new` / `projects/:id` / `:id/assets` / `:id/studio`；`create/assets/characters/studio/billing/settings/tasks/models` 均为 Placeholder）。

---

## 1. 10 must_pass × 证据 / 实现状态 / 剩余动作映射

> 收编稿（README-vs-blueprint）与当前 HEAD 差异显著项已在行内标注（✅更新 = 以本仓文件为准）。

| # | must_pass（JSON 原文 L3-13） | 现门测试证据（文件:静态计数） | 实现状态 | 剩余动作 | 归属 wave/叶 |
|---|---|---|---|---|---|
| MP1 | first-time user can import story and reach a storyboard plan without understanding graph internals | 服务: `server/modules/script/scriptApi.test.cjs`:53；`storyboardPlan.test.cjs`:20；`segmentsToScriptRows.test.cjs`:9；`scriptModel.test.cjs`:23。UI: `e2e/m01s-project-foundation.spec.ts`:16（建项目→open→reload→archive，`:44-80`）；`e2e/m05a-infinite-canvas.spec.ts`:55 | **服务面半闭 / UI 缺**：rows CRUD + plan 视图 + apply 全在（scriptApi.cjs:8-32）；但「小说→改编方案→剧本」入口 UI 无——`V2App.tsx:141` `create` 仅 Placeholder，无导入/向导路由；`V2App.tsx:137` 只有 projects/new 元数据表单 | 首次用户导入向导（粘贴/上传→章节→rows→一键 plan 页），免图内部知识直达 storyboard 视图 | G00–G24 收尾 **G24-UI-L1**（UI 波，纪律同 `19-director-stage-g16-design.md:394-396`） |
| MP2 | no expensive video generation without clear estimate or explicit policy | `server/modules/generation-entry/quoteService.test.cjs`:6；`generationGate.test.cjs`:6；`shotSpend.test.cjs`:5；`server/modules/budget/budgetEstimate.test.cjs`:17；`budgetSpentStore.test.cjs`:12；`budget.test.cjs`:5；`server/modules/platform-policy/approvalGate.test.cjs`:4；`ai-control/approvalGate.test.cjs`:18；`generation-v2/production-gate.test.cjs`:3 | **服务面闭（部分）**：quote(确定性 hash)/eligibility gate/预算 preflight/审批闸在；超额触顶拦截由 budget 系列覆盖。**UI 缺**：执行前成本合计/确认弹层无页面证据（`V2App.tsx:146` billing Placeholder） | 画布 run 前置 quote 展示 UI + 批量成本合计确认；预算触顶→整批停的单条 e2e（现为 unit 级） | **G24-UI-L3 + G24-E2E-L2**；预算面缺口另见 `docs/product-v2/21-provider-runtime-gaps.md` |
| MP3 | locked content is never silently overwritten | 计划镜 lock: `server/modules/script/scriptApi.test.cjs`:53（G13 rows/plan 全量档）；lock 路由端点见 `scriptApi.cjs:49-55`；`server/db/migrations/0052_storyboard_locks.sql:2-8`（locked 行 apply 保留、`skippedLocked` 返回）。资产不可变: `project-foundation/assetVersion.test.cjs`:5；`tests/unit/asset-finalize-version-id.test.cjs`:3；`tests/integration/asset-finalize-version.test.cjs`:3。画布 CAS: `project-foundation/studioCanvasPersistence.test.cjs`:10；`tests/integration/studio-run-engine.test.cjs`:98-119（stale/任意 revision → CANVAS_REVISION_STALE） | **服务面半闭 / UI 缺**：plan shot lock（0052）+ 资产版本不可变 + 画布 CAS 已建；**script_rows 无 lock、无版本、last-write-wins**（`docs/product-v2/23-project-truth-three-view.md:28-29`）；lock 的 UI 控件无证据 | L1 script_rows 版本/revision（或 dirty 指纹已部分落地 0054，见 MP8）；lock 语义扩展至 rows/集级；UI lock 状态与「将受影响范围」提示 | **G24-SRV-L1**（接 23 §2.2-1 建议，波归三视图拆叶）+ **G24-UI-L4** |
| MP4 | one failed shot can be retried without rerunning successful shots | 批/单镜 retry 端点: `scriptApi.cjs:43-48`（retry-failed / tasks/:id/retry，attempt<max、非重试 409/缺 404）；`script/storyboardBatchPlan.test.cjs`:19；`batchTaskStore.test.cjs`:10；`generation-v2/retry-policy.test.cjs`:6；`no-blind-resubmit.test.cjs`:4；`failure-scenarios.test.cjs`:9 | **服务面闭**（⚠️收编稿 L12 曾标「G13 partial retry 未建」，现仓已含端点+测试，**以现仓为准**）。**UI 缺**：失败镜重试/成功镜跳过控件无页面证据 | UI 控件（失败镜列表 → 重试仅该镜）；「重试不重跑成功镜」e2e 断言（attempts 不变） | **G24-UI-L2 + G24-E2E-L1** |
| MP5 | source trace exists for adapted content | `server/db/migrations/0053_storyboard_source_trace.sql:2-8`（`project_shots_rows.source_trace` = {scriptRowIds, sceneIndex, beatIndex, shotIndex, appliedAtMs:0 不可变}）；`storyboardPlan.test.cjs`:20（plan 派生确定性）；执行/资产谱系: `shotLineage.test.cjs`:12；`studioRunGraphLineage.test.cjs`:4；`assetLineage.test.cjs`:4 | **服务面闭（plan→rows 派生溯源）**：buildShotRows 落 source_trace。**缺口（改编上游）**：script_rows 自身无「原文→改编行」列（字段清单见 23:29），小说原文 span 映射未落库 | 改编层 source map（原文片段→script_row）或经 0053 向上一跳补齐；lineage 只读查询接口（23 §3.5） | **G24-SRV-L2**（G14 annex；23 §3.5 拆叶） |
| MP6 | manual edit path remains available at outline/script/storyboard/video layers | script 手工 CRUD: `scriptApi.test.cjs`:53（PATCH/order/DELETE 端点 scriptApi.cjs:8-13）；画布手工编辑+restore: `studioCanvasPersistence.test.cjs`:10；episode/shot: `project-foundation/studioShotApi.test.cjs`:4；video 编辑: `generation-v2/videoEdit.test.cjs`:11 | **服务面部分闭**：script rows 手编在；canvas 手编在；**storyboard plan 是投影层恒重算、请求体忽略**（apply 设计，23:42）→「plan 层手编」= 需 G16 精修回填（`directorizeRows.test.cjs`:15 纯函数未落库，23:48）；video 层手编 = videoEdit + 资产回编。**UI 全缺**（无 script/storyboard 编辑路由，V2App:133-149） | 各层编辑 UI（script 编辑器、storyboard 视图、video segment 精修页）；plan 手编经受控写点（23:121 双写约束） | **G24-UI-L5**（编辑层，UI 波）；plan 手编单列 **G24-SRV-L3** |
| MP7 | old asset versions remain accessible | `assetVersion.test.cjs`:5；`finalize-version-id.test.cjs`:3；`asset-finalize-version.test.cjs`:3；画布 versions/restore: `studioCanvasPersistence.test.cjs`:10 + `tests/integration/studio-canvas-persistence.test.cjs`:5；UI: `src/__tests__/v2/assetLibraryDrawer.test.tsx`:7（`asset-version-row-*` 版本行 + race guard，`:189-210`） | **服务面闭 + UI 部分**：资产抽屉已有版本行证据；assets 页路由在（V2App:139）。缺完整「版本浏览/一键回滚」页级 e2e | 版本浏览/恢复完整页 + e2e（m04s 扩展） | **G24-UI-L6** |
| MP8 | source/reference change marks affected downstream stale instead of auto-spending | 前端 STALE 契约: `src/__tests__/v2/studioProductionNodesNormalization.test.ts`:81-171（改 prompt/assetId → 下游 STALE，STALE 粘性不自动清、不自动执行）；`studioProductionNodes.test.ts`:9；`studioStore.test.ts`:116-117（IDLE/READY/INVALID/STALE 白名单）；`studioComposer.test.tsx`:61-77。服务端 0054: `server/db/migrations/0054_storyboard_plan_fingerprint.sql:4-25`（fingerprint+dirty）；接线: `scriptApi.cjs:14-24`（GET plan 报 dirty/planFingerprint）`:56-61`（rows 写→markDirty 全部已 apply 计划） | **服务面闭（script→plan 方向）+ UI STALE 机制在（画布内）**；**跨层未闭环**：canvas 绑定校验函数未接线生产路由（23:63-64、23:124）；run 引擎 revision 权威（studio-run-engine.test.cjs:98-119） | `validateAuthoritativeBindings` 接线 handlePatch（23:124）；「源变更→全链 STALE→预算不自动花」端到端 e2e | **G24-SRV-L4**（23 §2.2-3 拆叶）+ **G24-E2E-L2** |
| MP9 | project survives refresh/reopen | e2e: `e2e/m05c-canvas-persistence.spec.ts`:22（刷新恢复/持久化）；`m01s-project-foundation.spec.ts`:16（reload 项目 overview 存活 `:44-80`）；integration: `studio-canvas-persistence.test.cjs`:5；unit: `studioCanvasPersistence.test.cjs`:10 + `studioCanvasPersistenceHook.test.tsx`:3 + `studioCanvasPersistence.test.ts`:7；run 事件持久: `runEventStore.test.cjs`:11 | **闭（三档测试均在）**：canvas/项目 reopen 有 e2e；跑单需补「script_rows + plan + batch 层 reopen」单一断言档 | 把 reopen 全链纳入 G24 跑单固化；north star 断言位（见 §3 NS5） | **G24-E2E-L3** |
| MP10 | script/storyboard/canvas/agent share the same domain truth | 反证/现状盘点: `docs/product-v2/23-project-truth-three-view.md:83-96`（三个 shot id 空间互未绑定：执行 shots / 计划 `s:b:k` / canvas 自由串）；`:63`（canvas 绑定无校验）；`:73`（run_events 无读回）。组件契约在: `scriptApi.test.cjs`:53、`studioRunApi.test.cjs`:26、`cli/mlg.test.cjs`:25（agent 视图） | **未建（共享域模型未统一）**：语义「绑定投影」vs 工程「独立 CAS 图域」脱节（23:100-102）；无任何测试证明四视图可 join | 按 23 §3 同步链落地（source fingerprint / 绑定校验接线 / lineage 查询）；agent 侧读同一权威 | **G24-DT-L1**（23 三视图拆叶；若需跨门契约变更则走 G04/G13/G19 annex） |

### 1.1 收编稿 vs 现仓 HEAD 差异清单（本文件判定口径）

| 项 | README-vs-blueprint（收编稿） | 本仓 HEAD 实测文件证据 | 结论 |
|---|---|---|---|
| MP4 partial retry | 「**G13 partial retry 未建**」（L12） | retry 端点 + 19/10 用例在（见上） | ✅更新：服务面已建 |
| MP3 lock | 「锁定(lock)语义无」（L11） | 0052 plan-shot lock + CAS + asset immutable 在；script_rows 仍无 | ✅部分更新 |
| MP5 source trace | 「改编 trace 元数据无」（L13） | 0053 source_trace 已落 plan 层 | ✅部分更新（改编上游仍缺） |
| MP8 STALE | 「联动无(预算触顶拦截)」（L16） | 0054 fingerprint/dirty + 前端 STALE 契约单测在 | ✅部分更新 |

---

## 2. 5 north_star_metrics → 判据 / 现有证据 / 验证位

| NS | 指标（JSON L15-21） | 达标判据（可断言格式） | 现有证据档 | 跑单验证位（§4） |
|---|---|---|---|---|
| NS1 | first_session_success_rate_target ≥70% | 首次会话「导入→剧本→分镜计划」成功路径占 ≥70%（遥测或跑单抽样） | 组件链路测试在（§1 MP1/MP6/MP9）；`src/__tests__/v2/telemetry.test.ts`:5（遥测面在，事件语义未核）；**无整链首次会话测量** | S1→S3 全链通过即 1 次样本；N 次样本 ≥70% |
| NS2 | locked_content_overwrite = 0 | 任何 lock 写绕行 = 0（lock→外部改写→断言 409/skippedLocked/版本新增） | 0052 + CAS 单测在（§1 MP3）；无 UI 交互 e2e | S6 |
| NS3 | auto_budget_overrun = 0 | 超预算/无 quote 提交被 gate 拒绝，账本零超支 | quote/gate/budget/ledger 单测在（§1 MP2） | S5 |
| NS4 | partial_retry_support = 100% for batch-compatible jobs | 每批全部失败镜可单镜/批级重试，成功镜 attempts 不变 | retry 端点 + 19/10 用例在（§1 MP4） | S4 |
| NS5 | reopen_recovery = 100% acceptance test | 任意阶段硬刷新/重开后状态等价（DB 读回 == 写前） | m05c/m01s/canvas 三档在（§1 MP9） | S7 |

> 依据 `DIRECTION_2026-09-04.md:10`：north_star 不自动并门，本表即 G24 跑单的达标自证占位。

---

## 3. G24 四判据：现有证据与缺口

判据原文: `05_ACCEPTANCE_EXECUTION_SPEC_V2.0.md:167-171`（end-to-end complete episode/ad workflow / disaster test / billing audit / export）。

| 判据 | 现仓证据（文件:计数/行） | 缺口 | 判定草稿 |
|---|---|---|---|
| **E2E** end-to-end complete episode/ad workflow | 组件级: §1 全表（rows/plan/apply/batch/retry/run 引擎/资产版本各档）。可执行骨架: `e2e/goldenPathHarness.cjs:20-28`（GP-01 required = brief/delivery_spec/shots/generate/output）与 `:10-12`（无 provider 安全 dry-run）——**骨架映射为占位**（`:43-55`）。ad 侧规格件: `delivery-spec`（W1-03 锁死输出规格 `src/shared/api/contract/delivery-spec-client.ts:34`；`deliverySpec.test.cjs`:6、`deliverySpecApi.test.cjs`:7、`projectTypeModes.test.cjs`:5、`creativeBriefApi.test.cjs`:6） | **无单一全链 e2e spec**（brief→rows→plan→apply→batch→run→输出→成片/交付清单）；现 e2e 8 文件均为 m00/m01/m02/m04/m05 门内，无 g13-/g24- 命名；episode 主链 vs **ad（TVC/商业）无独立模板流代码**，ad 判据依赖 export 面（堵在 export 缺，见下）；UAT S5 仅规划（`docs/product-v2/14-uat-plan.md:36-40` `export 清单`为意图非实现） | **FAIL（缺口）/ BLOCKED**，需 §4 跑单 + 新 spec 叶 |
| **DISASTER** disaster test | `server/tests/backup/disaster-recovery.test.cjs`:20（`package.json:29` `npm run test:dr`）；`tests/distributed/all.test.cjs`:24（D12 跨节点 SSE 实际投递 `:463`）；generation-v2 故障/恢复档: `fault-injection.test.cjs`:23、`failure-scenarios.test.cjs`:9、`reconciliation.test.cjs`:26、`reconciler.test.cjs`:5、`oss-failure.test.cjs`:4、`redis-failure.test.cjs`:4、`lease-fencing-pg.test.cjs`:9、`cluster-shutdown.test.cjs`:2；操作文档: `docs/operations/DISASTER_RECOVERY.md`、`BACKUP.md`、`POSTGRESQL_PRODUCTION_DR.md`（文档非实测）；审计: `Q6-HA-AUDIT.md:182`(F14 snapshot stale P1) | 灾难档 = 服务内故障/恢复单测强，**缺「DB→新实例 restore→业务续跑」整栈演练执行记录**；run_events 回放读者无（G21 审计注「从无人读回」`docs/product-v2/23-project-truth-three-view.md:73`） | **PARTIAL**：自动档在，整栈 drill 未跑（§4 S8 定义为必跑项） |
| **BILLING AUDIT** billing audit | 事务/账本: `server/billing-transactional.test.cjs`:7；`generation-v2/ledger.test.cjs`:5、`commercial-ledger.test.cjs`:6、`billing-chaos.test.cjs`:7、`no-blind-resubmit.test.cjs`:4；预算扣减: `budgetSpentStore.test.cjs`:12；审计轨迹: `server/modules/platform-data/audit.test.cjs`:2（`platform-data/audit.cjs`）；管理面: `/api/admin/audit` + finance reconcile（`docs/product-v2/09-api-map.md:51,58`）；计费导出断言: `tests/security/all.test.cjs`:21（`:323` reserveCredits 导出检查） | 对账为 unit/integration 级，**无「整批扣费 = 张数×单价 + 流水 = DB 聚合」端到端 e2e**；billing 前端 Placeholder（V2App:146）→ 用户面账单核对 UI 无 | **PARTIAL**：账务内核档强，端到端对账 + UI 缺（§4 S9） |
| **EXPORT** export | grep「export」全仓唯一业务面 = `server/server.js:2731-2758` `/api/export/my-media`（GET，导出当前用户 media 表元数据 JSON data-url；**仅元数据+外链，不含二进制**，注释自述 L2731）；G18 timeline API 在（`server.js:1500` 注册；`media/timelineApi.test.cjs`:13）但**无 export/render 端点**；Blender `export_frame`（`docs/product-v2/16-blender-protocol-v2.0.md:109`）为协议命令非 HTTP 面；`media_jobs.kind` 含 render（`docs/product-v2/24-community-wave-phases.md:408`）为媒体衍生作业非交付导出；UI 导出页无（V2App:133-149） | **判据缺口确认**：项目级/成片级/交付清单级导出**不存在**——G24 判据 4 现仓不满足 | **FAIL（缺口）**：先以 S10 固化为「缺口确认 + 失败凭证」，再转实现叶 G24-EXP-L1..L3 |

### 3.1 export 面实现缺口 → 叶（建议交付面）

| 叶 | 建议面 | 现有可复用 |
|---|---|---|
| G24-EXP-L1 | 项目导出 JSON（结构/脚本/计划/画布快照/run 元数据），复用 `/api/export/my-media` 的 data-url 手法（server.js:2731-2758） | projectFoundation / script / canvas persistence |
| G24-EXP-L2 | 成片/交付清单导出（media + timeline 顺序 + delivery_spec），媒体经 OSS 代理 URL（`docs/product-v2/09-api-map.md:33` 口径扩展） | G18 timeline（server.js:1500）、`oss.cjs`、delivery_spec |
| G24-EXP-L3 | timeline export 端点（G18 补位，05 spec L138 render/export 属 G18 范围） | `timelineApi.cjs`（13 用例基线） |

---

## 4. G24 验收跑单（checklist 草案，容器栈可执行）

> 执行方式: 容器栈按 `deploy/STAGING_DEPLOYMENT_PACKAGE.md:4-6`（compose 单机多实例）起；本地隔离 DB 铁律 `TEST_PG_PORT=5433 moling_test + Redis 16379`（`docs/product-v2/14-uat-plan.md:4`）；命令以 `package.json` 脚本为真实 runner（`test:all` `:18`、`test:dr` `:29`、`e2e` `:34`）。`{{BASE}}` = 容器栈公开地址占位；`{{TOKEN}}` = admin/session token。**本跑单为草案——通过前不得在 annex 记 PASS。**
>
> **Provider 占位说明（S5 前置）**: 生成执行（image_gen/video）依赖 M02-B key pool 中可用 provider key（管理面 `/api/v2/ai-control/*`，注册 `server.js:1442`；admission 域 `generation-v2/provider-admission.test.cjs`:4）。容器栈**无真实 key 时**：run 段只能跑「admission 拒绝/quote 前置」负路径并标注 `provider=占位`，正路径（真生成）转人工冒烟；goldenPathHarness 已声明无 provider 安全 dry-run（`e2e/goldenPathHarness.cjs:10-12`）。真实 provider 冒烟范围另见 `docs/product-v2/21-provider-runtime-gaps.md`。

| # | 动作 | 可执行命令 / 端点（锚） | 预期可断言输出 | 自动档 | 证据输出 |
|---|---|---|---|---|---|
| S1 | 建项目（M01-S） | `POST {{BASE}}/api/v2/projects`（分发 `server.js:2681`）；UI `{{BASE}}/__v2/projects/new`（V2App:137） | 200 + projectId；刷新后 overview 存活（`e2e/m01s-project-foundation.spec.ts:44-80`） | `npx playwright test e2e/m01s-*`（16） | projectId / e2e 日志 |
| S2 | 导入行（G13 入口；UI 叶未建，以 API 代跑） | `POST {{BASE}}/api/v2/script/rows` `{rows:[…]}`（端点契约 `scriptApi.cjs:8-13`；segments 转换纯函数 `segmentsToScriptRows.cjs`） | rows 全量回读一致；kind/speaker/timing_ms 校验通过；非法行 400 | `server/modules/script/*.test.cjs`（53+23） | rows id 列表 |
| S3 | storyboard plan + apply | `GET /api/v2/script/:sid/storyboard`（plan 视图，回 `dirty:false` 契约 scriptApi.cjs:14-24）→ `POST …/storyboard/apply`（:25-32） | `{applied:{version,shotCount,replaced}}`；二次 apply version+1；**source_trace 非空**（0053:2-8）；fingerprint 落（0054:4-25） | `storyboardPlan.test.cjs`:20 / `storyboardShots.test.cjs`:30 | version / shotCount / source_trace 样例 |
| S4 | batch + partial retry drill（NS4） | `POST …/storyboard/batch`（scriptApi.cjs:33-40）→ `GET …/batches/:batchId`（:41-42）；注入失败后 `POST …/tasks/:taskId/retry`（:46-48）与 `…/retry-failed`（:43-45） | `{batchId,enqueued,total}`；失败镜 retry → `reset:1`；成功镜 attempts 不变；非重试 → 409、缺 → 404 | `storyboardBatchPlan.test.cjs`:19 + `batchTaskStore.test.cjs`:10 | batchId / task 状态时间线 |
| S5 | run（画布执行）+ 预算断言（NS3 / MP2） | `POST /api/v2/projects/:id/studio/runs`（注册 `server.js:1649`） | 有 key: 生成节点全成功、扣费=quote；**无 key: admission 拒绝或 quote 前置拒付，零超支**（provider=占位标注） | `studioRunApi.test.cjs`:26 / quote+gate / budgetEstimate 17 | runId / attempts / 账务行 |
| S6 | 版本与锁定（NS2 / MP3/MP7） | 资产 finalize→version+1；`asset-version` 列表/恢复；`POST …/storyboard/shots/lock {shotIds,locked}`（scriptApi.cjs:49-55）；画布 PATCH 携过期 revision | locked shot 在再次 apply 后保留（0052 skippedLocked）；版本行可见（assetLibraryDrawer 契约）；过期 revision → CANVAS_REVISION_STALE 409（`tests/integration/studio-run-engine.test.cjs:98-119`） | assetVersion 5 / finalize-version 3+3 / m04s e2e 14 | 版本 id 对 / lock 状态 |
| S7 | 重开（NS5 / MP9） | rows+apply+batch 写后**硬刷新/重开项目**，再读回 | DB 读回 == 写前（rows/plan 版本/batch 进度/画布 autosave） | `npx playwright test e2e/m05c-*`（22）+ m01s（16） | 前后快照 diff=∅ |
| S8 | disaster drill（判据 2） | `npm run test:dr`（package.json:29）+ `npm run test:v2`（故障/对账档）+ `npm run test:api`；手动: pg_dump→新实例 restore→业务续跑（操作文档 `docs/operations/DISASTER_RECOVERY.md` 等，执行后补实测记录） | 全绿；restore 后读回一致；记录 run_events replay 读者缺口（23:73） | disaster-recovery 20 / v2 故障档 / distributed 24 | test 日志 + restore 记录 |
| S9 | billing audit（判据 3） | 批量跑后对账 SQL: Σ扣费 = 张数×单价；流水 == DB 聚合；`/api/admin/audit` 留痕（09-api-map:51） | 差额 = 0；每笔写留痕 | billing-transactional 7 / ledger 5 / commercial-ledger 6 / billing-chaos 7 / audit 2 | 对账 SQL 输出 |
| S10 | export 缺口确认（判据 4） | `GET {{BASE}}/api/export/my-media`（server.js:2732）→ 断言**仅 media 元数据**；项目/成片/交付导出面 grep 确认无 → **记 FAIL(缺口)** 并转 G24-EXP-L1..L3 | 仅 `/api/export/my-media` 返回 200；其它导出面 404/不存在 | （无现档——本步即凭证） | 缺口凭证（响应体 + grep 结果） |
| S11 | 汇总与 annex 写回 | 四判据逐项 PASS/FAIL/BLOCKED + NS1-5 自证表 → 由执行者写回 `moling-control/runtime/blueprint-v2/gates/G24_acceptance.json`（本文不写回） | 判据表 + 证据索引完整 | — | annex JSON diff |

### 4.1 新增叶汇总（本跑单暴露/需要）

| 叶 | 内容 | 依赖 |
|---|---|---|
| G24-UI-L1 | 首次导入向导（小说→rows→plan 直达） | S2/S3 契约 |
| G24-UI-L2 | storyboard 失败镜重试控件 | S4 |
| G24-UI-L3 | run 前 quote/成本合计确认 UI | S5 |
| G24-UI-L4 | lock 状态与影响范围 UI（跨 rows/plan/episode） | S6 |
| G24-UI-L5 | script/storyboard/video 手工编辑页 | S2/S6 |
| G24-UI-L6 | 资产版本浏览/回滚完整页 | S6 |
| G24-SRV-L1 | script_rows revision/lock 扩展（23 §2.2-1） | S6 |
| G24-SRV-L2 | 改编层 source map（原文→row） | S3 |
| G24-SRV-L3 | plan 手编受控写点（G16 回填约束，23:121） | S3 |
| G24-SRV-L4 | canvas 绑定校验接线（23:124） | S5 |
| G24-DT-L1 | 三视图域真值收口（23 §3 同步链） | S3/S5/S7 |
| G24-E2E-L1..L3 | 全链 e2e spec（S4/S2、预算、reopen） | S4/S7 |
| G24-EXP-L1..L3 | 项目/成片/timeline 导出面 | S10 |

> 叶均属 G00–G24 收尾（门内 annex 附录，`docs/product-v2/24-community-wave-phases.md:25` 规则），不并入社区波（Phase-0..4，同文档 §1）；若需跨门契约变更（如 lock 语义侵入 G06/G13/G19 契约）走对应门 annex 评审。

---

## 5. 判据汇总行（供 annex 快速落账）

```
E2E      : FAIL(缺口)/BLOCKED — 组件档齐、单一全链 spec 无；ad 分支依赖 export（堵）
DISASTER : PARTIAL — 自动故障/恢复档强(≥120 用例静态)、整栈 restore drill 未跑
BILLING  : PARTIAL — 账务内核档强、端到端对账 e2e + UI 无
EXPORT   : FAIL(缺口) — 仅 /api/export/my-media 元数据导出(server.js:2732)；项目/成片导出面不存在
NORTH    : NS2/NS3/NS4 服务面证据在(单测)；NS1/NS5 需跑单固化整链断言
```

---

## 附：计数口径与免责

- 静态计数 = `^\s*(test|it)\(` 正则行匹配（node:test 顶层 `t.test`/vitest `test/it`），扫描于 2026-09-04，非执行结果；与 runner 实际用例数可能差 ±1（嵌套/描述块未加权）。
- 本文件所有「闭/缺/未建」仅用于 overlay 规划；任何宣称 PASS 必须满足 §4 跑单执行 + annex 写回，先于执行的一切「闭」均为文件级实现/测试存在性判断。
- 证据一律优先本仓 HEAD 文件；与收编稿冲突时以 §1.1 差异表为准。
