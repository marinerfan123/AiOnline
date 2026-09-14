# 墨灵AI 制作宪法

> Constitution of Moling AI  
> 版本 1.0 · 2026-09-02  
> 本文件是墨灵AI项目（Moling AI）的根本法，为技术开发、生产运维、变更治理与认证纪律设立不可违背的最高准则。任何功能、重构、部署、排查与汇报都须在此框架内进行。与下文冲突的做法一律无效。

---

## 序言 · 项目定位与北极星

墨灵AI 是用户长期在做的生产级 AI 创作平台，覆盖文生图 / 图生图 / 文生视频 / 图生视频 / 文本推理，并含电商商城、模型 Hub、创作工作室 Studio（M5 流水线）、充值、管理后台等模块。

**北极星（Polaris）：**
1. **商业化运行**——一切设计与改动服务于真实商用交付，而非 demo 或测试。
2. **按 1000 人同时在线设计**——容量、并发、账务、限流、任务调度均以 1000 并发在线为设计基准。
3. **生产可用性优先**——不因保守而停工，也不以停工换安全；保持服务可用并主攻质量与进度。

**同一本宪法服务两条主线：**
- **生产维护线**：保持线上（`8.148.68.47`，`tv.moling.fun`）稳定运行；
- **商业化 V2 演进线**：按 TDD、影子双写、灰度迁移稳步推进新一代生成链路。

---

## 第一章 总纲（不可违背）

1. **数据即真相**。PostgreSQL 是任务 / 状态 / 账务的唯一真相源；Redis 仅做限流、租约、唤醒与 SSE。代码真相源是**运行中的生产容器**，不是本地 /opt 工作树，更不是过时的本地副本。
2. **线上代码 = 唯一真相源**。本地 `E:/code` 已过时，禁止作为改动依据；改前先拉取容器内 `/app/server` 作比对。
3. **生产异步任务全链路核对**。判定生成故障（成功/失败/超时/卡死）前，必须核对 生成 → 等待 → 上传 → 终态 → 账务 全链路证据；**禁止凭表面状态提前判失败或强制收尾**。
4. **禁止停生产换保守**。商业重写采用影子写 / 热开关 / 独立 worker 灰度；不得为了配置灰度主动停生产。
5. **修改前先修复认知**。任何改动必须先完成全链路诊断，定位根因，再动手——**禁止看到表象就打补丁**。

---

## 第二章 修复方法论（从头到尾）

> 用户原话：「修问题要从头到尾来处理，不要哪里错就修哪里。」

**固定六步流程（每一例必执行）：**
1. **确定现象**——用户报告的是什么错误/异常，精确到现象复现。
2. **追踪全链路**——前端 UI → API 端点 → 服务端处理 → 数据库状态 → 外部调用，逐层验证每一环的实际行为与数据。
3. **定位根因**——找到整条链路上真正失效的点，不是最靠近表象的点。
4. **关联所有相关代码**——改一点前，搜索并审查所有调用 / 引用 / 依赖该点的代码，确保修复覆盖完整。
5. **一次完整修复**——把整条链路上的相关问题一并修复，不是「哪里报错修哪里」。
6. **验证整条链路**——从入口到终点完整验证，不只验证报错的那一环。

**反面案例（密钥池显示 0）**：不能只加 `apiKeys` 查询就完事——必须从前端 `ModelHubPage.getKeys()` → `apiGetProviders()` → `GET /api/providers` → 发现 `maskKey` 语法错误，同时修复两个问题并部署验证。只修一处是半成品。

**修改语法**：系统/接口/状态命名一处为准，全项目统一（例：任务状态统一 `canceled` 一个 l，前端判断必须写 `canceled`，否则永远匹配不上）。

---

## 第三章 开发纪律（血泪教训，最高优先级）

