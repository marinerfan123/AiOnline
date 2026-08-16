// 模块锁定路由网关
// 包裹在需要锁定的路由外层；若当前 pathname 命中锁定配置，
// 渲染 ModuleLocked 锁页，否则正常渲染子路由。
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { getLockedModule } from '@/config/moduleLocks';
import { ModuleLocked } from '@/components/ModuleLocked';

export function ModuleLockGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const locked = getLockedModule(location.pathname);
  if (locked) {
    return <ModuleLocked title={locked.title} desc={locked.desc} eta={locked.eta} />;
  }
  return <>{children}</>;
}
