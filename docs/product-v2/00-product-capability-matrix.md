# 00 — Backend Capability Matrix (Source of Truth: release/moling-commercial-v1 @ 1515c05)

生成日期: 2026-08-27
仓库: github_ai_online / feat/moling-product-ui-v2 (HEAD=1515c05 = tag release/moling-commercial-v1)
生产: tv.moling.fun (commercial v1 LIVE, 本阶段禁止修改)
方法: 扫描 server/server.js (4725 行) + admin.cjs/finance.cjs/me.cjs/shop.cjs/payments.cjs/modules/* + server/db/migrations/0001-0009

状态标记: LIVE=生产可用 | PARTIAL=有API无完整语义 | GAP=前端需要但后端缺失(BACKEND_API_GAP)

## A. 平台 / 基础

| Capability | Backend API | DB tables | Current UI | Permissions | Status | New UI destination | Missing API | Rewrite requirement |
|---|---|---|---|---|---|---|---|---|
| 注册/登录/刷新 | POST /api/auth/register, /login, /refresh; GET /api/auth/me; POST /logout | users, refresh_tokens | AuthPage (login+register 合并页) | public | LIVE | /login, /register | — | 重写为 DS V2 表单 |
| 首启引导 | GET /api/setup/status, POST /api/setup/init | users | SetupWizardPage | public (仅首启) | LIVE | /setup | — | 保留逻辑, 重做 UI |
| 健康/就绪 | GET /api/healthz (cpu.shedding), GET /api/readiness | — | 无 UI | public | LIVE | Shell 内 status dot | — | 顶栏接入 healthz 轮询 |
| 全局设置 | GET/PUT /api/settings | settings | SystemSettingsPage (admin) | admin | LIVE | Admin/System Settings | — | 重写 |
| 本地文件/静态 | /media/*, /samples/* GET | media | Library | user | LIVE | Assets | — | 复用 |

## B. 生成 (Generation V2 — 认证核心, 不可改)

| Capability | Backend API | DB tables | Current UI | Permissions | Status | New UI destination | Missing API | Rewrite requirement |
|---|---|---|---|---|---|---|---|---|
| 提交生成 (图/视频) | POST /api/generate (modelId=canonical model_id, count 1-4, ratio, resolution, referenceImages, idempotencyKey) | generation_tasks, generation_items_v2, generation_batches_v2, generation_credit_holds_v2 | WorkspacePage 内联生成面板 | user (扣积分) | LIVE | Creation / Studio 节点 | — | 统一 Generation UX (Queued/Generating/Processing/Completed/Failed) |
| 任务状态 | GET /api/generate/status/:taskId | generation_tasks, media | 轮询 10s | user | LIVE | Tasks 页 + SSE 优先 | 用户级任务历史分页 API (现在只能从 media 反查) | 需 GAP: 见 §I |
| 取消任务 | POST /api/generate/cancel/:taskId | generation_tasks | 卡片取消按钮 | user | LIVE | 同上 | — | 复用 |
| 队列状态 | GET /api/generate/queue-status | generation_tasks | GenerationBar | user | LIVE | 顶栏 Running Tasks | — | 简化为 5 态展示 |
| 活跃任务 | GET /api/generate/active | generation_tasks | 重连恢复 | user | LIVE | 同上 | — | 复用 |
| SSE 实时 | GET /api/generate/stream (Redis pub/sub, task-updates:{userId}) | — | useGenerationStream | user | LIVE | 全局任务中心 + 画布节点状态 | — | 保留, 前端重构为单例 SSE client |
| 等待区 | 内部 (throttled/enqueueWaiting, 90min) | generation_tasks.error/resume_meta | 无 | system | LIVE | Admin Generation Tasks 可见 | — | 不暴露 lease/attempt 给用户 |
| Worker 租约/fencing | generation-worker + lease.cjs (lease_version) | generation_worker_heartbeats_v2, generation_item_attempts_v2 | 无 | system | LIVE | Admin/Workers (GAP: 无 API) | GET /api/admin/v2/workers, /attempts, /outbox, /reconciliation — 见 §I | 只读观测 API 需新增(不改认证核心逻辑) |
| 对账 | reconciler.cjs (reconciling/review_required) | generation_item_attempts_v2, generation_outbox_v2 | 无 | system | LIVE | Admin/Finance reconcile 页 | 同上 | 只读 API |
| 提示词优化/翻译 | POST /api/agent/optimize-prompt, /api/agent/translate-prompt | agent_calls | Studio script 节点 / 生成面板 | user (text 模型) | LIVE | Studio Prompt 节点, 生成对话框 | — | 复用 |

## C. 素材 / 资产

| Capability | Backend API | DB tables | Current UI | Permissions | Status | New UI destination | Missing API | Rewrite requirement |
|---|---|---|---|---|---|---|---|---|
| 媒体 CRUD | GET/POST /api/media, GET /api/media/counts, PUT/DELETE /api/media/:id | media | LibraryPage (7 分类 tab) | user (owner) | LIVE | Assets (Grid/List/Search/Filter/Tag) | 标签/项目维度过滤参数 | 统一资产库, 支持送画布 |
| 我的媒体导出 | GET /api/export/my-media | media | AccountPage | user | LIVE | Settings/Danger zone | — | 保留 |
| 图片编辑器 | PUT /api/media/:id (patch) | media | ImageEditorPage (/edit/:id) | user | PARTIAL (前端本地编辑, 回写 media) | Assets → Detail → Edit | — | 保留能力, 并入资产详情抽屉 |
| 角色 | GET/POST /api/characters, DELETE /:id, GET /:id/stats | characters | CharactersPage | user | LIVE | Characters (独立一级页) | — | 重写, 支持 referenceImages 绑定 |
| 参考样式 (用户提交/删除) | GET /api/reference-styles, POST (submit), DELETE | reference_styles | Library 内提交入口 | user | LIVE | Assets 详情 → 提交为参考样式 | — | 保留 |
| 参考样式 (admin) | /api/admin/reference-styles (list/review/promote) | reference_styles, style_earnings | ReferenceStylesReviewPage | admin | LIVE | Admin/Reference Styles | — | 重写 |
| OSS 上传链路 | /api/oss/* (sign-upload, ingest, test, logs), oss_configs | media.oss_url, oss_configs | SystemSettings 内 OSS 面板 | admin | LIVE | Admin/Storage | — | 独立 Storage 页 |
| 示例库 (admin) | /api/admin/samples CRUD + push | default_assets | SamplesPage | admin | LIVE | Admin/Examples | — | 重写 |

## D. Provider / Key Pool / Model Hub

| Capability | Backend API | DB tables | Current UI | Permissions | Status | New UI destination | Missing API | Rewrite requirement |
|---|---|---|---|---|---|---|---|---|
| Provider CRUD | GET/POST /api/providers, PATCH/DELETE /:id (revision 乐观锁) | providers | ModelHubPage (Provider 卡片) | admin | LIVE | Admin/Providers (纯连接配置) | — | 拆出, 不再塞模型/key/路由 |
| Provider 同步模型 | POST /:id/sync, /api/providers/preview-models | models, provider_model_bindings | PairingTab | admin | LIVE | Admin/Model Hub → Sync | — | 重写 |
| Provider 测试 | POST /:id/test-endpoint, /test-default | — | ProviderModelsPanel | admin | LIVE | Admin/Provider Health | — | 重写 |
| Provider 状态/冷却 | GET /api/providers/states, POST /:id/cooldown | providers (运行时状态) | 无专门页 | admin | LIVE | Admin/Provider Health | — | 新建健康页 |
| Key Pool CRUD | GET/POST /:id/keys, PATCH/DELETE /:id/keys/:keyId (mask, status, label, failures) | api_keys (0006+0009 已对齐 label/weight/UNIQUE) | ModelHubPage 密钥池 tab | admin | LIVE | Admin/Key Pool (独立页) | — | 独立: 批量导入/启停/统计 |
| 模型 CRUD | GET/POST /api/models, PATCH/DELETE /:id, POST /api/models/batch | models, model_pricing, model_cost_rates | ModelHubPage (模型 tab) | admin | LIVE | Admin/Model Hub (用户可见: /models 只读目录) | — | 拆: 管理 vs 用户目录 |
| Provider 绑定 | 经 /models POST + sync 写入 provider_model_bindings (upstream_model_name, priority, weight, enabled) | provider_model_bindings | PairingTab | admin | LIVE | Admin/Provider Bindings (独立矩阵页) | 绑定 CRUD 专用 API (现在混在 models 写入里) | 轻量 GAP, 可在 V2 内只读+经现有 API 编辑 |
| 定价 | model_pricing + /api/admin/model-price-history | model_pricing, model_price_history | ModelPricePage | admin | LIVE | Admin/Pricing | — | 重写, 含历史 |
| 智能路由 | GET /api/admin/routing/jobs, /decide, /model-participation | — (读 providers/bindings/model_pricing 计算) | RoutingPage | admin | LIVE | Admin/Smart Routing (模拟器+参与视图) | — | 重写 |

## E. 账务 / 充值 / 支付

| Capability | Backend API | DB tables | Current UI | Permissions | Status | New UI destination | Missing API | Rewrite requirement |
|---|---|---|---|---|---|---|---|---|
| 用户概览 | GET /api/me/summary | users, credit_transactions | AccountPage | user | LIVE | Billing/Account | — | 重写 |
| 用户流水 | GET /api/me/transactions, /api/me/recharges | credit_transactions, recharge_orders | AccountPage | user | LIVE | Billing 历史 | — | 重写 |
| 充值包 | GET /api/finance/topup-packages (public) | topup_packages | RechargePage | public | LIVE | Billing → Recharge | — | 重写 |
| 支付方式 | GET /api/credits/payment-methods | payment_settings | RechargePage | public | LIVE | 同上 | — | 重写 |
| 充值订单 | POST/GET /api/credits/orders, GET status, POST /api/credits/webhook/:channel | recharge_orders, payment_audit, webhook_events | RechargePage | user+webhook | LIVE (支付壳: 无真实商户凭据) | Billing → Recharge | 真实支付渠道 (PAYMENT_MASTER_KEY 未设) | UI 按壳设计, 标注"支付渠道待接入" |
| 积分 hold/commit/release | 内部 (billing.cjs + V2 credit_holds CAS) | credit_transactions, consumption_ledger, generation_credit_holds_v2 | 无 | system | LIVE (认证核心) | Admin/Finance | — | 不重写 |
| Admin 财务 | /api/admin/finance/overview, kpi-detail, recharges, reconcile, topup-packages CRUD, payment-settings, providers CRUD | 上述 | FinancePage + PaymentSettingsPage | admin | LIVE | Admin/Finance + Recharge + Payment (3 页) | — | 重写拆分 |
| 盈亏台账 | GET /api/admin/ledger, /ledger/summary | consumption_ledger, model_cost_rates | LedgerPage (标记 comingSoon) | admin | LIVE | Admin/Finance → P&L (解除 comingSoon) | — | 重写 |
| 积分流水 (admin) | GET /api/admin/transactions | credit_transactions | TransactionsPage | admin | LIVE | Admin/Finance → Transactions | — | 合并入 Finance |

## F. Studio / 短剧

| Capability | Backend API | DB tables | Current UI | Permissions | Status | New UI destination | Missing API | Rewrite requirement |
|---|---|---|---|---|---|---|---|---|
| Studio 项目 CRUD | GET/POST /api/studio/projects, GET/PATCH/DELETE /:id (stage, meta JSON) | studio_projects | StudioListPage + StudioStagePage | user | LIVE | Projects + Studio | — | 重写项目页; stage 字段语义升级为短剧工作流 |
| 无限画布 (前端) | 无持久化 (React Flow 内存态, 接 /api/generate) | 预留 canvas_nodes 概念未建表 | src/features/canvas (4 节点: text/image/video/script) | user | PARTIAL | Moling Studio 核心 | 画布/节点持久化 API (save/load canvas, nodes) — 见 §I | @xyflow/react 重写, 16 类节点 |
| 短剧工作流 | 无专用 API (复用 generate + studio_projects.meta) | studio_projects | 五阶段壳 (idea/script/storyboard/video/episode) | user | PARTIAL | Short Drama 引导流程 | 剧本/分镜/剧集结构化存储 — 见 §I | 引导式 + 一键进画布 |
| 音频/TTS | 无 (模型 type 仅 image/video/text) | — | 无 | — | GAP | 画布 Audio 节点 (V2 一期可禁用) | TTS provider 支持 | 记 BACKEND_API_GAP |

## G. Agent / Skills / 智能体

| Capability | Backend API | DB tables | Current UI | Permissions | Status | New UI destination | Missing API | Rewrite requirement |
|---|---|---|---|---|---|---|---|---|
| 技能目录 | GET /api/skills (public 启用), GET /api/skills/mine, POST /api/skill/run (真实扣积分) | skill_registry, user_skills, agent_calls | 无独立用户页 (生成内联调用) | user | LIVE | Creation 内 Skill 面板 (用户) | — | 新建轻量 Skill 面板 |
| 技能管理 (admin) | GET/POST /api/admin/skills | skill_registry | SkillsPage | admin | LIVE | Admin/Skills | — | 重写 |
| 智能体 CRUD | GET/POST /api/admin/agents, /:id/toggle, /:id/providers | agents | AgentsPage | admin | LIVE | Admin/Agents | — | 重写 |
| Agent 供应商/规则 | GET/POST /api/admin/agent-providers, agent-rules, /:id/toggle | agent_providers, agent_rules, agent_rule_logs | AgentsPage 内嵌 | admin | LIVE | Admin/Agents 子 tab | — | 重写 |

## H. 用户 / 运营 / 监控

| Capability | Backend API | DB tables | Current UI | Permissions | Status | New UI destination | Missing API | Rewrite requirement |
|---|---|---|---|---|---|---|---|---|
| 用户管理 | GET /api/admin/users, /:id/credits, /password, /status, /role, DELETE | users, credit_transactions | UsersPage | admin | LIVE | Admin/Users | — | 重写 |
| 生成任务总览 (admin) | GET /api/admin/generations | generation_tasks | ConsolePage 内嵌 | admin | LIVE | Admin/Generation Tasks | — | 独立页 |
| 资产总览 (admin) | GET /api/admin/assets | media | ConsolePage | admin | LIVE | Admin/Overview 卡片 | — | 并入 Overview |
| 问题/报错 | GET /api/admin/issues, /api/admin/errors (+DELETE), POST /api/feedback, /api/report | feedback, reports, system_error_logs | ErrorLogsPage + Support/feedback | admin+user | LIVE | Admin/Security→Issues; 用户 feedback 入口 | — | 重写 |
| API 活动流 | GET /api/admin/monitor/snapshot, /stream (SSE), /clear | request_logs | MonitorPage | admin | LIVE | Admin/Monitoring | — | 与 logs/monitoring 合并 |
| 系统日志 | GET /api/admin/logs/snapshot, /stream, /clear | request_logs/syslog | LogsPage | admin | LIVE | Admin/Logs | — | 重写 |
| 业务诊断 | 内部 (monitoring 页聚合 SQL) | 多表 | MonitoringPage + MonitoringStandalonePage (/monitoring/:tab) | admin | LIVE | Admin/Monitoring (合并 3 页) | — | 合并 |
| 审计日志 | GET /api/admin/audit | audit_logs | 无 | admin | LIVE | Admin/Security | — | 新建 |
| 控制台 SSE | GET /api/admin/console/stream | — | ConsolePage | admin | LIVE | Admin/Overview | — | 并入 |
| 用户主页 | GET /api/user/:id, media | media, users | UserPage (public 展示) | public | LIVE | 一期 REMOVE (社交展示无产品定位), 数据保留 | — | 移除入口 |

## I. BACKEND_API_GAP 清单 (前端需要 / 后端缺失 — 禁止把业务逻辑搬到前端)

| # | Gap | 需要的 API | 影响页面 | 建议 |
|---|---|---|---|---|
| G1 | 画布持久化 | POST/GET /api/studio/projects/:id/canvas (nodes+edges 存 studio_projects.meta 或新表 canvas_nodes) | Studio | 后端小改 (不动认证核心), 一期必做 |
| G2 | 用户任务历史分页 | GET /api/generate/history?limit&offset&status (读 generation_tasks owner) | Tasks | 后端小改, 一期必做 |
| G3 | V2 只读观测 | GET /api/admin/v2/{workers,attempts,outbox,reconciliation} (读 *_v2 表) | Admin/Workers, Attempts | 只读, 不触碰 lease/fencing 逻辑 |
| G4 | 绑定专用 CRUD | PATCH/DELETE /api/admin/bindings/:id | Admin/Provider Bindings | 现在绑定写入混在 /api/models 内; 可一期用现有 API + UI 标注 |
| G5 | 通知中心 | 无 (仅任务 SSE) | Shell 通知 | V2 一期不做, 用 SSE 事件本地 toast 代替 |
| G6 | 全局搜索 | 无 | Shell Search | 一期做前端组合搜索 (media+projects), 记录为后端待办 |
| G7 | 音频/TTS | 无 audio 模型类型 | Audio 节点 | 画布 Audio 节点一期 disabled |
| G8 | 短剧结构化存储 | 剧本/分镜/剧集/时间线 无专用表 API | Short Drama | 一期全存 studio_projects.meta (JSON), 后端不建新表; 记录二期需求 |
| G9 | 视频合成/导出 | 无服务端 export API (时间线→成片) | Short Drama Final Export | 一期仅做"分镜视频列表+下载", 服务端合成记二期 |
| G10 | 真实支付渠道 | payment_providers 空, PAYMENT_MASTER_KEY 未设 | Recharge | UI 按壳, 后端接渠道前充值走 admin 手动/线下 |
| G11 | Workspace 多项目隔离 | 无 workspace API (单 user 全量库) | Admin/Workspaces | 一期 Admin/Workspaces 页不做, 从 IA 中降级为"用户资产视图" |
| G12 | 画布执行编排 | 节点 DAG 依赖执行 (上游产物→下游输入) 无后端任务链 API | Studio 批量执行 | 一期前端按依赖顺序串行调用 /api/generate (每节点独立任务), 后端 DAG API 记二期 |

## J. 认证核心 — 本阶段禁止重写

Generation V2 全链路 (intake/lease/fencing/reconciler/worker/upload/billing CAS/PITR/迁移框架 0001-0009) 已认证上线 (commercial v1)。V2 UI 只消费其外部契约: /api/generate 系列 + SSE + 只读观测 (G3 新增仅限 SELECT)。

## 统计

- 后端能力条目: 60
- 独立 API 端点 (含方法): ~120
- DB 表 (迁移链定义): 46
- BACKEND_API_GAP: 12 (见 §I)
