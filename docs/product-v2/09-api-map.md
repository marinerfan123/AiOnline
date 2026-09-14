# 09 — API Map (前端视角的完整端点清单)

日期: 2026-08-27
来源: server.js/admin.cjs/finance.cjs/me.cjs/shop.cjs/payments.cjs 实测扫描 (1515c05)。
前端封装: 拆分为 src/services/api/*.ts (替代 1439 行单文件 api.ts), 见 12 §API Client。

## 公开 (无 auth)
| 端点 | 方法 | 用途 |
|---|---|---|
| /api/healthz | GET | 健康 (cpu.shedding) |
| /api/readiness | GET | 就绪 |
| /api/auth/register /login /refresh | POST | 认证 |
| /api/finance/topup-packages | GET | 充值包 |
| /api/credits/payment-methods | GET | 支付方式 |
| /api/credits/webhook/:channel | POST | 支付回调 (系统) |
| /api/setup/status /init | GET/POST | 首启 |
| /api/reference-styles | GET | 参考样式目录 |
| /api/skills | GET | 技能目录 |
| /api/user/:id + media | GET | 用户主页 (V2 下线入口, API 保留) |

## 用户 (session)
| 端点 | 方法 | 用途 |
|---|---|---|
| /api/auth/me /logout | GET/POST | 会话 |
| /api/me/summary /transactions /recharges | GET | 账务 |
| /api/generate | POST | 提交生成 (图/视频) |
| /api/generate/status/:taskId | GET | 状态 |
| /api/generate/cancel/:taskId | POST | 取消 |
| /api/generate/queue-status /active | GET | 队列 |
| /api/generate/stream | GET(SSE) | 实时 |
| /api/agent/optimize-prompt /translate-prompt | POST | 文本智能体 |
| /api/media (CRUD) + /api/media/counts | GET/POST/PUT/DELETE | 资产 |
| /api/export/my-media | GET | 导出 |
| /api/characters (CRUD) + /:id/stats | * | 角色 |
| /api/reference-styles | POST/DELETE | 提交/删除样式 |
| /api/studio/projects (CRUD) | * | 项目 (meta 含画布, G1) |
| /api/skills/mine | GET | 我的技能 |
| /api/skill/run | POST | 试跑 (扣积分) |
| /api/models | GET | 模型 (用户目录视图) |
| /api/credits/orders + status | POST/GET | 充值订单 |
| /api/proxy-fetch | POST | 模型预览代理 |
| /api/feedback /api/report | POST | 反馈/举报 |

## 管理 (admin)
| 端点 | 方法 | 用途 |
|---|---|---|
| /api/admin/users (+credits/password/status/role/delete) | * | 用户 |
| /api/admin/transactions | GET | 积分流水 |
| /api/admin/agents (+toggle/providers) | * | 智能体 |
| /api/admin/agent-providers /agent-rules (+toggle) | * | 代理配置 |
| /api/admin/audit | GET | 审计 |
| /api/admin/samples (+push/delete) | * | 示例 |
| /api/admin/generations /assets /issues | GET | 总览 |
| /api/admin/errors (+DELETE) | * | 错误归档 |
| /api/admin/monitor/snapshot /stream(SSE) /clear | * | 活动流 |
| /api/admin/logs/snapshot /stream(SSE) /clear | * | 系统日志 |
| /api/admin/console/stream(SSE) | GET | 控制台 |
| /api/admin/finance/overview /kpi-detail /recharges /reconcile | GET | 财务 |
| /api/admin/finance/topup-packages | GET/POST | 充值包管理 |
| /api/admin/finance/payment-settings | GET/PUT | 支付设置 |
| /api/admin/finance/providers (+toggle/delete) | * | 支付渠道 |
| /api/admin/ledger (+summary) | GET | 盈亏 |
| /api/admin/reference-styles (review/promote) | * | 样式审核 |
| /api/admin/model-price-history | GET | 价格历史 |
| /api/admin/routing/jobs /decide /model-participation | GET | 路由 |
| /api/admin/skills | GET/POST | 技能管理 |
| /api/providers (CRUD) + keys(CRUD) + states + cooldown + sync + test-* + preview-models | * | 供给链 |
| /api/models (CRUD + batch) | * | 模型管理 |
| /api/settings | GET/PUT | 全局设置 |
| /api/oss (+configs CRUD/activate/test/logs/sign-upload/ingest) | * | 存储 |
| /api/shop/products 等 | * | 电商 (V2 前端下线, API 保留) |

## V2 新增 (G3, 只读, 后端小改)
| 端点 | 方法 | 用途 |
|---|---|---|
| /api/admin/v2/workers | GET | worker 心跳 (generation_worker_heartbeats_v2) |
| /api/admin/v2/attempts?taskId= | GET | item attempts 时间线 |
| /api/admin/v2/reconciliation | GET | reconciling/review_required 清单 |
| /api/generate/history?limit&offset&status | GET | G2 用户任务历史 |
| /api/studio/projects/:id/canvas (存 meta.canvas) | GET/POST | G1 画布持久化 (可经现有 PATCH 实现) |
