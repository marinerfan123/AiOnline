// 电商商城 Layout 壳（M6 电商模块 / Phase 5）
// 左侧：统一导航台（NavigationDock），分类/搜索/购物车/用户菜单均迁入导航台。
import { Outlet } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { NavigationDock, MobileDockBar } from '@/components/NavigationDock';
import { shopDockConfig } from '@/components/navigationDockConfigs';
import { useAuth } from '@/services/authStore';

export function ShopLayout() {
  const { user } = useAuth();
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

  const dockProps = shopDockConfig(user?.role);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-black text-white">
      <NavigationDock
        {...dockProps}
        mobileOpen={mobileDockOpen}
        onMobileClose={() => setMobileDockOpen(false)}
      />
      <div className="flex flex-1 flex-col min-w-0">
        <MobileDockBar title="AI 市集" onOpen={() => setMobileDockOpen(true)} />
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
