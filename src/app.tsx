import { useEffect, type ReactNode } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import LandingPage from '@/pages/LandingPage/LandingPage';
import WorkspacePage from '@/pages/WorkspacePage/WorkspacePage';
import ImageEditorPage from '@/pages/ImageEditorPage/ImageEditorPage';
import LibraryPage from '@/pages/LibraryPage/LibraryPage';
import CharactersPage from '@/pages/CharactersPage/CharactersPage';
import ModelHubPage from '@/pages/ModelHubPage/ModelHubPage';
import ModelConsole from '@/pages/ModelConsole/ModelConsole';
import ModelPricePage from '@/pages/Admin/ModelPricePage';
import RoutingPage from '@/pages/Admin/RoutingPage';
import AccountPage from '@/pages/AccountPage/AccountPage';
import UserPage from '@/pages/UserPage/UserPage';
import NotFoundPage from '@/pages/NotFoundPage/NotFoundPage';
import AuthModal from '@/components/AuthModal';
import { Toaster } from '@/components/ui/sonner';
import { RequireAdmin } from '@/components/RequireAdmin';
import { RequireAuth } from '@/components/RequireAuth';

// 后台（M3 总控台 / M4 智能体 / M2 流水 / 用户 / 技能 / 电商后台）
import { AdminLayout } from '@/components/layouts/AdminLayout';
import ConsolePage from '@/pages/Admin/ConsolePage';
import AgentsPage from '@/pages/Admin/AgentsPage';
import UsersPage from '@/pages/Admin/UsersPage';
import SamplesPage from '@/pages/Admin/SamplesPage';
import ReferenceStylesReviewPage from '@/pages/Admin/ReferenceStylesReviewPage';
import TransactionsPage from '@/pages/Admin/TransactionsPage';
import SkillsPage from '@/pages/Admin/SkillsPage';
import EcommerceAdminPage from '@/pages/Admin/EcommerceAdminPage';
import MonitorPage from '@/pages/Admin/MonitorPage';
import LogsPage from '@/pages/Admin/LogsPage';
import ErrorLogsPage from '@/pages/Admin/ErrorLogsPage';
import MonitoringPage from '@/pages/Admin/MonitoringPage';
import MonitoringStandalonePage from '@/pages/Admin/MonitoringStandalonePage';
import FinancePage from '@/pages/Admin/FinancePage';
import PaymentSettingsPage from '@/pages/Admin/PaymentSettingsPage';
import AdminPlaceholderPage from '@/pages/Admin/AdminPlaceholderPage';
import SystemSettingsPage from '@/pages/Admin/SystemSettingsPage';
import LedgerPage from '@/pages/Admin/LedgerPage';

// 创作工作室（M5 流水线）
import { StudioLayout } from '@/components/layouts/StudioLayout';
import StudioListPage from '@/pages/Studio/StudioListPage';
import StudioStagePage from '@/pages/Studio/StudioStagePage';

// 电商（M6）
import { ShopLayout } from '@/components/layouts/ShopLayout';
import ShopHomePage from '@/pages/Shop/ShopHomePage';
import ProductDetailPage from '@/pages/Shop/ProductDetailPage';
import CartPage from '@/pages/Shop/CartPage';
import CheckoutPage from '@/pages/Shop/CheckoutPage';
import OrdersPage from '@/pages/Shop/OrdersPage';
import SellerPage from '@/pages/Shop/SellerPage';

// 登录 / 注册
import AuthPage from '@/pages/Auth/AuthPage';

// 首次部署初始化向导
import SetupWizardPage from '@/pages/Setup/SetupWizardPage';
import RechargePage from '@/pages/RechargePage/RechargePage';
import { getSetupStatus } from '@/services/api';

// 帮助 / 文档 / 反馈 / 法律 / 关于
import {
  HelpCenterPage, DocsPage, ChangelogPage, TutorialsPage,
  AboutPage, GuidePage, FeedbackPage, ReportPage, PrivacyPage,
} from '@/pages/Support';

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
        <Route path="/studio" element={<RequireAuth><StudioLayout /></RequireAuth>}>
          <Route index element={<StudioListPage />} />
          <Route path=":projectId" element={<StudioStagePage />} />
        </Route>

        {/* 电商商城壳（首页/商品详情公开浏览；下单相关需登录） */}
        <Route path="/shop" element={<ShopLayout />}>
          <Route index element={<ShopHomePage />} />
          <Route path="product/:id" element={<ProductDetailPage />} />
          <Route path="cart" element={<RequireAuth><CartPage /></RequireAuth>} />
          <Route path="checkout" element={<RequireAuth><CheckoutPage /></RequireAuth>} />
          <Route path="orders" element={<RequireAuth><OrdersPage /></RequireAuth>} />
          <Route path="seller" element={<RequireAuth><SellerPage /></RequireAuth>} />
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <AuthModal />
      <Toaster />
    </ErrorBoundary>
  );
}
