# 03 — Page Inventory (现有 → 新 映射)

日期: 2026-08-27
基线: 59 个页面级 tsx (pages 56 + features/canvas 3), 41 条旧路由, 126 个 api.* 函数, 88 个共享组件。

分类: KEEP=保留重写 UI / MERGE=并入新页 / REMOVE=下线 / SPLIT=拆分多页 / NEW=V2 新增

## User 侧

| 现有页面 (文件) | 旧路由 | 分类 | 新页面 | 备注 |
|---|---|---|---|---|
| LandingPage | / | KEEP | / (Public) | 重做视觉 |
| AuthPage | /login /register | KEEP | 同 | DS V2 表单 |
| SetupWizardPage | /setup | KEEP | 同 | |
| WorkspacePage | /workspace | SPLIT | /dashboard + /create + /tasks | 单页塞了概览+生成+任务条 |
| LibraryPage | /library/:cat | REWRITE | /assets | 7 分类 tab → 类型路由; 去 mock |
| ImageEditorPage | /edit/:id | MERGE | /assets/:type/:id 详情抽屉 | 编辑并入详情 |
| CharactersPage | /characters | KEEP | /characters | |
| ModelConsole | /model-console | MERGE | /models (目录) + /create 模型选择器 | 用户侧只读化 |
| RechargePage | /recharge | SPLIT | /billing + /billing/history | |
| AccountPage | /account | KEEP | /account + /settings | 拆 profile 与偏好/导出 |
| UserPage | /user/:id | REMOVE | — | 社交展示无定位, 后端保留 |
| StudioListPage | /studio | KEEP | /projects + /studio 入口 | 项目列表升级 |
| StudioStagePage | /studio/:id | SPLIT | /studio/:id (画布) + /studio/:id/drama (引导) + /projects/:id | 五阶段壳 → 短剧流程 + 自由画布 |
| canvas/InfiniteCanvas | (内嵌) | REWRITE | StudioCanvasPage 内核 | @xyflow/react 全量重写 |
| canvas/CanvasNode | (内嵌) | REWRITE | 节点组件体系 | 4 节点 → 16 节点 |
| canvas/store | (内嵌) | REWRITE | canvas state (Zustand) | context → 独立 store |
| HelpCenterPage+7 子页 | /help 等 8 路由 | MERGE | /help (单页多 tab) + /privacy + /about | 减 6 路由 |
| FeedbackPage | /feedback | MERGE | /account → 反馈入口 + 全局 toast 按钮 | |
| ReportPage | /report | MERGE | Assets 详情 → 举报 | |

## Admin 侧

| 现有页面 | 旧路由 | 分类 | 新页面 |
|---|---|---|---|
| ConsolePage | /admin | SPLIT | /admin (Overview) + /admin/generations + /admin/security(issues) |
| MonitorPage | /admin/monitor | MERGE | /admin/monitoring (activity tab) |
| LogsPage | /admin/logs | MERGE | /admin/monitoring (logs tab) |
| MonitoringPage | /admin/monitoring | MERGE | /admin/monitoring (diagnose tab) |
| MonitoringStandalonePage | /monitoring/:tab | MERGE | 同上 |
| ErrorLogsPage | /admin/errors | MERGE | /admin/security |
| AgentsPage | /admin/agents | KEEP | /admin/agents (含 providers/rules tab) |
| UsersPage | /admin/users | KEEP | /admin/users |
| SamplesPage | /admin/samples | KEEP | /admin/examples |
| ReferenceStylesReviewPage | /admin/reference-styles | KEEP | /admin/reference-styles |
| ModelPricePage | /admin/models | SPLIT | /admin/pricing (+ 历史) |
| RoutingPage | /admin/routing | KEEP | /admin/routing |
| TransactionsPage | /admin/transactions | MERGE | /admin/recharge (积分流水 tab) |
| SkillsPage | /admin/skills | KEEP | /admin/skills |
| EcommerceAdminPage | /admin/ecommerce | REMOVE | — (随 /shop 下线, 后端保留) |
| FinancePage | /admin/finance | KEEP | /admin/finance (含 ledger 盈亏) |
| PaymentSettingsPage | /admin/payment-settings | SPLIT | /admin/payment + /admin/recharge (包管理 tab) |
| LedgerPage | /admin/ledger | MERGE | /admin/finance (P&L tab) |
| SystemSettingsPage | /admin/settings | SPLIT | /admin/settings + /admin/storage (OSS 部分) |
| AdminPlaceholderPage ×3 | storage/recommend/studio | REMOVE | storage→真实页; 另 2 个移除 |
| ModelHubPage (+5 子组件) | /model-hub | SPLIT | /admin/providers + /admin/keys + /admin/models + /admin/bindings + /admin/provider-health | 旧"一张卡片塞 5 件事"彻底拆散 |
| NotFoundPage | * | KEEP | 同 |

## 汇总

- 现有页面文件: 59 (pages 56 + features/canvas 3; 其中 admin placeholder 3、canvas 3、support 子页 7、model-hub 子组件 5)
- 现有路由: 41 (App.tsx 声明, 含 shop/support 子路由)
- 重复页面: MonitorPage vs MonitoringPage vs MonitoringStandalonePage (监控 3 页); ModelConsole vs ModelHubPage (模型 2 页); LibraryPage vs 未来 Assets 概念重叠; TransactionsPage vs me.recharges vs finance.recharges (流水 3 处)
- 半成品/建设中: AdminPlaceholderPage×3 (storage/recommend/studio); moduleLocks 软锁 /studio (生产锁定中); StudioStagePage 五阶段壳
- 无后端页面: Admin/Workspaces (未建, G11); /user/:id 有后端但产品定位缺失; Ecommerce 后端在但产品下线
- 有后端无前端页面: V2 观测 (workers/attempts/outbox, G3); 审计日志 (无页面); Provider Health (states API 无专门 UI); 技能目录用户侧 (无入口)
- 旧页处置: 完全消除 13 个页面文件 (shop 6 + user/:id + model-console + edit/:id + 监控旧 3 合并产物 + ecom), 并入他页 12, 拆分/重写产物 20+
