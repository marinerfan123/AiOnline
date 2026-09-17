// 创作工作室 Layout 壳（M5 创意生产流水线 / Phase 4）
// 左侧：统一导航台（NavigationDock）；项目头与五阶段 Tab 由 StudioStagePage 内部渲染。
import { Outlet } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { NavigationDock, MobileDockBar } from '@/components/NavigationDock';
import { studioDockConfig } from '@/components/navigationDockConfigs';
import { useAuth } from '@/services/authStore';

export function StudioLayout() {
  const { user } = useAuth();
  const [mobileDockOpen, setMobileDockOpen] = useState(false);
  const [dockExpanded, setDockExpanded] = useState(false);

  useEffect(() => {
    if (mobileDockOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [mobileDockOpen]);

  const dockProps = studioDockConfig(user?.role);

  return (
    <div className="studio-app-shell flex h-screen w-full overflow-hidden bg-black text-white">
      <NavigationDock
        {...dockProps}
        expanded={dockExpanded}
        onExpandedChange={setDockExpanded}
        mobileOpen={mobileDockOpen}
        onMobileClose={() => setMobileDockOpen(false)}
      />
      <div className="studio-app-column flex min-w-0 flex-1 flex-col">
        <MobileDockBar title="创作工作室" onOpen={() => setMobileDockOpen(true)} />
        <main className="studio-app-main min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
