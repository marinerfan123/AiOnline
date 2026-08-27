# 01 — Information Architecture (V2)

日期: 2026-08-27
原则: 后端能力为唯一真相源 (00 矩阵); 旧 UI 仅作功能线索; Provider/Model/Key 彻底拆分; Studio 为产品核心; 用户不暴露内部链路。

## 顶层结构 (3 个 Shell)

```
/moling (V2)
├── [Public Shell]     落地页 / 登录 / 注册 / 首启 / 帮助文档
├── [User Shell]       Sidebar + Topbar, 需登录          ← 11 个一级模块
├── [Studio Shell]     全屏画布, 独立导航                ← 核心, 从 User Shell 进入
└── [Admin Shell]      独立 Sidebar, 需 admin 角色        ← 23 个一级模块
```

旧 /studio 的模块软锁 (moduleLocks.ts) 在 V2 移除: Studio 升级为解锁核心。
旧 /shop (AI 市集) 与 /user/:id (用户主页) 在 V2 一期下线 (REMOVE_LEGACY), 后端能力保留。

## USER PRODUCT (11 一级)

| # | 模块 | 路由 | 说明 | 后端依据 |
|---|---|---|---|---|
| 1 | Dashboard | /dashboard | 概览: 余额/进行中任务/最近资产/快捷创作 | me.summary + generate/active + media |
| 2 | Projects | /projects, /projects/:id | Studio 项目 (短剧/自由) 列表+详情 | studio_projects |
| 3 | Creation | /create | 快速生成 (图/视频, 无项目上下文) | generate |
| 4 | Moling Studio | /studio/:projectId | 无限画布 (全屏 Shell) | canvas (G1) + generate |
| 5 | Assets | /assets/:type? | 统一资产库 (图片/视频/角色/参考/音频/文档) | media + characters + reference_styles |
| 6 | Characters | /characters | 角色管理 (参考图/一致性) | characters |
| 7 | Models | /models | 用户可见模型目录 (只读: 能力/价格/示例) | models (public 只读视图) |
| 8 | Tasks | /tasks | 任务中心 (5 态 + Advanced details) | generate/status + history (G2) + SSE |
| 9 | Account | /account | 个人资料/安全/通知偏好 | auth/me + profile |
| 10 | Billing | /billing, /billing/history | 余额/充值入口/流水/订单 | me.summary/transactions/recharges + credits/orders |
| 11 | Settings | /settings | 工作偏好/导出/危险区 | settings(user scope) + export/my-media |

## ADMIN IA (23 个一级路由, 按分组)

| 分组 | 模块 | 路由 |
|---|---|---|
| Overview | Admin Overview (KPI/资产/问题/控制台流合并) | /admin |
| Supply — Provider | Providers (连接配置) | /admin/providers |
| Supply — Provider | Key Pool (批量导入/启停/健康) | /admin/keys |
| Supply — Provider | Provider Health (states/冷却/测试/同步) | /admin/provider-health |
| Supply — Model | Model Hub (模型 CRUD/目录) | /admin/models |
| Supply — Model | Provider Bindings (模型×Provider 矩阵) | /admin/bindings |
| Supply — Model | Pricing (定价+历史) | /admin/pricing |
| Supply — Model | Smart Routing (decide 模拟器/参与视图) | /admin/routing |
| Supply — Model | Examples (示例库) | /admin/examples |
| Supply — Model | Reference Styles (审核/推广/分成) | /admin/reference-styles |
| Execution | Generation Tasks (全量任务) | /admin/generations |
| Execution | Attempts (V2 item_attempts 只读, G3) | /admin/attempts |
| Execution | Workers (V2 心跳/租约 只读, G3) | /admin/workers |
| Execution | Agents | /admin/agents |
| Execution | Skills | /admin/skills |
| People | Users (角色/状态/积分/密码) | /admin/users |
| Finance | Finance (overview/kpi/盈亏 ledger) | /admin/finance |
| Finance | Recharge (充值包/订单/对账) | /admin/recharge |
| Finance | Payment (支付渠道/设置/webhook 审计) | /admin/payment |
| Platform | Storage (OSS 配置/日志) | /admin/storage |
| Platform | Monitoring (活动流+日志+诊断合并) | /admin/monitoring, /admin/monitoring/:tab |
| Platform | Security (审计日志/报错归档/feedback/report) | /admin/security |
| Platform | System Settings | /admin/settings |

注: 旧 Admin/Workspaces (G11 无后端) 一期不设页; 旧 Admin/Ecommerce 随 /shop 下线; 旧 Admin 4 个 Placeholder 页全部由上述真实页替换。

## 导航行为

- User Shell: 左侧 Sidebar (可折叠 56px), 权限驱动 (admin 可见 Admin 入口); 顶栏: Workspace 名(静态)/全局 Create 按钮/搜索(G6 前端组合)/通知铃(SSE toast 聚合)/Running Tasks 计数/Credit 余额/User Menu
- Studio Shell: 顶栏极简化 (项目名/保存状态/运行态/导出), 左下 Minimap, 左侧 Node Library 抽屉, 命令面板 Cmd+K
- Admin Shell: 独立深色 Sidebar, 分组折叠; 面包屑; 无用户导航泄漏

## 角色视图矩阵

| 角色 | User Shell | Studio | Admin Shell |
|---|---|---|---|
| 匿名 | Public 页 + /models 目录 | ✗ | ✗ |
| user | 11 模块 | ✓ (owner 项目) | ✗ |
| admin | 11 模块 | ✓ | 23 个一级路由 |

后端授权永远是最终边界 (RequireAdmin 仅为 UX 层, 00 §Permission 见 10-permission-map)。
