import { useEffect, useState, type ReactNode, lazy, Suspense } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { isFeatureEnabled, FF } from '@/shared/config/featureFlags';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/shared/state/queryClient';

// V2 (M00 platform foundation) — lazy-loaded preview shell. Additive only:
// lives behind /__v2/* and the V2_APP_SHELL flag (default OFF in prod), so the
// legacy bundle and production behavior are untouched.
const V2App = lazy(() => import('@/app/router/V2App'));
function V2Suspense({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="grid h-screen place-items-center bg-black text-sm text-zinc-500">载入 V2…</div>
      }
    >
      {children}
    </Suspense>
  );
}
const LandingPage = lazy(() => import('@/pages/LandingPage/LandingPage'));
const WorkspacePage = lazy(() => import('@/pages/WorkspacePage/WorkspacePage'));
const ImageEditorPage = lazy(() => import('@/pages/ImageEditorPage/ImageEditorPage'));
const LibraryPage = lazy(() => import('@/pages/LibraryPage/LibraryPage'));
const CharactersPage = lazy(() => import('@/pages/CharactersPage/CharactersPage'));
const ModelHubPage = lazy(() => import('@/pages/ModelHubPage/ModelHubPage'));
const ModelConsole = lazy(() => import('@/pages/ModelConsole/ModelConsole'));
const ModelPricePage = lazy(() => import('@/pages/Admin/ModelPricePage'));
const RoutingPage = lazy(() => import('@/pages/Admin/RoutingPage'));
const KeyPoolPage = lazy(() => import('@/pages/Admin/KeyPoolPage'));
const AccountPage = lazy(() => import('@/pages/AccountPage/AccountPage'));
const UserPage = lazy(() => import('@/pages/UserPage/UserPage'));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage/NotFoundPage'));
const AuthModal = lazy(() => import('@/components/AuthModal'));
import { Toaster } from '@/components/ui/sonner';
import { RequireAdmin } from '@/components/RequireAdmin';
import { RequireAuth } from '@/components/RequireAuth';
const CustomerServiceFloat = lazy(() => import('@/components/CustomerServiceFloat'));

// 后台按路由切块：未进入后台时不下载后台页面及图表/编辑器依赖。
const AdminLayout = lazy(() => import('@/components/layouts/AdminLayout').then(m => ({ default: m.AdminLayout })));
const ConsolePage = lazy(() => import('@/pages/Admin/ConsolePage'));
const AgentsPage = lazy(() => import('@/pages/Admin/AgentsPage'));
const UsersPage = lazy(() => import('@/pages/Admin/UsersPage'));
const SamplesPage = lazy(() => import('@/pages/Admin/SamplesPage'));
const ReferenceStylesReviewPage = lazy(() => import('@/pages/Admin/ReferenceStylesReviewPage'));
const TransactionsPage = lazy(() => import('@/pages/Admin/TransactionsPage'));
const SkillsPage = lazy(() => import('@/pages/Admin/SkillsPage'));
const EcommerceAdminPage = lazy(() => import('@/pages/Admin/EcommerceAdminPage'));
const MonitorPage = lazy(() => import('@/pages/Admin/MonitorPage'));
const LogsPage = lazy(() => import('@/pages/Admin/LogsPage'));
const ErrorLogsPage = lazy(() => import('@/pages/Admin/ErrorLogsPage'));
const MonitoringPage = lazy(() => import('@/pages/Admin/MonitoringPage'));
const MonitoringStandalonePage = lazy(() => import('@/pages/Admin/MonitoringStandalonePage'));
const FinancePage = lazy(() => import('@/pages/Admin/FinancePage'));
const PaymentSettingsPage = lazy(() => import('@/pages/Admin/PaymentSettingsPage'));
const AdminPlaceholderPage = lazy(() => import('@/pages/Admin/AdminPlaceholderPage'));
const SystemSettingsPage = lazy(() => import('@/pages/Admin/SystemSettingsPage'));
const LedgerPage = lazy(() => import('@/pages/Admin/LedgerPage'));

