# 21. Provider 运行时缺口盘点（G10 推进文档）

- 日期：2026-09-04
- 性质：只读盘点 + 测试实测（未改代码、未 git、未 ssh）
- 范围：`server/providers/`（真视频层）、V1 dispatcher 内联 image/video 执行链、generation-v2（V2 worker 真链）、modelhub / generation-entry / ai-control 相关适配层
- 测试证据：本机实测 2 批 `node --test`，**133/133 通过**（见 §4）；PG/Redis 依赖套件因本环境无 PG role（`dministrator` 不存在）且无 redis **未跑**（如实标注，未虚报）

---

## 1. Provider 家族总览（实测目录清单）

| 家族 | 代码位置 | 形态 | 运行时是否接线 | 测试文件 |
|---|---|---|---|---|
| **video（真视频层）** | `server/providers/video/`（agnes/minimax/volcano + shared + index 路由） | 独立适配器层（submit/poll 拆分，崩溃恢复续轮询） | ✅ 接线：dispatcher.videoGenerate（V1）+ generation-v2 reconciler/provider-status-router（V2）+ ai-control agnes adapter（复用 buildAgnesVars） | ❌ 目录内 **0 个** test 文件（间接覆盖见 §2） |
| **image** | `server/dispatcher.cjs` `imageGenerate()`（内联，~90 行）+ `resolveEndpoint`/`extractImages`/`bumpSize`/`isGptImageModel` | **无独立适配器层**，DB 配置驱动 + 内联分支 | ✅ 接线：server.js `/api/generate` → `dispatcher.generateAsync` → `generate` → `dispatchOne` → `attemptOnAccount` → `imageGenerate`（`server/server.js:3536,3652`；`server/dispatcher.cjs:612-682`）；generation-v2 worker 亦经 `dispatcher.generate`（`entry.cjs` → `production-adapters.cjs:19-23`） | ❌ `imageGenerate`/`attemptOnAccount`/`dispatchOne` **0 直接测试**（全仓 grep *.test.cjs 仅注释命中 `dispatcher.routing.test.cjs:85`） |
| **audio** | 无 | — | ❌ 不存在。`content_type` CHECK 仅 `('image','video')`（`server/modules/generation-v2/schema.cjs:11`）；`server/dispatcher.cjs` / generation-* 全域 grep audio 无 provider 链 | — |
| W3 编译适配层（image+video 死代码） | `server/modules/modelhub/providerAdapter.cjs`（adaptImage/adaptVideo，支持 amper/kling/genmo/openai/genny） | 纯函数，V1 已有能力分支 | ❌ 死代码：**无任何非测试生产 require**（grep 全仓仅自身 + 自身 test 命中） | ✅ `providerAdapter.test.cjs`（9 tests，实测通过） |
| V1 facade（image/video 意图层死代码） | `server/modules/generation-entry/generationFacade.cjs`（generateInit：prompt-ir → routeDecision → quote → reserve） | 纯函数编排 | ❌ 死代码：仅 `generationFacade.test.cjs` 引用；同模块其余 4 文件亦无外部生产引用 | ✅ 5 文件共 25 tests（实测通过） |
| M02 ai-control adapter（video-only contract proof） | `server/modules/ai-control/adapters/agnes.cjs`（createAgnesAdapter，复用 `providers/video/agnes.cjs` 的 buildAgnesVars/resolveAgnesEndpoint，注入 transport） | 契约化 adapter（validate/normalizeInput/submit/poll/cancel/状态归一/错误码） | ⚠️ 半接线：`createAdapterRegistry` 注册（ai-control 域），但 adapter 仅被**自身测试**调用；运行时不消费（dispatcher 不走 ai-control） | ✅ `agnes.test.cjs`（11 tests，fake transport 零付费，实测通过） |
| 前端视频模型配置草稿 | `src/data/modelConfigs/`（16 个：agnes/cogvideox/firefly/hunyuanvideo/kling/luma/minimax/pika/runway/seedance/sora/svd/veo/vidu/wan + schema） | TS 草稿配置 | ❌ 头部自声明「⚠️ 草稿模块，尚未并入生产」（如 kling.ts:2-7）；仅前端展示/未来接线素材 | 无测试 |

