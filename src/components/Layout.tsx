import { Outlet, useOutletContext } from 'react-router-dom';
import { useState, useEffect, useMemo } from 'react';
import { NavigationDock, MobileDockBar } from '@/components/NavigationDock';
import { workspaceDockConfig } from '@/components/navigationDockConfigs';
import { useMediaCounts } from '@/hooks/useMediaCounts';
import { useAuth } from '@/services/authStore';

/** 子路由（LibraryPage / WorkspacePage 等）通过 useOutletContext 拿到，删除/生成后立刻刷新侧边栏计数 */
export type LayoutOutletCtx = { refreshMediaCounts: () => Promise<void> };
export function useLayoutOutlet() {
  return useOutletContext<LayoutOutletCtx>();
}

export function Layout() {
  const { user } = useAuth();
  const [mobileDockOpen, setMobileDockOpen] = useState(false);
  const { counts, refresh } = useMediaCounts();

  // 路由变化或抽屉状态变化时锁 body 滚动（抽屉打开时防止背景跟随滚）
  useEffect(() => {
    if (mobileDockOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [mobileDockOpen]);

  const dockProps = workspaceDockConfig(counts, user?.role);
  const outletCtx = useMemo<LayoutOutletCtx>(() => ({ refreshMediaCounts: refresh }), [refresh]);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-black text-white">
      {/* 桌面端：inline aside；移动端（< md）由 NavigationDock 内部 fixed drawer 渲染 */}
      <NavigationDock
        {...dockProps}
        mobileOpen={mobileDockOpen}
        onMobileClose={() => setMobileDockOpen(false)}
      />
      <div className="flex flex-1 flex-col min-w-0">
        {/* 移动端顶部汉堡：仅 < md 显示 */}
        <MobileDockBar title="工作台" onOpen={() => setMobileDockOpen(true)} />
        <main className="flex-1 min-h-0 overflow-hidden">
          <Outlet context={outletCtx} />
        </main>
      </div>
    </div>
  );
}
