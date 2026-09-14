# 20. G19 Agent / CLI 审计盘点

- 日期：2026-09-03
- 性质：只读审计（未改代码、未 git、未实测运行）；本文所有结论均带文件行号证据
- 验收口径：Blueprint V2.0 G19「Agent Tool API / CLI」四判据 = **tools / dry run / approval / CLI**
  （见仓库外 `/home/dministrator/moling-control/governance/blueprint-v2.0/05_ACCEPTANCE_EXECUTION_SPEC_V2.0.md:139` 与 `00_MASTER_BLUEPRINT_V2.0.md:1022`）
- 审计对象：`github_ai_online` 主仓库（`server/modules/ai-control/`、`server/admin.cjs`、`server/scripts/`、根 `scripts/`、`deploy/ecosystem.config.cjs`、`package.json`）+ 仓库外 moling-control

---

## 1. 现状矩阵

| 判据 | 已有件 | 缺口 | 建议实现路径 |
|---|---|---|---|
| **tools（工具集）** | ① ai-control 管理面 HTTP API 已成型：`routes/aiControlRoutes.cjs` PREFIX=`/api/v2/ai-control`，含 GET/POST/PATCH/DELETE providers、POST keys、PATCH setProviderEnabled 等（`aiControlRoutes.cjs:25,57-138`）；在 `server.js:2552` 挂载于旧 `/api/admin/*` 之前。② 域层能力齐全：capability/grant/health/keypool/pricing/routing/binding/status + adapter 契约（`index.cjs:14-46` 装配）。③ 一批一次性运维脚本（见 §3-A）。④ PM2 单应用部署 `deploy/ecosystem.config.cjs:11`。 | 无面向 **agent 的可调用工具面**：ai-control 全部是人工 HTTP 管理接口；无 tool registry / tool schema 向 agent 暴露「调用 providerService 写操作」的入口；无把 dispatcher 执行面包成 agent 工具的层。adapter 契约（`contracts/adapter.cjs:71`）只覆盖出站生成厂商，不覆盖入站工具。 | 在 `services/` 上加一层与 `createAdapterRegistry`（`contracts/adapter.cjs` + `index.cjs:40-45`）同构的 tool registry：把 `listProvidersForAdmin / addKey / setProviderEnabled / recordRouting` 等（`aiControlService.cjs:133`、`providerService.cjs:306`）注册为命名工具，输出统一 JSON schema，供 agent/CLI 共同调用。 |
| **dry run** | 仓库已有 **惯例但零散**：`server/scripts/dbtool.cjs`（`DRY_RUN = process.argv.includes('--dry-run')` 于 :24，deadlinks/zombies/clean-deadlinks/timeout-zombies 四子命令支持 :13-18）、`server/scripts/cleanup-dead-media.cjs:13,47-48`、`server/scripts/legacy-key-backfill.cjs:10`；根 `scripts/backup-db.cjs:71,364`、`dr-drill.cjs:54,470`、`migrate/modelhub-v3-phase1.cjs:44`、`scripts/dev/repair.sh:21`。**ai-control 模块内 0 命中**（grep -rniE 'dry.?run\|approval\|confirm' 于 `server/modules/ai-control/` 无结果）。 | ① ai-control 所有写路径（createProvider/addKey/setProviderEnabled…）无 dry-run 语义，改库即生效。② 无统一 dry-run 输出格式/退出码约定，各脚本自行 `console.log('DRY-RUN：…')`。 | ai-control service 写方法接受 `{ dryRun }` 选项：dry-run 时只计算并返回将执行的 SQL/变更 diff（复用 `repositories/aiControlRepository.cjs:180` 的写函数做 plan 分支），不落库；CLI 层统一解析 `--dry-run`。 |
| **approval** | 主仓库 **无任何 approval/requireApproval/--approve 概念**（grep `server/ scripts/ server/modules` 0 命中，唯一相近词是 `grant.cjs` 的授权域）。仓库外 moling-control 有评审决策脚本（`review-event.sh`/`review-failure.sh`、`codex-atomic-controller.py`），属「LLM 自动评审产出 decision」而非人工审批门。 | ① 管理写操作（provider 增改、key 注入、enable/disable、grant 变更）一次写入即时生效，无人工确认门。② `grant` 域是 entitlement 语义（无 grant 行 = OPEN，有行 = ENFORCED，`domain/grant.cjs:5-9`），不是「变更审批」语义。 | 新增 `pending_actions` 表 + `/api/v2/ai-control/actions/:id/approve|reject` 端点（可放 aiControlRoutes）；高风险写（addKey、setProviderEnabled=false、grant 撤销）默认入待批队列；CLI `--approve`/`--reject` 对接；或桥接 moling-control 的 review 决策流程。 |
| **CLI** | ① `package.json` **无 bin 字段（bin: null）**，无 `mlg` 类入口。② 事实上的命令面：`node server/scripts/dbtool.cjs <subcommand> [--dry-run]`（子命令 ping/stats/deadlinks/zombies/clean-deadlinks/timeout-zombies，`dbtool.cjs:10-18`）；`node scripts/{backup-db,dr-drill,restore-db,verify-backup,seed-model-hub,inject-prod-keys}.cjs`。③ 参数解析全部 ad-hoc：`process.argv.includes('--dry-run')`（无 arg parser 框架）。 | 无统一 CLI 入口；无 agent 运维子命令（看状态/派发/审批/回放）；无 `--dry-run` 全局约定；无结构化输出（JSON）选项；`server/scripts/` 与根 `scripts/` 双目录并存无路由规则。 | 新建 `server/cli/mlg.cjs` + `package.json "bin": {"mlg": "server/cli/mlg.cjs"}`；子命令 `mlg run/status/models/providers/keys/actions|approve`；全局 `--dry-run`、`--json`；详见 §4 草案（未实现）。 |

