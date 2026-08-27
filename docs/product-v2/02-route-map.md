# 02 — Route Map (V2)

日期: 2026-08-27
约定: 全部路由在 App.tsx 内声明; 权限组件 RequireAuth / RequireAdmin 保留语义但重做; 旧路由 301 重定向表见 §3。

## 1. Public Shell

| Route | Page | Auth | 备注 |
|---|---|---|---|
| / | LandingPage | 无 | FirstRunGate: 已初始化后仍保留营销落地 |
| /login | AuthPage (mode=login) | 无 | |
| /register | AuthPage (mode=register) | 无 | |
| /setup | SetupWizardPage | 无 | 仅首启; 初始化后 404 |
| /help | HelpCenterPage | 无 | 子页 /help/guide /help/docs /help/changelog /help/tutorials 保留为 tab, 不占独立路由 |
| /privacy | PrivacyPage | 无 | |
| /about | AboutPage | 无 | |

## 2. User Shell (Layout = UserShell)

| Route | Page | 权限 |
|---|---|---|
| /dashboard | DashboardPage | user |
| /projects | ProjectsPage (列表+新建) | user |
| /projects/:id | ProjectDetailPage (概览/阶段/资产/成员占位) | user, owner |
| /create | CreationPage (快速生成) | user |
| /assets | AssetsPage (默认 image) | user |
| /assets/:type | AssetsPage (image/video/character/reference/audio/document) | user |
| /characters | CharactersPage | user |
| /models | ModelCatalogPage (只读目录) | 无 (匿名可看) |
| /tasks | TasksPage (全部/进行中/失败 tab) | user |
| /account | AccountPage (profile/security) | user |
| /billing | BillingPage (余额+充值入口) | user |
| /billing/history | BillingHistoryPage (流水+充值订单) | user |
| /settings | SettingsPage | user |

## 3. Studio Shell (全屏, 无 Sidebar)

| Route | Page | 权限 |
|---|---|---|
| /studio | StudioEntryPage (选项目/新建 → 跳转) | user |
| /studio/:projectId | StudioCanvasPage (无限画布) | user, owner |
| /studio/:projectId/drama | DramaFlowPage (短剧引导式流程) | user, owner |

## 4. Admin Shell

| Route | Page | 权限 |
|---|---|---|
| /admin | AdminOverviewPage | admin |
| /admin/providers | AdminProvidersPage | admin |
| /admin/keys | AdminKeyPoolPage | admin |
| /admin/provider-health | AdminProviderHealthPage | admin |
| /admin/models | AdminModelHubPage | admin |
| /admin/bindings | AdminBindingsPage | admin |
| /admin/pricing | AdminPricingPage | admin |
| /admin/routing | AdminRoutingPage | admin |
| /admin/examples | AdminExamplesPage | admin |
| /admin/reference-styles | AdminReferenceStylesPage | admin |
| /admin/generations | AdminGenerationsPage | admin |
| /admin/attempts | AdminAttemptsPage (G3) | admin |
| /admin/workers | AdminWorkersPage (G3) | admin |
| /admin/agents | AdminAgentsPage | admin |
| /admin/skills | AdminSkillsPage | admin |
| /admin/users | AdminUsersPage | admin |
| /admin/finance | AdminFinancePage | admin |
| /admin/recharge | AdminRechargePage | admin |
| /admin/payment | AdminPaymentPage | admin |
| /admin/storage | AdminStoragePage | admin |
| /admin/monitoring | AdminMonitoringPage (tab: activity/logs/diagnose) | admin |
| /admin/monitoring/:tab | 同上 deep-link | admin |
| /admin/security | AdminSecurityPage (audit/errors/feedback/report) | admin |
| /admin/settings | AdminSystemSettingsPage | admin |

## 5. 旧路由重定向 (301 / Navigate)

| 旧 | 新 |
|---|---|
| /workspace | /create |
| /library/:category? | /assets/:type (character→/characters; scene/prop/other→/assets/image?filter=...) |
| /model-console | /models (用户) |
| /edit/:id | /assets/image/:id (详情抽屉内编辑) |
| /user/:id | 404 (REMOVE, 数据保留) |
| /recharge | /billing |
| /studio/:projectId | /studio/:projectId (保留; 旧五阶段页 → /studio/:projectId/drama) |
| /model-hub (admin 壳) | /admin/models |
| /admin/monitor + /admin/logs + /admin/errors + /admin/monitoring | /admin/monitoring, /admin/security |
| /admin/transactions | /admin/recharge |
| /admin/ledger | /admin/finance |
| /admin/samples | /admin/examples |
| /admin/payment-settings | /admin/payment |
| /admin/storage (placeholder) | /admin/storage (真实页) |
| /admin/recommend, /admin/studio, /admin/ecommerce (placeholder) | 404 / 移除 |
| /shop/* | 404 (REMOVE, 后端保留) |
| /monitoring/:tab | /admin/monitoring/:tab |
| /help/* 子页 | /help?tab=... |

## 统计

- 新路由总数: 47 (public 7 + user 13 + studio 3 + admin 24 含 monitoring/:tab deep-link)
- 独立页面: 45 (含 NotFound)
- 重定向规则: 20
