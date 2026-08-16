import type { ReactNode } from 'react';
import { useAuth } from '@/services/authStore';
import { Navigate, useLocation } from 'react-router-dom';

// 登录守卫（普通用户）：
// - 会话未就绪 → 显示校验中（避免首屏闪烁/误判）
// - 未登录 → 跳登录页（带 from，登录后可回跳原目标）
// 注意：前端守卫只是 UX 层；真正的闸门在后端鉴权中间件（返回 401）。
// 管理员类路由请用 RequireAdmin（已含本组件的登录检查 + 额外 role 校验）。
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const location = useLocation();

  // DEV 调试：F5 跳走时可在这里看到 ready/user 真实值
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.debug('[RequireAuth]', location.pathname, 'ready=', ready, 'user=', user?.role, 'email=', user?.email);
  }

  if (!ready) {
    return (
      <div className="flex h-full w-full items-center justify-center text-sm text-zinc-500">
        正在校验会话…
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
}