// 创作工作室 / 电商按访问加载。
const StudioLayout = lazy(() => import('@/components/layouts/StudioLayout').then(m => ({ default: m.StudioLayout })));
const StudioListPage = lazy(() => import('@/pages/Studio/StudioListPage'));
const StudioCanvasPage = lazy(() => import('@/pages/Studio/StudioCanvasPage'));
const ShopLayout = lazy(() => import('@/components/layouts/ShopLayout').then(m => ({ default: m.ShopLayout })));
const ShopHomePage = lazy(() => import('@/pages/Shop/ShopHomePage'));
const ProductDetailPage = lazy(() => import('@/pages/Shop/ProductDetailPage'));
const CartPage = lazy(() => import('@/pages/Shop/CartPage'));
const CheckoutPage = lazy(() => import('@/pages/Shop/CheckoutPage'));
const OrdersPage = lazy(() => import('@/pages/Shop/OrdersPage'));
const SellerPage = lazy(() => import('@/pages/Shop/SellerPage'));
const ScopeDeniedPage = lazy(() => import('@/pages/ScopeDeniedPage'));
const AuthPage = lazy(() => import('@/pages/Auth/AuthPage'));
const SetupWizardPage = lazy(() => import('@/pages/Setup/SetupWizardPage'));
const RechargePage = lazy(() => import('@/pages/RechargePage/RechargePage'));

const HelpCenterPage = lazy(() => import('@/pages/Support').then(m => ({ default: m.HelpCenterPage })));
const DocsPage = lazy(() => import('@/pages/Support').then(m => ({ default: m.DocsPage })));
const ChangelogPage = lazy(() => import('@/pages/Support').then(m => ({ default: m.ChangelogPage })));
const TutorialsPage = lazy(() => import('@/pages/Support').then(m => ({ default: m.TutorialsPage })));
const AboutPage = lazy(() => import('@/pages/Support').then(m => ({ default: m.AboutPage })));
const GuidePage = lazy(() => import('@/pages/Support').then(m => ({ default: m.GuidePage })));
const FeedbackPage = lazy(() => import('@/pages/Support').then(m => ({ default: m.FeedbackPage })));
const ReportPage = lazy(() => import('@/pages/Support').then(m => ({ default: m.ReportPage })));
const PrivacyPage = lazy(() => import('@/pages/Support').then(m => ({ default: m.PrivacyPage })));
import { getSetupStatus } from '@/services/api';

function DeferredGlobalUi() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const win = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (win.requestIdleCallback) {
      const id = win.requestIdleCallback(() => setReady(true), { timeout: 1500 });
      return () => win.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(() => setReady(true), 500);
    return () => window.clearTimeout(id);
  }, []);
  if (!ready) return null;
  return <><AuthModal /><CustomerServiceFloat /></>;
}

function RouteSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="grid h-screen place-items-center bg-black text-sm text-zinc-500">正在加载…</div>}>{children}</Suspense>;
}