### 3.1 重大架构重写前置门禁
- 重写前先把生产与 GitHub main 关键文件哈希对账，**创建不可变备份 tag**（`tag 只新建、不移动`）。
- 从**独立分支**实施，**禁止直接替换生产链路**。
- 不在未做蓝绿 / 影子切换前仅为一个 env 执行 `docker compose up --force-recreate app`（会丢失所有 `docker cp` 热部署层并造成真实停机）。

### 3.2 新技术落地纪律
- 新行为**严格 TDD**：先见 RED 再 GREEN；先写测试再写实现。
- 生产改造采用**影子双写 + feature flag 灰度**，从 1% 灰度逐步到 100%。
- 会触发容器 recreate 的环境变量不适合作为频繁灰度开关；百分比优先放入 DB settings / Redis 热配置。

### 3.3 认证与证据纪律（禁止无证据宣称）
- 禁止无执行证据宣称 PASS / pre-existing；**必须同环境 baseline 对比**。
- 不确定就标 `NOT_CERTIFIED / NEEDS_INVESTIGATION / NOT_VERIFIED`，**不得乐观推断**。
- 同一方法失败 3 次或 20 分钟无新证据 → **停循环**，写 `BLOCKER / ROOT_CAUSE / ATTEMPTS / NEXT_SAFE_APPROACH`。
- 长时间任务用户喊停时**只存 checkpoint，不继续**。
- **不自动 commit 未验证的实验代码**；`tag 只新建、不移动`。

### 3.4 生产就绪判定分级（禁止用「测试绿」冒充「可生产」）
对每个执行环节分别标记证据等级，**只有后两级通过**才可称「经得起生产部署」：
- `单元级`：只证明局部契约，不证明真实 PG/Redis/Agnes/OSS 竞争安全。
- `影子观测级`：只证明镜像结构/数量/金额映射，不证明能实际执行。
- `真实集成级`：证明真实执行、上传、结算闭环。
- `故障演练级`：kill worker、429/超时、并发、Redis/PG 故障注入通过。
- `生产灰度级`：真实流量灰度无回归。

**汇报格式**：环节 / 当前证据 / 是否可执行灰度 / 阻断项。不得用总测试数替代生产证据，也不得因 healthz 正常就推断业务链路就绪。

---

## 第四章 生产变更管理

### 4.1 部署铁律（最高优先级）
1. `moling-app-1` 的 `Mounts=[]`，运行文件系统是镜像层 `/app/server/`。改生产代码必须 `docker cp <file> moling-app-1:/app/server/<file>`；SFTP 到 `/opt/moling/` **不生效**（误导路径）。
2. 安全流程：`docker cp` 出旧文件到 `/tmp/bak` 备份 → 本地转 LF → `docker cp` 进容器 → restart → `docker exec` 读回校验（hash/关键串）。
3. 覆盖前必须 `diff` 比对（本地 vs 容器当前），确认无容器独有改动被冲掉。
4. 前端静态部署：`vite build` → `/tmp/staging` → 主机侧 `docker cp <staging> moling-app-1:/app/dist/build2`（无需重启）→ 校验容器内主 JS hash 与本地一致；按 index.html 引用白名单清理孤儿 chunk。
5. `JWT_SECRET` 必须原样传入（改动则全站 token 失效）。
6. Redis `--restart unless-stopped` 必须放镜像名之前。
7. 部署后必须验证：healthz + 启动日志（含 `[cpuMonitor] 已启动`、`[uploadQueue] 后台上传 worker 已启动`）+ 容器内实际 bundle，不能只看「上传成功」。

### 4.2 compose 重建前置门禁（曾造成真实停机）
执行 `--force-recreate` 前必须：
1. 运行容器 `/app/server` 与 GitHub / `/opt/moling` 全目录漂移对账，**不只核对 3 个文件**（`docker cp` 热部署层会丢）。
2. 核对 Dockerfile `COPY server ./server` 所需模块完整（如 `cpuMonitor.cjs`），并从准确源码构建。
3. 对比当前容器有效 PG/JWT/Redis 配置与 compose/.env；数据卷中的真实角色密码不能靠容器初始化 env 推断。
4. 先构建并做启动检查，再切换。
5. 重建后再次核对关键文件 hash、V2 modules、healthz、workspace、启动日志。

