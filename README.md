# AiOnline · 墨灵AI（Moling AI）

在线版本 · 单一真相源同步仓库。
仓库：`https://github.com/marinerfan123/AiOnline`（`E:/code` 指向的 `marinerfan123/workaigc` 是错误旧仓库）。

墨灵AI 是生产级 AI 创作平台，覆盖 文生图 / 图生图 / 文生视频 / 图生视频 / 文本推理，含电商商城、模型 Hub、创作工作室 Studio（M5 流水线）、充值、管理后台等模块。
线上：`8.148.68.47`（`tv.moling.fun`），PostgreSQL 为任务/状态/账务唯一真相源。

> 依据《CONSTITUTION.md》第一章/第八章：**运行中的生产容器是代码真相源**，本地 `/opt` 与 GitHub 副本都可能漂移。本仓库由线上容器 `moling-app-1:/app` 拉取并收敛后同步。

---

## 完整更新报告（本次同步）

同步时间：2026-09-15（UTC）
同步方向：线上容器 `moling-app-1` → `/opt/moling` 工作树 → GitHub `main`
执行方式：`docker cp` 拉取线上 `/app/server`、`/app/dist`、`package.json`、`package-lock.json`，哈希对账后收敛。

### 1. 真相源确认（哈希对账）

| 项目 | 结果 |
| --- | --- |
| 线上 `/app/server` vs 旧 `/opt/moling/server` | **593 文件逐哈希一致**（仅多 `server/data/.api_token` 运行时密钥，已剔除） |
| 线上 `/app/package.json` vs 旧 `/opt/moling/package.json` | **一致**（version 0.1.0） |
| 线上 `/app/dist/build2` vs 旧 `/opt/moling/dist/build2` | 不一致 → 以下收敛 |
| 线上 `index.html` 入口 | `index-CeyqvsuC.js` / `index-iCgOsz9k.css`（旧本地为 `index-D1IKRr4h.js`，已判为过时） |

### 2. 后端（server/）

- 以线上容器 `moling-app-1:/app/server` 为唯一真相源整目录覆盖 `/opt/moling/server`（593 文件，含 `server/data/` 密钥已剔除）。
- 模块目录（线上完整）：`ai-control / budget / collaboration / community / generation-entry / generation-v2 / media / modelhub / platform-data / platform-policy / project-foundation / prompt-ir / script / studio-contracts`。
- 迁移脚本 `server/db/migrations` 共 **75 个**（`0001_baseline_legacy_schema.sql` → `0075_asset_upload_jobs.sql`），与线上运行时一致。
- 关键契约保留：Provider 权威源为 `api_keys` 表（多 key 轮换池）；`provider_model_bindings` 仅 `enabled/priority/weight`（无 status 列）；`/api/generate` 的 `modelId` 传 canonical `model_id`。

### 3. 前端（src/ 417 文件 + 构建产物 dist/build2）

- 前端源码 `src/` 全量进库（React + Vite/rolldown 工程）。
- 构建产物 `dist/build2` 按线上 `index.html` 引用白名单做**闭包清理**：保留被入口与动态 `import()` 可达的 **143 个资源**，删除 **54 个孤儿 chunk**（旧本地多出的 `*-D1IKRr4h`、旧页面 hash 等）。
- 入口校验：`index.html → index-CeyqvsuC.js + index-iCgOsz9k.css`，StudioPage / CartPage / ProductDetailPage 等懒加载 chunk 均在闭包内。
- 注：按 `.gitignore`，`dist/` 为构建产物默认不入库；本次以 `src/` 源码 + 可复现构建为准。若需把 build2 快照也入库，可临时解除忽略。

### 4. 配置 / 文档 / 工具

- `package.json` / `package-lock.json`（线上）、`Dockerfile`、`docker-compose*.yml`、`deploy/`、`contracts/openapi/`、`CONSTITUTION.md`、`Q6-HA-AUDIT.md`、`docs/`(63)、`scripts/`(26)、`e2e/` 全量对齐。
- `.gitattributes`（`* text=auto eol=lf`）统一行尾，消除 CRLF↔LF 抖动。

### 5. 安全 / 密钥卫生（P0：仓库为 PUBLIC）

- 已确认 **不入库**：`.env`、`.env.*`（仅保留 `.env.example`）、`server/data/.api_token`、`server/data/*.json`、`backups/`、`node_modules/`、`storybook-static/`、`test-results/`。
- 密钥扫描（`ghp_ / AKIA / sk- / BEGIN PRIVATE KEY`）：无真实密钥命中，仅 `server.js` 读取 `.api_token` 文件名的代码引用（非密钥本身）。
- `.env.example` 保留为配置模板（占位符，无真实凭据）。

### 6. 本次未改动 / 需后续

- 数据库 schema 变更不在本次代码同步范围（PostgreSQL 为运行时真相源；迁移脚本 75 个已随 `server/db/migrations` 进库）。
- 本地 `E:/code`（Windows）仍过时，仅用于前端 `vite build`（宪法第九章）。
- 推送凭据：按宪法第八章第 5 条，服务器无 token，推送走本机（marinerfan123 凭据管理器）。

---

## 仓库结构速览

| 目录 | 说明 |
| --- | --- |
| `server/` | 后端服务（dispatcher / billing / modelhub / generation-v2 / studio / payments …，真相源=线上容器） |
| `server/db/migrations` | 75 个 SQL 迁移（唯一真相源：PostgreSQL） |
| `src/` | 前端 React 源码（417 文件） |
| `shared/` | 前后端共享类型 / 能力配置 |
| `contracts/openapi` | OpenAPI 契约（v2 + ai-control） |
| `deploy/` | nginx / pgbouncer / ecosystem / 多 compose |
| `docs/`、`scripts/`、`e2e/` | 文档、运维脚本、端到端测试 |
| `CONSTITUTION.md` | 项目根本法（开发/运维/变更治理最高准则） |

## 运行（本地/服务器）

```bash
# 后端（需 PG + Redis）
cp .env.example .env   # 填 PG/Redis/OSS/Agnes 凭据
node server/server.js  # 或 docker compose -f docker-compose.moling.yml up

# 前端
npm install
npm run build          # 产出 dist/build2（仅本机 E:/code 有 node/vite 工具链）
```
