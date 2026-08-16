// src/components/NavigationDock.tsx — 全局可折叠导航台
//
// 设计目标：每个页面左侧都有一个统一的「导航控制台」，内容随当前模块变化；
// 支持展开/收起（持久化到 localStorage）、移动端抽屉、搜索、分组、角标、底部工具。
//
// 使用方式：
//   import { NavigationDock } from '@/components/NavigationDock';
//   import { workspaceDockConfig } from '@/components/navigationDockConfigs';
//   <NavigationDock {...workspaceDockConfig(counts)} />

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Search,
  MoreVertical,
  Menu,
} from 'lucide-react';
import { cn } from '@/components/skeleton';

export interface NavMenuItem {
  key: string;
  label: string;
  icon: LucideIcon;
  count?: number;
  path?: string;
  onClick?: () => void;
  end?: boolean;
  hidden?: boolean;
  danger?: boolean;
  children?: NavMenuItem[];
}

export interface NavSection {
  title?: string;
  items: NavMenuItem[];
  /** 是否可折叠为手风琴：点击标题展开/收起其子项，且同一时刻仅一个大类展开 */
  collapsible?: boolean;
  /** 默认是否展开（仅 collapsible 生效） */
  defaultExpanded?: boolean;
}

export interface NavHeader {
  title: string;
  backTo?: string;
  backLabel?: string;
  menu?: Omit<NavMenuItem, 'path' | 'children'>[];
}

export interface NavigationDockProps {
  header?: NavHeader;
  showSearch?: boolean;
  searchPlaceholder?: string;
  onSearch?: (q: string) => void;
  sections: NavSection[];
  /** 底部动作（如「工具」下拉）；不传则只显示收起/展开按钮 */
  bottomActions?: NavMenuItem[];
  /** localStorage 状态键，不同模块可独立记忆展开/收起 */
  storageKey?: string;
  /** 受控展开；不传则组件内部管理并持久化 */
  expanded?: boolean;
  onExpandedChange?: (v: boolean) => void;
  /** 移动端抽屉是否打开 */
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  collapseLabel?: string;
  expandLabel?: string;
}

const DOCK_EXPANDED_WIDTH = 240;
const DOCK_COLLAPSED_WIDTH = 64;
const STORAGE_PREFIX = 'nav-dock:';

function usePersistedExpanded(storageKey: string, defaultValue = true) {
  const [expanded, setExpanded] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + storageKey);
      return raw == null ? defaultValue : raw === '1';
    } catch {
      return defaultValue;
    }
  });
  const set = (v: boolean | ((prev: boolean) => boolean)) => {
    setExpanded((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      try {
        localStorage.setItem(STORAGE_PREFIX + storageKey, next ? '1' : '0');
      } catch {}
      return next;
    });
  };
  return [expanded, set] as const;
}

function isPathActive(path: string | undefined, locationPath: string, end = false) {
  if (!path) return false;
  if (end) return locationPath === path;
  return locationPath === path || locationPath.startsWith(`${path}/`);
}

function filterVisible(items: NavMenuItem[]) {
  return items.filter((i) => !i.hidden);
}

/** 单个导航项 */
function DockNavItem({
  item,
  collapsed,
  active,
  onNavigate,
  indent = false,
}: {
  item: NavMenuItem;
  collapsed: boolean;
  active: boolean;
  onNavigate?: () => void;
  /** 是否为手风琴展开的子项（缩进显示） */
  indent?: boolean;
}) {
  const Icon = item.icon;
  const navigate = useNavigate();

  const content = (
    <>
      <Icon
        className={cn(
          'size-4 shrink-0 transition-colors',
          active ? 'text-emerald-400' : 'text-zinc-400 group-hover:text-white',
        )}
      />
      {!collapsed && (
        <>
          <span className="truncate text-sm">{item.label}</span>
          {item.count != null && item.count > 0 && (
            <span
              className={cn(
                'ml-auto text-[10px] font-semibold tabular-nums px-1.5 min-w-[20px] text-center rounded-full transition-colors',
                active
                  ? 'bg-emerald-500/25 text-emerald-300'
                  : 'bg-zinc-800 text-zinc-400 group-hover:bg-zinc-700',
              )}
            >
              {item.count}
            </span>
          )}
        </>
      )}
    </>
  );

  const className = cn(
    'group flex items-center gap-3 rounded-2xl transition-all duration-200 border',
    collapsed
      ? 'justify-center px-2 py-2.5'
      : indent
        ? 'ml-2 pl-6 pr-3 py-2.5'
        : 'px-3 py-2.5',
    active
      ? 'bg-emerald-500/10 text-emerald-300 font-medium border-emerald-500/20'
      : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-white border-transparent',
  );

  if (item.path) {
    return (
      <NavLink
        to={item.path}
        end={item.end}
        onClick={onNavigate}
        className={className}
        title={collapsed ? item.label : undefined}
      >
        {content}
      </NavLink>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        item.onClick?.();
        onNavigate?.();
      }}
      className={cn(className, 'w-full text-left')}
      title={collapsed ? item.label : undefined}
    >
      {content}
    </button>
  );
}

