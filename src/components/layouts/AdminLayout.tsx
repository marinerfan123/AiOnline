// 后台管理 Layout 壳（Phase 2 管理后台 + M3 总控台 + M4 智能体层）
// 左侧：统一导航台（NavigationDock）+ 主区权限提示。
// 软 admin 守卫：骨架阶段展示权限提示横幅，但保留骨架可见性便于开发预览。
import { Outlet, useNavigate } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { useAuth, logout } from '@/services/authStore';
import { NavigationDock, MobileDockBar } from '@/components/NavigationDock';
import { adminDockConfig } from '@/components/navigationDockConfigs';
import { useState, useEffect } from 'react';

export function AdminLayout() {
  const { user, ready } = useAuth();
  const navigate = useNavigate();
  // 与 RequireAdmin 口径对齐：admin 与 system(dev token) 均视为管理员，
  // 否则 system 用户能过路由守卫却在壳层被判"无权限"（此前不一致）。
  const isAdmin = user?.role === 'admin' || user?.role === 'system';
  const [mobileDockOpen, setMobileDockOpen] = useState(false);

  useEffect(() => {
    if (mobileDockOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [mobileDockOpen]);

  const dockProps = adminDockConfig(user?.role);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-black text-white">
      <NavigationDock
        {...dockProps}
        mobileOpen={mobileDockOpen}
        onMobileClose={() => setMobileDockOpen(false)}
      />

      {/* 主区 */}
      <div className="flex flex-1 flex-col min-w-0">
        <MobileDockBar title="管理后台" onOpen={() => setMobileDockOpen(true)} />
        {!ready ? (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
            正在校验会话…
          </div>
        ) : !user ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <ShieldAlert className="size-8 text-zinc-600" />
            <p className="text-sm text-zinc-400">请先登录后再访问管理后台</p>
            <button
              onClick={() => navigate('/login')}
              className="rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 transition-colors"
            >
              前往登录
            </button>
          </div>
        ) : !isAdmin ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <ShieldAlert className="size-10 text-zinc-600" />
            <div>
              <p className="text-base font-medium text-zinc-200">无权限访问管理后台</p>
              <p className="mt-1 text-sm text-zinc-500">仅管理员账号可进入，请联系平台管理员获取权限。</p>
            </div>
            <button
              onClick={() => navigate('/')}
              className="rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-medium text-black hover:bg-emerald-400 transition-colors"
            >
              返回前台
            </button>
          </div>
        ) : (
          <main className="flex-1 overflow-y-auto">
            <Outlet />
          </main>
        )}
      </div>
    </div>
  );
}