### 4.3 数据库迁移纪律
- **先 replica 验证，再动真库**：`pg_dump -Fc` 全库 → 本地 `pg_restore` 到 replica → replica 先 `CREATE ROLE moling LOGIN` + `CREATE DATABASE X OWNER moling`（否则 sequence ownership 报错）→ 全量迁移全绿 → 才动真库。
- **forward-only / expand-first / backward-compatible / idempotent**；不改已进历史的旧 migration。
- 一次性 recon（如 `*_pre_v1` 改名、signup-bonus ref 改 per-user）必须独立成 SQL 并保存备份，且证明与编号迁移链不冲突。
- 迁移在容器内跑（host 无 node）：`docker exec -e ... moling-app-1 node /tmp/migdb/runmig.cjs`，migrate 命令行读标准 `PG*` 环境变量。
- 真库迁移前**必须**确认 schema 分叉（旧 inline-DDL 时代表 vs 迁移链 schema），不依赖 `CREATE IF NOT EXISTS` 兜底——旧表列集不同会直接 FAIL。

### 4.4 迁移 / 回滚前必须备份
- 备份目录 `/opt/moling-backups/<pre-...-TS>/`：`pg_dump -Fc` + `sha256` + `.env`(600) + nginx conf + compose + containers.json + **ROLLBACK.md**。
- 旧栈保留不删，回滚 = 恢复 nginx conf + `docker start moling-app-1`（旧代码 无 schema_migrations 硬退出、DDL 全 IF NOT EXISTS，迁移后 DB 可启动）。

### 4.5 切换时序 runbook（可复用）
1. 全量备份（含 ROLLBACK.md）。
2. recon + 迁移（先 replica 再真库）。
3. 本地 build image → `docker save | ssh docker load` → 新 compose up api-01/02（worker 关）→ readiness 200×2 + 启动日志无 missing-table。
4. pre-cutover smoke：admin login + 1 张真实生成（核对 provider_url 持久化 + 计费）。
5. nginx：写新 upstream conf → `nginx -t` → `nginx -s reload`（graceful）。
6. `docker stop moling-app-1`（防双 worker 抢队）。
7. `up worker-01 worker-02` → PG 查 `generation_worker_heartbeats_v2` 两个 worker_id 新鲜。
8. post-cutover：公网域 readiness/home/login/SSE（`/api/generate/stream`，**不是** `/api/events`）+ 1 张真实生成。
9. 30min 观察（≥6 轮，每 5min）：5xx=0、queued=0、heartbeat=2、无 error 日志。
10. 旧栈保留不删，备份保留。

---

## 第五章 可靠性不变量（技术必须保持的约束）

