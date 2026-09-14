// V2 preview route — internal, feature-flag + dev gated. Production users are
// never switched (V2_APP_SHELL default is OFF in prod build). This is a
// preview shell with placeholder module pages; real modules land in Phase C+.
import { Route, Routes, Navigate, useNavigate } from 'react-router-dom';
import '@/shared/ui/tokens.css';
import { AppShellV2 } from '../shell/AppShellV2';
import { V2Providers } from '../providers/V2Providers';
import { isFeatureEnabled } from '@/shared/config/featureFlags';
import { RequireAuthV2, RequireAdminV2 } from '@/shared/auth/permissions';
import { V2AdminProvidersPage } from '@/features/admin-v2/V2AdminProviders';
import { V2AdminProviderDetailPage } from '@/features/admin-v2/V2AdminProviderDetail';
import ProjectsPage from '@/pages/ProjectsPage/ProjectsPage';
import CreateProjectPage from '@/pages/ProjectsPage/CreateProjectPage';
import ProjectOverviewPage from '@/pages/ProjectsPage/ProjectOverviewPage';
import ProjectAssetsPage from '@/pages/ProjectsPage/ProjectAssetsPage';
import StudioPage from '@/features/studio-v2/StudioPage';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/shared/ui/v2/Card';
import { Button } from '@/shared/ui/v2/Button';
import { StatusBadge } from '@/shared/ui/v2/StatusBadge';
import { useAppStore } from '@/shared/state/appStore';
import { useQuery } from '@tanstack/react-query';
import { v2 } from '@/shared/api/contract/client';

function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div className="p-6">
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{note}</CardDescription>
        </CardHeader>
        <CardContent>
          <StatusBadge status="queued" label="模块建设中" />
        </CardContent>
      </Card>
    </div>
  );
}

function Dashboard() {
  const credits = useAppStore((s) => s.creditBalance);
  const setCredits = useAppStore((s) => s.setCreditBalance);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const sidebar = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);

  const health = useQuery({
    queryKey: ['v2', 'health'],
    queryFn: () => v2.getHealth(),
    staleTime: 10_000,
    retry: 0,
  });

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Dashboard</h1>
        <p className="text-sm text-ml2-text-3">V2 平台基础预览 · 无业务模块</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>健康检查 (contract proof)</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {health.isLoading ? (
              <StatusBadge status="generating" label="检测中" />
            ) : health.data ? (
              <div className="flex items-center gap-2">
                <StatusBadge status={health.data.ok === false ? 'failed' : 'healthy'} />
                <span className="text-xs text-ml2-text-3">
                  {health.data.status ?? 'ok'}
                  {health.data.cpu?.shedding !== undefined ? ` · shedding=${health.data.cpu.shedding}` : ''}
                </span>
              </div>
            ) : (
              <StatusBadge status="down" label="后端未连接" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>积分 (appStore slot)</CardTitle></CardHeader>
          <CardContent className="flex items-center gap-3">
            <span className="text-lg tabular-nums">{credits === null ? '—' : credits}</span>
            <Button size="sm" variant="secondary" onClick={() => setCredits((credits ?? 0) + 100)}>
              +100
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Shell 状态</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={toggleSidebar}>侧栏: {sidebar ? '折叠' : '展开'}</Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              >
                主题: {theme}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Design System V2 冒烟</CardTitle>
          <CardDescription>核心原语可复用性验证（Button / Input / Select / Badge / Status / Card / Dialog）</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button loading>Loading</Button>
          <StatusBadge status="generating" />
          <StatusBadge status="completed" />
          <StatusBadge status="failed" />
        </CardContent>
      </Card>
    </div>
  );
}

function V2AppInner() {
  return (
    <AppShellV2>
      <Routes>
        <Route index element={<Dashboard />} />
        <Route path="admin/providers" element={<RequireAdminV2><V2AdminProvidersPage /></RequireAdminV2>} />
        <Route path="admin/providers/:providerId" element={<RequireAdminV2><V2AdminProviderDetailPage /></RequireAdminV2>} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/new" element={<CreateProjectPage />} />
        <Route path="projects/:projectId" element={<ProjectOverviewPage />} />
        <Route path="projects/:projectId/assets" element={<ProjectAssetsPage />} />
        <Route path="projects/:projectId/studio" element={<StudioPage />} />
        <Route path="create" element={<Placeholder title="Create" note="快速创作（Phase C）" />} />
        <Route path="assets" element={<Placeholder title="Assets" note="资产模块（Phase D）" />} />
        <Route path="characters" element={<Placeholder title="Characters" note="角色模块（Phase D）" />} />
        <Route path="models" element={<Placeholder title="Models" note="模型目录（Phase C）" />} />
        <Route path="tasks" element={<Placeholder title="Tasks" note="任务中心（Phase C）" />} />
        <Route path="billing" element={<Placeholder title="Billing" note="计费模块（Phase C）" />} />
        <Route path="settings" element={<Placeholder title="Settings" note="设置模块（Phase C）" />} />
        <Route path="studio" element={<Placeholder title="Studio" note="无限画布（Phase E，V2_STUDIO flag）" />} />
        <Route path="*" element={<Navigate to="/__v2" replace />} />
      </Routes>
    </AppShellV2>
  );
}

export default function V2App() {
  const navigate = useNavigate();
  const flagOn = isFeatureEnabled('V2_APP_SHELL');
  if (!flagOn) {
    // Prod-safe fallback: never expose V2 when the flag is off.
    return (
      <V2Providers>
        <div className="ml2 grid h-full place-items-center">
          <Card className="max-w-sm text-center">
            <CardHeader>
              <CardTitle>V2 预览未启用</CardTitle>
              <CardDescription>feature flag V2_APP_SHELL 关闭（生产默认关闭）。</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="secondary" onClick={() => navigate('/')}>返回主站</Button>
            </CardContent>
          </Card>
        </div>
      </V2Providers>
    );
  }
  return (
    <V2Providers>
      <RequireAuthV2>
        <V2AppInner />
      </RequireAuthV2>
    </V2Providers>
  );
}