---

## 2. Video 家族明细（server/providers/video/）

| adapter | 文件 | 能力（实测读码） | 状态归一/轮询 | 生产引用点 | 测试存在性与实测 |
|---|---|---|---|---|---|
| **agnes** | `agnes.cjs` (145 行) | t2v + i2v（`ti2vid`）+ 关键帧动画（`keyframes`，多图 extra_body）；num_frames=8n+1≤441、frame_rate 25、ratio→尺寸映射（`shared.agnesVideoSize`）、negative_prompt；submit/poll 拆分子端点（默认 `POST {base}/videos`、`GET {origin}/agnesapi?video_id=`，可被 model.endpoint 覆盖） | canonical success/failed/pending + **terminal failed** 区分；自适应轮询 | ① `dispatcher.cjs:6,334-361`（videoRouter.submit/poll）② `provider-status-router.cjs:178`（queryAgnesStatus，require 直取 resolveAgnesEndpoint）③ `ai-control/adapters/agnes.cjs`（复用构建/端点） | 无目录内测试。**间接证据**：agnes.test.cjs 11 tests（byte-identical wire body 证明，fake transport）✅实测 11/11；reconciliation.test.cjs 26 tests ⛔未跑（需 PG） |
| **minimax** | `minimax.cjs` (98 行) | MiniMax H3（Hailuo-03）：content[] 多模态、resolution 枚举映射 768P/2K、duration 4..15、ratio t2v 必填/图生恒 adaptive、结果 `task.content.url`；submit `POST {base}/video_generation`、poll `GET {base}/query/video_generation/{id}` | 同上 | ① `dispatcher.cjs:6,334-361` ② `provider-status-router.cjs:222`（queryMiniMaxStatus） | 无目录内测试；无 byte-identical 证明（不像 agnes 有 M02 镜像）。reconciliation.test.cjs（含 minimax 用例）⛔未跑 |
| **volcano** | `volcano.cjs` (134 行) | Seedance 全系：分辨率枚举 480p..4k 映射、**时长按系列规则**（2.5:[4,30] 智能 -1 / 2.0:[4,15] / 1.5:[4,12] / 1.0:[2,12] 不支持 -1）、Seedance 2.5 图生强制 adaptive、content[] role 词汇（image_url.url 嵌套）；submit `POST {base}/contents/generations/tasks`、poll `GET .../tasks/{id}` | 同上 | ① `dispatcher.cjs:6,334-361` ② `provider-status-router.cjs:259`（queryVolcanoStatus） | 无目录内测试。reconciliation.test.cjs（含 volcano 用例）⛔未跑 |
| **generic（内联兜底）** | `dispatcher.cjs` videoGenerate 内联分支 (:362-447) + `genericVideoPoll` (:429-454) | openai-compatible / custom bodyTemplate 异步端点；async 标记判定；taskIdPath/taskStatusPath/taskResultPath/taskQueryParam 配置驱动；90 分钟安全线 | 同轮询语义但**手写循环**（与 shared.pollLoop 平行实现，行为靠注释对齐） | `dispatcher.cjs` 自身（V1）；provider-status-router 对 generic 显式 `RECONCILIATION_NOT_SUPPORTED`（`provider-status-router.cjs:309-315`） | ❌ 0 测试（含崩溃恢复 resume 路径）；**双实现漂移风险**（shared.pollLoop vs 内联 while） |
| **shared** | `shared.cjs` (228 行) | fillTemplate/getByPath/callEndpoint/fetchJson/resolveEndpoint/makeError/agnesVideoSize/deriveVideoMode/buildVideoContent/normalizeVideoStatus/**pollLoop**（自适应密度 + 取消信号 + 90min 安全线返 timeout 非 error + terminal failed 语义） | 被各 adapter.submit/poll 与 dispatcher 消费 | dispatcher `:7`、provider-status-router `:22`、ai-control adapters | 无目录内测试；pollLoop 语义靠上层测试间接覆盖（generation-v2 fake 链） |
| **index** | `index.cjs` (50 行) | 路由：`model.endpoint.videoAdapter` > base_url 正则（agnes-ai.cn/minimax/volces·ark·volcano）> generic；导出 adapters/resolveKey/submit/poll/submitAndPoll | — | dispatcher `:6`、provider-status-router `:23` | 无目录内测试 |

### Video 链生产接线（谁引用谁，实测 grep）

```
V1 同步链：  server.js /api/generate ─> dispatcher.generateAsync ─> generate ─> dispatchOne
               └> attemptOnAccount（contentType==='video' ? videoGenerate : imageGenerate）
                     └> videoRouter.submit（拿 providerTaskId → onSubmitted 持久化）→ videoRouter.poll（取消信号= cancelledTasks）
V2 worker：   generation-v2/entry.cjs（docker-compose profile `generation-v2`，production-gate 需 evidence 文件）
               └> createProductionAdapters.dispatchSingle ─> dispatcher.generate（复刻 V1 同一条链）
               └> reconciler.resolveReconcilingItem ─> provider-status-router.queryProviderStatus（30s 单查，UNKNOWN 不判 FAILED，NOT_FOUND 不盲目重提）
                    └> queryAgnesStatus/queryMiniMaxStatus/queryVolcanoStatus（各自独立 HTTP 查询实现，与 adapter.poll 平行）
M02 管理面：  ai-control createAgnesAdapter（仅视频 agnes）——运行时不消费，契约证明件
```

---

## 3. Image 家族明细（V1 dispatcher 内联链）

| 能力分支 | 判定 | 实现位置 | 说明 |
|---|---|---|---|
| OpenAI GPT-Image 系 | `isGptImageModel`（upstream/model_id 含 gpt-image） | `dispatcher.cjs:235-240, 255-256` | size 枚举（auto/1024x1024/1536x1024/1024x1536），**不**传 ratio/resolution/negative_prompt（官方忽略且中转可能 4xx） |
| Agnes 图 | base_url 含 agnes-ai.cn | `:244-247, 266-268, 277-282` | sizeFormat='agnes'（resolution 档位字符串）；img2img/多图合成 → `extra_body.image`（另有顶层 images 兼容 relay） |
| 标准 OpenAI 兼容 / 自定义 | default | `:220-296` | POST `{base}/images/generations`；ratio→size 表（RATIO_TO_SIZE 1792x1024 等）+ resolution 倍增（1k/2k/4k/8k）；negative_prompt；n 1..4 |
| custom protocol 端点 | protocol==='custom' | `:292-301` | callEndpoint + bodyTemplate，extractImages 解析 |
| 多 Key/配额/重试 | — | `:77-147` key pool、`:527-611` 配额桶、attemptOnAccount 账号轮换 | image 与 video 共享，DB 配置驱动（providers/models/provider_model_bindings 表，ai-control `/api/v2/ai-control/*` 管理面 CRUD） |

**image 生产引用点**：`server/server.js:3536-3652`（`/api/generate` + `generateAsync`）与 `generation-v2/entry.cjs`（V2 dispatchSingle）。**无其它 image 适配器文件存在**——所有厂商差异都在 `imageGenerate` 一个函数内以 `if` 分支表达。

---

## 4. 测试实测证据（本机 node v22.23.2，真实跑出）

> 命令：`node --test --test-concurrency=4 <files>`，输出全量存 `/tmp/provider-tests-1.log`（68）与 `/tmp/provider-tests-2.log`（65）。

**批 1（适配层/契约/意图层，68/68 通过）**
`server/dispatcher.routing.test.cjs` 14 · `server/modules/modelhub/providerAdapter.test.cjs` 9 · `server/modules/ai-control/adapters/agnes.test.cjs` 11 · `server/modules/generation-v2/provider-adapter.test.cjs` 6 · `.../production-adapters.test.cjs` 3 · `server/modules/generation-entry/{generationFacade 4, generationGate 6, quoteService 6, shotGenerationHistory 4, shotSpend 5}` 25 → **68 pass / 0 fail / 0 skip**

**批 2（V2 provider 执行链 + 故障 + shadow，65/65 通过）**
`fault-injection 23` · `videoEdit 11` · `pipeline 6` · `generation-worker 5` · `reconciler 5` · `no-blind-resubmit 4` · `shadow 4` · `shadow-audit 3` · `productReconciler 3` · `server-shadow-integration 1` → **65 pass / 0 fail / 0 skip**

**未跑（如实）：** generation-v2 PG/Redis 依赖套件 **81 tests**（`reconciliation 26`（provider-status-router 唯一覆盖处）、`failure-scenarios 9`、`lease-fencing-pg 9`、`key-lease 8`、`billing-chaos 7`、`runtime 3`、`production-gate 3`、`provider-admission 4`、`oss-failure 4`、`redis-failure 4`、`worker-daemon 4`）——本环境 PG socket 拒绝 role `dministrator`、无 redis，**未伪造结果**。

**直接覆盖率黑洞（全仓 grep 实证）：** `imageGenerate` / `videoGenerate` / `attemptOnAccount` / `dispatchOne` / `generateAsync` / `resumeRunningTasks` 在全部 `*.test.cjs` 中**零直接调用**（唯一命中是注释 `dispatcher.routing.test.cjs:85`）；`server/providers/video/` 内 0 个测试文件。

---

## 5. 结论段

### 5.1 Image T2I 真链改造点：dispatcher 直连（维持），勿走 facade

- **现状真链**：`server.js /api/generate → dispatcher.generateAsync → dispatchOne → imageGenerate`——这是唯一被生产消费的 image 运行时路径；generation-v2 worker 也复刻同一条链（dispatchSingle → dispatcher.generate）。DB 配置（providers/models/bindings）已把「加新图像厂商」降为「配 endpoint + 内联分支」，多家厂商差异（GPT-Image/Agnes/自定义）已在一个函数内被处理。
- **facade 挂接 = 死代码复活路线，成本高且无收益**：`generationFacade.generateInit`（prompt-ir → routeDecision → quote → reserve）与 `modelhub/providerAdapter.adaptImage` 均无任何非测试生产引用；adaptImage 的 SUPPORTED_PROVIDERS（amper/kling/genmo/openai/genny）与 V1 实际 image 链路（DB 配置任意 base_url + 分支）**不匹配**——把它们接进真链需要重写适配面而不是复用。
- **T2I 波（G11）改造点**（按风险排序）：
  1. **抽 `server/providers/image/`**，与 `providers/video/` 同构：把 `imageGenerate` 的厂商分支抽成薄 adapter（`openai-compatible` 默认、`agnes-image`、`gpt-image`、`custom`），`dispatcher.imageGenerate` 变薄路由——消除单函数 if-树，为「每厂商字节级 wire 测试」铺路。
  2. **为 dispatcher 执行面补直接单测**（当前 0）：imageGenerate 各厂商分支用 fake fetch/callEndpoint（对齐 `ai-control/adapters/agnes.test.cjs` 的 fake-transport + byte-identical 模式）。
  3. 若 T2I 需要「多图合成 / negative / i2i」语义规范化，把 `shared.cjs` 同款 canonical（VideoTask 同构的 ImageTask）引入 image adapter 层，再由 dispatcher 收编。
  4. facade/W3 层：保留为**文档性意图层**即可，G11 前**不要**接线（先删引用误判风险为零，因其本无生产引用）。

### 5.2 Video 运行时证据待办清单（按证据缺口定序）

| # | 待办 | 当前缺口证据 | 对应波 |
|---|---|---|---|
| V1 | **providers/video/ 自家单测**：为 minimax/volcano（及 shared.pollLoop、index.resolveKey、agnes 余下路径）补 fake-transport 测试，对齐 agnes 已有的 byte-identical proof（`agnes.test.cjs` 11 tests 是唯一现成模板） | `server/providers/video/` 0 测试文件；minimax/volcano 无任何等价于 agnes.test 的镜像证明 | G10 |
| V2 | **provider-status-router 去 PG 化单测**：目前 agnes/minimax/volcano 三个 status query 只被 reconciliation.test.cjs（需 PG）覆盖；补 fake-pg + fake-fetch 的独立 `provider-status-router.test.cjs` | reconciliation.test.cjs 26 tests ⛔本环境未跑；router 无独立 test 文件 | G10 |
| V3 | **generic 双实现消歧**：dispatcher 内联 video 轮询（`videoGenerate` generic 分支 + `genericVideoPoll`）与 shared.pollLoop 平行实现、仅注释对齐——补统一契约测试或收敛到 pollLoop；generic 状态查询对 reconciler 显式不支持（`RECONCILIATION_NOT_SUPPORTED`），需决策「补齐 poll 端点查询 or 标注为不可调和对账」 | 内联分支 0 测试；`provider-status-router.cjs:309-315` | G10/G11 |
| V4 | **dispatcher 执行面（video 分支）直接测试**：attemptOnAccount video→videoGenerate 路径、onSubmitted 持久化回调、canceled 信号、timeout 非终态 | 全仓 0 直接调用（§4 黑洞） | G11 |
| V5 | **真上游 smoke / mock upstream e2e**：providers/video → dispatcher 全链对着 fake upstream HTTP（非 DB 层 fake）跑通 submit→poll→终态；Agnes 已有 adapter 契约证明但缺「dispatcher 级」证据 | 现仅 ai-control fake-transport 层证明；generation-v2 的 fake 链在 providerGenerate 之上、不穿 providers/video 真实 HTTP 构造 | G11 |
| V6 | **generation-v2 production gate 证据补齐**（V2 worker 上线的硬门，`runtime.cjs` gate 阻塞启动）：unitPass / migration / **pgIntegration（含 reconciliation 26 绿灯）** / shadowAudit 全一致 / chaos（workerKill+redisRestart+provider429）/ load SLO（p95≤300ms、dup=0、ledgerMismatch=0、queue≤1200s）/ secrets / dependencies / observability | `docker-compose.yml:69-99`（profile generation-v2，evidence 只读挂载 `deploy/generation-v2/`）；`production-gate.cjs:3-18` 九项 blocker | G11 验收 |

### 5.3 G09/G10/G11 Provider 波定序建议

- **G09（本波已覆盖）**：盘点 + 架构判定（本文档）——已交付：真链 = dispatcher 直连（image）+ providers/video（video）；facade/adaptImage 确认死代码勿接。
- **G10（Provider 适配层硬化）**：V1（video adapter 自家单测）→ V2（provider-status-router 独立单测）→ V3（generic 收敛）；同时**抽 providers/image/** 并补 imageGenerate 分支测试（与 V1/V2 无依赖冲突，可并行）。验收口径 = providers/video 每 adapter ≥1 个 fake-transport 测试文件、provider-status-router 无 PG 可测、image 家族不再零覆盖。
- **G11（运行时真链证据）**：V4 → V5 → V6：dispatcher 执行面直接测试 → mock-upstream e2e → production-gate 九项证据（需 PG/Redis/压测环境，本机不可复现，须在部署环境执行）。**波序依赖**：G10 的测试基建是 G11 证据的载体；V6 的 pgIntegration 与 chaos 项必须在有 PG/Redis 的测试环境跑 reconciliation 26 + lease/redis 套件（本环境 81 个未跑项清单即该环境的验收清单）。

---
*证据文件：/tmp/provider-tests-1.log、/tmp/provider-tests-2.log（全量输出）。所有表格行均出自上表所列文件路径 + 实测运行，未声称未实测内容。*