1. **按张计费契约**：图片总价 = 单张价格 × `clamp(count,1,4)`；视频固定 ×1。后端必须在 `resolvePayment` / `reserveCredits` 前同时放大充值价和赠送价；前端余额预检与价格徽章使用同一 `batchCount`。只修 UI 不算修复。
2. **多 key 并发聚合容量**：并发闸须按 `perKeyCap × activeKeyCount` 聚合；路由预门控 `snapshotAcct` 和执行层 `attemptOnAccount` 必须用**同一聚合容量**（475-key 池不能因 `max_concurrent=1` 被误判总并发为 1）。
3. **选 key 竞态**：`attemptOnAccount` 里 `selKey.conc += 1` 必须**同步原子占位**——紧跟 `pickKey` 且在 `await acquireRateLimitSlots` 之前；无 key/未获槽必须回滚 `conc-1`。
4. **等待区相互唤醒**：`finally` 释放 `waitingPumpRunning=false` 后复查 `WAITING_AREA`，非空用 `queueMicrotask` 重启，防丢唤醒；retry/maxretry **两处**都要先查 task done / 同 ref commit / `asset_upload_jobs`，命中即移除滞后等待项；`uploadQueue.enqueueFinalize` 按 task_id 幂等。
5. **SSE 跨 worker**：已是 Redis pub/sub（channel `task-updates:{userId}`），改 `realtime.cjs` 保留 `subscribe`/`snapshotActive` 签名（dispatcher 约 20 处依赖）。
6. **状态值统一**：`running | waiting | done | failed | canceled | not_found | unknown`；`canceled` 一个 l。
7. **影子项判别硬约束**：5% 影子 item 与真实 item 同存 `generation_items_v2`，用 `mode`（real/shadow）区分；所有 worker 领取/回收只 `AND mode='real'`，否则会把影子项当任务执行。
8. **滞后 worker 防重**：`lease_version` fencing token 防迟到 worker 回写；上游响应不确定时进入 `reconciling / review_required`，**禁止直接退款或重提**。
9. **OSS 禁用降级**：OSS 禁用时写 `status='success'`（非 `pending_upload`），`ossUploaded: false`（否则前端误显示 OSS 角标）。
10. **Agnes 限流须实时探测**：外部策略会变，旧注释/旧结论不代表现状；故障时用控制实验重新探测，并注明并发规模与时间。

---

## 第六章 安全与凭据纪律

1. **凭据唯一来源**：交接手册 `C:\Users\Administrator\WorkBuddy\2026-08-15-09-53-18\moling_系统交接手册_凭据与约定_v2026-08-20.md`（含 SSH 密钥、DB/Redis/JWT/OSS 密码、provider key 池导出、部署铁律）。凭据实时核实自生产，**非记忆推断**；用前读此文件。
2. **诊断打印**：禁止打印完整 API Key / 凭据；只允许 provider / source type / **masked fingerprint** / count / enabled state。
3. **API 只暴露 masked fingerprint**：完整 credential 永不进入前端、API 响应、OpenAPI examples、日志、trace、错误、快照。
4. **公开库绝不含凭据**：提交前对每个凭据跑 `grep -rlF "<secret>"`（DB/Redis/JWT/OSS/API token）。
5. **测试与生产隔离**：E2E / 本地测试只用本地 fake key + 本地 DB + environment variable 注入凭据；**禁止**使用 production account / admin password / production DB / API key / provider key。
6. `JWT_SECRET` 原样传入；数据库真实角色密码不能靠容器初始化 env 推断。

---

## 第七章 模型 / Provider / 路由契约

1. **模型 type 只有 `image / video / text`，无 audio（无 TTS）**。
2. **Provider 权威源**是 `api_keys` 表（多 key 轮换池），`providers.api_key` 字段只是备用；无 key 数据则多 key 轮换不生效。
3. `provider_model_bindings` 表**无 status 列**，只有 `enabled`(boolean)、`priority`、`weight`；绑定为空会导致任务卡死（provider_id=NULL）。
4. **路由契约**：`/api/generate` 的 `modelId` 传 **canonical model_id**（如 `agnes-image-2.1-flash`）或 display_name，**不是 `models.id` 行 id**；传错会被 resolver 兜底原值 → 无 pair → 「该模型没有可用的已启用服务商」，貌似 provider 没配实为参数错。
5. **计费契约**：`credit_cost=0` 是配置（0 积分收费），非计费 bug。

---

## 第八章 代码 / 仓库纪律（GitHub 同步与漂移对账）

仓库：`https://github.com/marinerfan123/AiOnline`（`E:/code` 指向的 `marinerfan123/workaigc` 是错误旧仓库）。