// 首次部署：未初始化时访问站点根路径自动跳到 /setup 向导（完成后恢复着陆页）
function FirstRunGate({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  useEffect(() => {
    getSetupStatus()
      .then((s) => { if (!s.initialized) navigate('/setup', { replace: true }); })
      .catch(() => {});
  }, [navigate]);
  return <>{children}</>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <RouteSuspense>
      <Routes>
        {/* 独立承接页（未初始化时自动跳转初始化向导） */}
        <Route path="/" element={<FirstRunGate><LandingPage /></FirstRunGate>} />

        {/* 登录 / 注册（独立全屏，不走前台壳） */}
        <Route path="/login" element={<AuthPage />} />
        <Route path="/register" element={<AuthPage />} />

        {/* 首次部署初始化向导（独立全屏，不走前台壳） */}
        <Route path="/setup" element={<SetupWizardPage />} />

        {/* 独立充值承接页（全屏沉浸式，不嵌套在 Layout 里） */}
        <Route path="/recharge" element={<RechargePage />} />

        {/* 前台工作台壳（原有素材/角色/模型功能） */}
        <Route element={<Layout />}>
          <Route path="workspace" element={<RequireAuth><WorkspacePage /></RequireAuth>} />
          <Route path="library/:category?" element={<RequireAuth><LibraryPage /></RequireAuth>} />
          <Route path="characters" element={<RequireAuth><CharactersPage /></RequireAuth>} />
          <Route path="model-console" element={<RequireAuth><ModelConsole /></RequireAuth>} />
          <Route path="edit/:id" element={<RequireAuth><ImageEditorPage /></RequireAuth>} />
          <Route path="account" element={<RequireAuth><AccountPage /></RequireAuth>} />
          {/* 创作者公开主页（无需登录，可分享） */}
          <Route path="user/:id" element={<UserPage />} />

          {/* 帮助 / 文档 / 更新 / 教程 / 关于 / 指南 / 隐私（公开浏览） */}
          <Route path="help" element={<HelpCenterPage />} />
          <Route path="docs" element={<DocsPage />} />
          <Route path="changelog" element={<ChangelogPage />} />
          <Route path="tutorials" element={<TutorialsPage />} />
          <Route path="about" element={<AboutPage />} />
          <Route path="guide" element={<GuidePage />} />
          <Route path="privacy" element={<PrivacyPage />} />

          {/* 反馈 / 举报（需登录） */}
          <Route path="feedback" element={<RequireAuth><FeedbackPage /></RequireAuth>} />
          <Route path="report" element={<RequireAuth><ReportPage /></RequireAuth>} />
        </Route>

        {/* 管理后台壳（整区需管理员 — 登录检查放这里，角色检查交给 AdminLayout 提供更友好的"无权限"页）
            之前 RequireAdmin 包外层会在 user 还在异步恢复或角色不匹配时直接 <Navigate to="/" replace />，
            用户体验是"F5 立刻被丢到主页，看不到原因"，改为 RequireAuth 后，角色不符场景由 AdminLayout 自渲染提示页。 */}
        <Route path="/admin" element={<RequireAuth><AdminLayout /></RequireAuth>}>
          <Route index element={<ConsolePage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="samples" element={<SamplesPage />} />
          <Route path="reference-styles" element={<ReferenceStylesReviewPage />} />
          <Route path="models" element={<ModelPricePage />} />
          <Route path="routing" element={<RoutingPage />} />
          <Route path="transactions" element={<TransactionsPage />} />
          <Route path="skills" element={<SkillsPage />} />
          <Route path="ecommerce" element={<EcommerceAdminPage />} />
          <Route path="monitor" element={<MonitorPage />} />
          <Route path="finance" element={<FinancePage />} />
          <Route path="payment-settings" element={<PaymentSettingsPage />} />
          <Route path="logs" element={<LogsPage />} />
          <Route path="errors" element={<ErrorLogsPage />} />
          <Route path="monitoring" element={<MonitoringPage />} />
          {/* 模型状态：密钥池待命/冷却实时态 */}
          <Route path="key-pool" element={<KeyPoolPage />} />
          {/* 系统设置：平台级配置聚合（当前承载工作台模型排序） */}
          <Route path="settings" element={<SystemSettingsPage />} />
          <Route path="storage" element={<AdminPlaceholderPage title="存储管理" note="OSS  bucket、CDN、配额与资产生命周期管理（oss_config 表已就绪）。" />} />
          <Route path="ledger" element={<LedgerPage />} />
          <Route path="recommend" element={<AdminPlaceholderPage title="推荐管理" note="排序、精选、个性化分发与搜索调权。" />} />
          <Route path="studio" element={<AdminPlaceholderPage title="创作空间管理" note="项目 / 画布 / 流水线等创作空间的运维治理。" />} />
        </Route>

        {/* 模型 Hub：供给侧核心，共享管理后台导航以保持体验一致。URL 保持 /model-hub 不变。 */}
        <Route path="/model-hub" element={<RequireAuth><AdminLayout /></RequireAuth>}>
          <Route index element={<ModelHubPage />} />
        </Route>

        {/* 全局监控独立弹出页（不走 AdminLayout，全屏单 tab 视图） */}
        <Route path="/monitoring/:tab" element={<RequireAdmin><MonitoringStandalonePage /></RequireAdmin>} />

        {/* 创作工作室壳（需登录） */}
        <Route path="/studio" element={<RequireAuth><QueryClientProvider client={queryClient}><StudioLayout /></QueryClientProvider></RequireAuth>}>
          <Route index element={<StudioListPage />} />
          <Route path=":projectId" element={<StudioCanvasPage />} />
        </Route>

        {/* 电商商城壳（M6）— S1 scope firewall: SHOP_ENABLED flag OFF by default.
            When OFF, direct access to /shop/* shows ScopeDeniedPage; code is preserved.
            Set VITE_FF_SHOP_ENABLED=1 to re-enable (dev/UAT only). */}
        {isFeatureEnabled(FF.SHOP_ENABLED) ? (
          <Route path="/shop" element={<ShopLayout />}>
            <Route index element={<ShopHomePage />} />
            <Route path="product/:id" element={<ProductDetailPage />} />
            <Route path="cart" element={<RequireAuth><CartPage /></RequireAuth>} />
            <Route path="checkout" element={<RequireAuth><CheckoutPage /></RequireAuth>} />
            <Route path="orders" element={<RequireAuth><OrdersPage /></RequireAuth>} />
            <Route path="seller" element={<RequireAuth><SellerPage /></RequireAuth>} />
          </Route>
        ) : (
          <Route path="/shop" element={<ScopeDeniedPage title="AI 市集（已锁定）" desc="电商/市集功能不在当前 1.0 产品方向内，代码已保留但默认关闭。" />} />
        )}

        {/* V2 preview shell (M00) — additive, feature-flag + dev gated. */}
        <Route path="/__v2/*" element={<V2Suspense><V2App /></V2Suspense>} />

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <DeferredGlobalUi />
      <Toaster />
      </RouteSuspense>
    </ErrorBoundary>
  );
}
