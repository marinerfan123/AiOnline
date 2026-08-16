// 产品切换导航（全局「承接」）：让工作台 / 创作工作室 / AI 市集 / 管理后台
// 四个大区互相可达。横向药丸样式，用于 Studio / Shop 顶栏。
import { NavLink } from 'react-router-dom';
import { LayoutGrid, Clapperboard, ShoppingBag, ShieldAlert } from 'lucide-react';
import { useAuth } from '@/services/authStore';
import { cn } from '@/components/skeleton';

const PRODUCTS = [
  { to: '/workspace', label: '工作台', icon: LayoutGrid },
  { to: '/studio', label: '创作工作室', icon: Clapperboard },
  { to: '/shop', label: 'AI 市集', icon: ShoppingBag },
];

export function ProductSwitcher({ className = '' }: { className?: string }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const items = isAdmin
    ? [...PRODUCTS, { to: '/admin', label: '管理后台', icon: ShieldAlert }]
    : PRODUCTS;

  return (
    <nav
      className={cn(
        'flex items-center gap-1 rounded-full border border-zinc-800 bg-zinc-900/60 p-1 backdrop-blur',
        className,
      )}
    >
      {items.map((it) => {
        const Icon = it.icon;
        return (
          <NavLink
            key={it.to}
            to={it.to}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-200',
                isActive
                  ? 'bg-emerald-500 text-black shadow-sm shadow-emerald-500/30'
                  : 'text-zinc-400 hover:bg-zinc-800 hover:text-white',
              )
            }
          >
            <Icon className="size-3.5" />
            {it.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