1. **真相源 = 运行中容器**；拉下 `/app/server` 到本地比对（不要用本地或 `/opt/moling` 工作树当真相，二者都已漂移）。
2. 逐文件 diff；用 `diff --strip-trailing-cr` 区分 CRLF/LF 噪音与真实内容差异；报 identical 即纯行尾差异，忽略。
3. 大小写冲突（`app.tsx`/`App.tsx`）用 `git rm --cached "<小写路径>"` 删小写、保留线上用的大写。
4. 双向漂移要「合并」不要「覆盖」（db.cjs：GitHub 有 api_keys 建表、线上有 models 唯一索引，两者都留）。
5. 推送走本机（有 marinerfan123 token 凭据管理器），服务器无 token。
6. 仓库历史是 Windows 提交 CRLF、生产跑 LF，已加 `.gitattributes`(`* text=auto eol=lf`) 收敛。

---

## 第九章 前端构建纪律（Windows git-bash 血泪）

1. **前端构建只能在本机 `E:/code` 做**：服务器 host 无 node，容器无 `src/` 和 vite/ts 工具链。正确流程：本地 build（产出 `dist/build2`）→ scp 新 `index.html`+`assets/*` → `docker cp` 进容器 `/app/dist/build2` → 按 index.html 白名单清孤儿 chunk → curl 线上 bundle 验证。
2. `npm run <x>` 报 `spawn /bin/bash ENOENT`：根因是用户级 `~/.npmrc` 的 `script-shell=/bin/bash`（Windows 原生 npm 无法 spawn）。一次性覆盖：`npm_config_script_shell=cmd.exe npm run <x>`；或直跑底层 `node_modules/vite/bin/vite.js build` / `node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit` / vitest。永久修：删那行或改为 `C:\Program Files\Git\bin\bash.exe`。
3. `npm install <pkg>` 报 esbuild postinstall ENOENT → 加 `--ignore-scripts` 绕过。
4. vite(esbuild) 构建**不做类型检查**；改码后单独跑 `tsc -p tsconfig.app.json --noEmit`（现应为 0 错）。
5. 测试纪律：前端 vitest 的 `describe/it` 从 `vitest` 导入（不可用 `node:test`）；`vite.config.ts` 限 include `src/**/*.test.{ts,tsx}`，exclude `node_modules/**`、`refs/**`、`dist/**`。

---

## 第十章 知识沉淀与文档纪律

1. **复杂/迭代任务沉淀为 skill**：遇到 5+ 步骤、踩坑、非平凡流程，保存为可复用 skill；发现 skill 过时/缺失步骤立即 patch 更新。
2. **skill 必须维护**：过时、失效、有坑未记录的 skill 是负债；用后立即修正。
3. **凭据不写入 skill**：skill 只放指向交接手册的权威凭据来源，凭据勿复制进 skill。
4. **被裁剪 skill 先 reload 再使用**；同 skill 残留 `[SKILL_PRUNED]` 是历史产物，reload 后无需重复处理。

---

## 附则 · 关键术语

- **状态值**：`running | waiting | done | failed | canceled | not_found | unknown`（`canceled` 一个 l；`waiting`=等待区排队）。
- **模型类型**：`image | video | text`（无 audio）。
- **聚合容量**：`perKeyCap × activeKeyCount`；全局 `GLOBAL_MAX`（默认 10，生产曾设 50）。
- **等待区参数**：`WAITING_THRESHOLD=10`、`WAITING_MAX_RETRY=10`、`WAITING_MAX_WAIT_MS=90min`。
- **Topology（v1）**：`moling-v1-api-01/02`(:18001/18002) + `moling-v1-worker-01/02`(entry.cjs)；复用 prod PG(`moling@huabu`)+redis；旧栈 `moling-app-1`(:3001) 仅回滚时启动。

---

*本文档为项目最高准则。任何个人/会话/agent 行为与本宪法冲突时，以本宪法为准；对宪法条文的修改须经用户明确批准。*