/** 底部可展开动作（如「工具」） */
function DockBottomAction({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavMenuItem;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const Icon = item.icon;
  const containerRef = useRef<HTMLDivElement>(null);

  // 收起时自动关闭下拉
  useEffect(() => {
    if (collapsed) setOpen(false);
  }, [collapsed]);

  const handleParentClick = () => {
    if (item.children?.length) {
      setOpen(!open);
    } else {
      item.onClick?.();
      onNavigate?.();
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={handleParentClick}
        className={cn(
          'group flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-sm text-zinc-400 hover:bg-zinc-800/60 hover:text-white transition-all duration-200',
          collapsed ? 'justify-center' : '',
        )}
        title={collapsed ? item.label : undefined}
      >
        <Icon className="size-4 shrink-0" />
        {!collapsed && (
          <>
            <span className="flex-1 truncate text-left">{item.label}</span>
            {item.children?.length && (
              <ChevronDown
                className={cn('size-3 transition-transform', open && 'rotate-180')}
              />
            )}
          </>
        )}
      </button>

      {open && !collapsed && item.children?.length && (
        <>
          <div
            className="fixed inset-0 z-30"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute left-0 bottom-full z-40 mb-1.5 w-52 rounded-2xl border border-zinc-800 bg-zinc-900 p-1.5 shadow-2xl shadow-black/60">
            {filterVisible(item.children).map((child) => {
              const ChildIcon = child.icon;
              const childClass = cn(
                'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors',
                child.danger
                  ? 'text-red-400 hover:bg-zinc-800/70'
                  : 'text-white hover:bg-zinc-800/70',
              );
              const childIconClass = cn(
                'size-4 shrink-0',
                child.danger ? 'text-red-400' : 'text-emerald-400',
              );
              const childContent = (
                <>
                  <ChildIcon className={childIconClass} />
                  <span className="truncate">{child.label}</span>
                </>
              );
              const handleClick = () => {
                child.onClick?.();
                setOpen(false);
                onNavigate?.();
              };
              if (child.path) {
                return (
                  <Link
                    key={child.key}
                    to={child.path}
                    onClick={handleClick}
                    className={childClass}
                  >
                    {childContent}
                  </Link>
                );
              }
              return (
                <button
                  key={child.key}
                  type="button"
                  onClick={handleClick}
                  className={childClass}
                >
                  {childContent}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** 导航台主体（桌面 aside + 移动抽屉共用） */
function DockBody({
  header,
  showSearch,
  searchPlaceholder = '搜索',
  onSearch,
  sections,
  bottomActions,
  collapsed,
  onToggleCollapsed,
  onNavigate,
  collapseLabel = '收起',
  expandLabel = '展开',
}: {
  header?: NavHeader;
  showSearch?: boolean;
  searchPlaceholder?: string;
  onSearch?: (q: string) => void;
  sections: NavSection[];
  bottomActions?: NavMenuItem[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNavigate?: () => void;
  collapseLabel?: string;
  expandLabel?: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useState('');
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const searching = search.trim().length > 0;

  const visibleSections = useMemo(() => {
    const q = searching ? search.trim().toLowerCase() : '';
    return sections
      .map((s) => {
        const items = filterVisible(s.items).filter(
          (i) => !q || (i.label || '').toLowerCase().includes(q),
        );
        return { ...s, items };
      })
      .filter((s) => s.items.length > 0);
  }, [sections, searching, search]);
  const visibleBottom = useMemo(() => filterVisible(bottomActions || []), [bottomActions]);

  // 手风琴：同一时刻仅一个可折叠大类展开；默认展开标记为 defaultExpanded 的那个
  const [openSection, setOpenSection] = useState<string | null>(() => {
    const def = sections.find((s) => s.collapsible && s.defaultExpanded && s.title);
    return def ? (def.title as string) : null;
  });

  return (
    <>
      {/* 顶部：返回 + 项目/模块标题 */}
      {header && (
        <div className="flex items-center gap-2 px-3 py-3 shrink-0">
          <button
            type="button"
            onClick={() => {
              if (header.backTo) navigate(header.backTo);
              else navigate('/');
            }}
            title={header.backLabel || '返回'}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-zinc-400 hover:bg-zinc-800/60 hover:text-white transition-colors"
          >
            <ChevronLeft className="size-4" />
          </button>

          {!collapsed && (
            <div className="relative flex-1 min-w-0">
              {header.menu?.length ? (
                <>
                  <button
                    type="button"
                    onClick={() => setProjectMenuOpen(!projectMenuOpen)}
                    className="flex w-full items-center justify-between gap-1 rounded-2xl px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800/60 transition-colors"
                  >
                    <span className="truncate">{header.title}</span>
                    <MoreVertical className="size-4 shrink-0 text-zinc-500" />
                  </button>
                  {projectMenuOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={() => setProjectMenuOpen(false)}
                        aria-hidden="true"
                      />
                      <div className="absolute left-0 top-full z-50 mt-1 w-48 rounded-2xl border border-zinc-800 bg-zinc-900 p-1.5 shadow-2xl shadow-black/60">
                        {header.menu.map((m) => {
                          const MIcon = m.icon;
                          return (
                            <button
                              key={m.key}
                              type="button"
                              onClick={() => {
                                m.onClick?.();
                                setProjectMenuOpen(false);
                              }}
                              className={cn(
                                'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors',
                                m.danger
                                  ? 'text-red-400 hover:bg-zinc-800/70'
                                  : 'text-white hover:bg-zinc-800/70',
                              )}
                            >
                              <MIcon
                                className={cn(
                                  'size-4 shrink-0',
                                  m.danger ? 'text-red-400' : 'text-emerald-400',
                                )}
                              />
                              <span className="truncate">{m.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </>
              ) : (
                <div className="truncate px-3 py-2 text-sm font-medium text-white">
                  {header.title}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 搜索框 */}
      {showSearch && (
        <div className={cn('shrink-0', collapsed ? 'px-2 pb-2' : 'px-3 pb-2')}>
          {collapsed ? (
            <button
              type="button"
              title={searchPlaceholder}
              className="flex h-9 w-9 items-center justify-center rounded-xl text-zinc-400 hover:bg-zinc-800/60 hover:text-white transition-colors"
            >
              <Search className="size-4" />
            </button>
          ) : (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
              <input
                type="search"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  onSearch?.(e.target.value);
                }}
                placeholder={searchPlaceholder}
                className="w-full rounded-2xl bg-zinc-900 pl-9 pr-3 py-2 text-sm text-white placeholder:text-zinc-600 border border-zinc-800 focus:outline-none focus:border-emerald-500/50 transition-colors"
              />
            </div>
          )}
        </div>
      )}

      {/* 导航分组：滚动时隐藏滚动条，保持精致 */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-2 min-h-0 scrollbar-hidden">
        {visibleSections.map((section, idx) => {
          const sectionKey = section.title || `sec-${idx}`;
          const isCollapsible = !!section.collapsible && !!section.title && !collapsed;
          const isOpen = openSection === sectionKey;
          const showItems = !isCollapsible || isOpen || searching;
          return (
            <div key={sectionKey}>
              {!collapsed && section.title ? (
                isCollapsible ? (
                  <button
                    type="button"
                    onClick={() => setOpenSection(isOpen ? null : sectionKey)}
                    className="mt-5 mb-1.5 flex w-full items-center justify-between rounded-lg px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500 transition-colors hover:text-zinc-200"
                    aria-expanded={isOpen}
                  >
                    <span className="truncate">{section.title}</span>
                    <ChevronDown
                      className={cn(
                        'size-4 shrink-0 transition-transform duration-200',
                        isOpen && 'rotate-180 text-emerald-400',
                      )}
                    />
                  </button>
                ) : (
                  <div className="mt-5 mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-zinc-500">
                    {section.title}
                  </div>
                )
              ) : null}
              {collapsed && section.title && idx === 0 && (
                <div className="my-2 flex justify-center">
                  <div className="h-px w-6 bg-zinc-800" />
                </div>
              )}
              {showItems &&
                section.items.map((item) => (
                  <DockNavItem
                    key={item.key}
                    item={item}
                    collapsed={collapsed}
                    active={isPathActive(item.path, location.pathname, item.end)}
                    onNavigate={onNavigate}
                    indent={isCollapsible && isOpen && !collapsed}
                  />
                ))}
            </div>
          );
        })}
      </nav>

      {/* 底部分隔 + 动作 + 收起按钮 */}
      {visibleBottom.length > 0 && (
        <div className="shrink-0 border-t border-zinc-800 px-2 py-2 space-y-1">
          {visibleBottom.map((item) => (
            <DockBottomAction
              key={item.key}
              item={item}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          ))}
          <button
            type="button"
            onClick={onToggleCollapsed}
            className={cn(
              'group flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-sm text-zinc-400 hover:bg-zinc-800/60 hover:text-white transition-all duration-200',
              collapsed ? 'justify-center' : '',
            )}
            title={collapsed ? expandLabel : collapseLabel}
          >
            {collapsed ? (
              <ChevronRight className="size-4 shrink-0" />
            ) : (
              <>
                <ChevronLeft className="size-4 shrink-0" />
                <span className="truncate">{collapseLabel}</span>
              </>
            )}
          </button>
        </div>
      )}
    </>
  );
}

export function NavigationDock({
  header,
  showSearch,
  searchPlaceholder,
  onSearch,
  sections,
  bottomActions,
  storageKey = 'default',
  expanded: controlledExpanded,
  onExpandedChange,
  mobileOpen = false,
  onMobileClose,
  collapseLabel,
  expandLabel,
}: NavigationDockProps) {
  const [internalExpanded, setInternalExpanded] = usePersistedExpanded(storageKey, true);
  const expanded = controlledExpanded ?? internalExpanded;
  const setExpanded = (v: boolean) => {
    onExpandedChange?.(v);
    setInternalExpanded(v);
  };

  const width = expanded ? DOCK_EXPANDED_WIDTH : DOCK_COLLAPSED_WIDTH;

  return (
    <>
      {/* 桌面端：inline aside */}
      <aside
        className="hidden md:flex h-full shrink-0 flex-col border-r border-zinc-800 bg-black transition-[width] duration-300 ease-out"
        style={{ width }}
      >
        <DockBody
          header={header}
          showSearch={showSearch}
          searchPlaceholder={searchPlaceholder}
          onSearch={onSearch}
          sections={sections}
          bottomActions={bottomActions}
          collapsed={!expanded}
          onToggleCollapsed={() => setExpanded(!expanded)}
          collapseLabel={collapseLabel}
          expandLabel={expandLabel}
        />
      </aside>

      {/* 移动端：fixed 抽屉 */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={onMobileClose}
            aria-hidden="true"
          />
          <aside
            className="absolute left-0 top-0 bottom-0 flex flex-col border-r border-zinc-800 bg-black shadow-2xl shadow-black/60"
            style={{ width: DOCK_EXPANDED_WIDTH }}
          >
            <DockBody
              header={header}
              showSearch={showSearch}
              searchPlaceholder={searchPlaceholder}
              onSearch={onSearch}
              sections={sections}
              bottomActions={bottomActions}
              collapsed={false}
              onToggleCollapsed={() => {}}
              onNavigate={onMobileClose}
              collapseLabel={collapseLabel}
              expandLabel={expandLabel}
            />
          </aside>
        </div>
      )}
    </>
  );
}

/** 移动端顶部汉堡条（供各 Layout 使用，保持视觉一致） */
export function MobileDockBar({
  title,
  onOpen,
}: {
  title: string;
  onOpen: () => void;
}) {
  return (
    <div className="md:hidden flex items-center gap-2 border-b border-zinc-800 px-3 py-2 shrink-0">
      <button
        type="button"
        onClick={onOpen}
        aria-label="打开菜单"
        className="flex h-9 w-9 items-center justify-center rounded-xl text-zinc-300 hover:bg-zinc-800/60 hover:text-white transition-colors"
      >
        <Menu className="size-5" />
      </button>
      <span className="text-sm font-semibold text-zinc-200">{title}</span>
    </div>
  );
}