---

## 2. 基于证据的缺口清单

> grep 说明：`dry.?run` 需用 ERE（`grep -E`），BRE 下 `?` 是字面量会漏报；本审计已用 `grep -rniE` 复核。

| # | 缺口 | 文件证据 |
|---|---|---|
| G1 | **无 agent 可调用的工具 API**：ai-control 只是人工 HTTP 管理面，无工具注册/暴露层 | `routes/aiControlRoutes.cjs:25`（PREFIX /api/v2/ai-control）、`:57-138`（仅 REST 端点）；`index.cjs:40-45`（registry 仅注册 agnes 出站 adapter）；`server.js:2552`（挂载方式） |
| G2 | **ai-control 写路径零 dry-run** | `grep -rniE 'dry.?run|approval|confirm' server/modules/ai-control/` → 无输出；对比同仓 `server/scripts/dbtool.cjs:24` 有 DRY_RUN |
| G3 | **仓库零 approval 门**（写即生效；grant 域 ≠ 审批） | `grep -rniE 'approval|approve|requireApproval' server/ scripts/` → 无输出；`domain/grant.cjs:5-9`（“Grants are optional… default-deny inside the set”，纯 entitlement） |
| G4 | **无 bin / 无统一 CLI 入口** | `package.json` `bin: null`（node -e 实测 `p.bin` 为 null）；无 `mlg*`、根无 `cli*.cjs`（根仅 `fix_task_results.cjs`、`eslint.config.mjs`） |
| G5 | **CLI 命令面碎片化、参数解析 ad-hoc、无 JSON 输出** | `server/scripts/dbtool.cjs:24`、`cleanup-dead-media.cjs:13`、`scripts/backup-db.cjs:71` 各自 `process.argv.includes('--dry-run')`；`server/scripts/`（4 个）与 `scripts/`（11+ 个 .cjs）并存，`package.json` scripts 无总入口 |
| G6 | **admin.cjs 是 HTTP 后台模块，不是 CLI**，且经 server.js 注入依赖、无法独立调用 | `server/admin.cjs:1-4` 头部注释（“运营总控台…后台接口 路由：/api/admin/*…依赖（由 server.js 注入）”）、`:13-27`（createAdmin(ctx) 需 getPg/session/sendJSON 等） |
| G7 | **无 PM2 进程级运维 CLI**；ecosystem 仅 1 应用且无 pm2 依赖声明 | `deploy/ecosystem.config.cjs:1-11`（name: ai-image-studio, script: server/server.js）；`package.json` 无 pm2 依赖 |
| G8 | **dbtool 是唯一带子命令+干跑的工具**，但作用域仅 DB 诊断/修复，不覆盖 ai-control | `server/scripts/dbtool.cjs:10-18`（子命令清单全部是 deadlinks/zombies/clean 类） |
| G9 | **moling-control 无代码仓 CLI**：是编排控制面（governance/state/tasks/decisions），脚本为 .sh/.py 且无 package.json/bin；其 approval 是 LLM review 非人工审批 | `ls /home/dministrator/moling-control`（无 package.json）；`scripts/review-event.sh:1-30`（产出 decision json）；`tools/` 仅 3 个快照/进度脚本 |

---

## 3. 现状快照（证据摘要）

### A. ai-control 模块结构与导出（`server/modules/ai-control/`，全 .cjs）

- `index.cjs:14-46` 装配 domain(7) + contracts + repositories + services(2) + routes + adapters；`:47` 导出 `{domain, contracts, repositories, services, routes, adapters, createAdapterRegistry}`
- `domain/`：capability（CAPABILITY_TYPES/MODALITIES/PARAM_TYPES/validate/merge/satisfies，`capability.cjs:185`）、grant（GRANT_STATUSES/validate/toGrant/hasCapability/resolveEffectiveCapabilities，`grant.cjs:122`）、health（HEALTH_STATES/deriveHealth，`health.cjs:64`）、keypool（maskKey/fingerprint/keyMetadata/redactCredentialFields，`keypool.cjs:97`）、pricing（quoteGeneration/quoteForUser/assertAdminProjection，`pricing.cjs:63`）、routing（newDecisionId/toRoutingDecision，`routing.cjs:72`）、routing-policy（POLICY_STATUSES/resolveRouting，`routing-policy.cjs:92`）、status（JOB_STATES/normalizeStatus/isTerminal，`status.cjs:67`）、binding/revision/modelRegistry（`modelRegistry.cjs:43`）
- `repositories/aiControlRepository.cjs:180`：listProviders/getProvider/attachKeyPool/listLogicalModels/upsertModelCapability/recordRoutingDecision/upsertProviderHealth/getProviderHealth
- `services/aiControlService.cjs:133`：isViewerAdmin/listProvidersForAdmin/getProviderForAdmin/listModelsForUser/listCapabilities/quoteForViewer/recordRouting（recordRouting = 路由决策审计落库）
- `services/providerService.cjs:306`：classifyCredentialSource/createProvider/updateProvider/setProviderEnabled/addKey(s)/updateKeyMetadata/deleteKey/setKeyCooldown
- `contracts/adapter.cjs:71`：REQUIRED_METHODS/assertAdapterContract/createAdapterRegistry（出站厂商契约）
- `adapters/agnes.cjs:146`：createAgnesAdapter/AGNES_STATUS_MAP（唯一已注册 adapter）

### B. server/admin.cjs 是什么

HTTP 运营总控台/全局智能体层后台模块（47KB）：路由 `/api/admin/*`（用户管理/手动充值/积分流水/agents·providers·rules）+ SSE `/api/admin/console/stream`；依赖 getPg/session/sendJSON/… 由 `server.js:1424` 注入（`server.js:79` import、`server.js:1424` createAdmin）——**非 CLI、非独立可执行**。

### C. CLI 相关现状

- `package.json`：bin=null；scripts 含 db:migrate*/backup:db/restore:db/dr:test/seed 等 npm 别名，无 agent 子命令
- `server/scripts/`：cleanup-dead-media.cjs、dbtool.cjs、legacy-key-backfill.cjs、repair-base64-media.cjs
- 根 `scripts/`：backup-db / check-server-syntax / dr-drill / inject-prod-keys / quality-gate / restore-db / seed-*（bindings/easypay/model-hub）/ staging-sse-d20-d21 / verify-backup（.cjs）+ admin/ dev/ migrate/ 子目录
- `deploy/ecosystem.config.cjs`：PM2 单应用 `ai-image-studio`（fork、instances:1、max_memory_restart 1G）
- moling-control：无 package.json/bin；scripts/*.sh|*.py（control-loop.sh、codex-atomic-controller.py、review-*.sh 等）；含 approval 类 LLM 评审脚本（review-event.sh）

---

## 4. 建议 CLI 命令面草案（⚠️ 未实现，纯草案）

入口：`server/cli/mlg.cjs`，`package.json` 增 `"bin": { "mlg": "server/cli/mlg.cjs" }`（当前 bin:null，见 G4）。

```text
mlg run <generation-request.json> [--dry-run] [--approve] [--json]
      # 向 dispatcher/执行面派发一次生成；--dry-run 只出报价+路由决策不派发
      # --approve 跳过待批队列直接执行（配合 pending_actions 审批流）
mlg status [--task-id <id>] [--json]
      # 任务/工单状态（JOB_STATES 语义，domain/status.cjs）
mlg models ls | inspect <id>        # listModelsForUser / capability 视图
mlg providers ls | show <id>        # listProvidersForAdmin（key 脱敏，keypool.redact）
mlg providers enable|disable <id> [--dry-run] [--approve]
mlg keys add <provider> <key...> [--dry-run] [--approve]   # addKeysBatch + setKeyCooldown
mlg keys rm <keyId> [--dry-run] [--approve]
mlg actions ls | approve <id> | reject <id>   # pending_actions 审批（G3 新增物）
mlg audit routing --since <ts>      # recordRouting 审计回放（aiControlService.recordRouting 已落库）
全局：--dry-run（只计划不写）、--approve（跳过审批）、--json（结构化输出）、--env prod
```

现状中**唯一可作为 CLI 原型借鉴**的是 `server/scripts/dbtool.cjs`（子命令 + --dry-run + 幂等，`dbtool.cjs:10-24`）；ai-control service 层（§3-A）已具备 CLI 可直接调用的全部纯函数，无需重写域逻辑。

---

## 5. 结论（一页）

- 主仓库已有：HTTP 管理 API（/api/v2/ai-control + /api/admin）、完整 ai-control 域/服务层、零散 --dry-run 运维脚本、PM2 部署、dbtool 子命令雏形。
- 主仓库缺：agent 工具暴露层（tools）、ai-control 写路径 dry-run、任何人工 approval 门、统一 CLI（bin/mlg）。
- 与 Blueprint G19 四判据比对：**tools 半有（HTTP 无 agent 面）、dry run 半有（运维脚本有、ai-control 无）、approval 无、CLI 无（仅雏形）**。
- 实现路径不涉及重写：复用 ai-control service/repository 纯函数 + adapter-registry 同构工具注册 + dbtool 式 CLI 骨架即可补齐。
