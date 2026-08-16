import type { ReactNode } from 'react';
import { useAuth } from '@/services/authStore';
import { Navigate, useLocation } from 'react-router-dom';

// 管理员硬守卫：
// - 会话未就绪 → 显示校验中（避免闪烁/误判）
// - 未登录 → 跳登录页（带 from，登录后可回跳）
// - 已登录但非 admin → 跳首页（无权限，绝不渲染受保护内容）
// 注意：前端守卫只是 UX 层；真正的闸门在后端 requireAdmin（返回 403）。
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const location = useLocation();

  // DEV 调试：F5 跳走时可在这里看到 ready/user/role 真实值
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.debug('[RequireAdmin]', location.pathname, 'ready=', ready, 'role=', user?.role, 'email=', user?.email);
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
  // admin 与 system(dev token 身份) 都视为管理员：避免 dev 路径下刷新 admin 页面被误判踢回首页
  if (user.role !== 'admin' && user.role !== 'system') {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}
