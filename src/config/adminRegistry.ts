// src/config/adminRegistry.ts
// 后台模块注册表（数据驱动导航的分发源）
//
// 设计目标：把"后台有哪些模块、怎么分组、挂什么路由"从 navigationDockConfigs 的
// 硬编码分组里抽离出来，改成一条条自描述的描述符。新增任何后台域（包括现在还
// 定义不清的"未来模块"）只需在此登记一条，导航自动归类、排序、渲染，核心零改动。
//
// 这是承接产品长期演进（11 → 30+ 模块）的地基：后端同步思路是把 handleAdmin /
// handleFinance / handleShop 收口成统一的 registerModule 分发（见架构规划）。
import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  Activity,
  ScrollText,
  XCircle,
  Database,
  Settings2,
  HardDrive,
  Cpu,
  SlidersHorizontal,
  Boxes,
  Bot,
  Clapperboard,
  Palette,
  Library,
  LineChart,
  Store,
  Sparkles,
  Users,
  Wallet,
  CreditCard,
  Receipt,
  Route,
} from 'lucide-react';

/** 后台模块归属的层级分组（对应长期架构的 L0~L3 + 总览） */
export type AdminGroup = 'overview' | 'platform' | 'supply' | 'demand' | 'people';

export interface AdminModule {
  key: string;
  label: string;
  icon: LucideIcon;
  /** 绝对路由；必须能在 app.tsx 的 /admin 或顶层路由命中，点击才不会 404 */
  path: string;
  group: AdminGroup;
  /** 精确匹配（避免 /admin/x 与 /admin/xy 串台），总览/顶层路由用 */
  end?: boolean;
  /** 建设中占位：导航自动追加「（建设中）」，并指向 AdminPlaceholderPage */
  comingSoon?: boolean;
}

/** 分组展示顺序；overview 不显示分组标题 */
export const ADMIN_GROUP_ORDER: { key: AdminGroup; title: string }[] = [
  { key: 'overview', title: '' },
  { key: 'platform', title: '平台基座' },
  { key: 'supply', title: '供给与成本' },
  { key: 'demand', title: '集市与推荐' },
  { key: 'people', title: '用户与财务' },
];

export const ADMIN_MODULES: AdminModule[] = [
  // ── 总览 ──────────────────────────────────────────────
  { key: 'admin-console', label: '运营总控台', icon: LayoutDashboard, path: '/admin', group: 'overview', end: true },

  // ── 平台基座（系统设置 / 存储 / 运行查看）──────────────────
  { key: 'admin-monitor', label: 'API 活动流', icon: Activity, path: '/admin/monitor', group: 'platform' },
  { key: 'admin-logs', label: '系统日志', icon: ScrollText, path: '/admin/logs', group: 'platform' },
  { key: 'admin-errors', label: '错误归档', icon: XCircle, path: '/admin/errors', group: 'platform' },
  { key: 'admin-monitoring', label: '业务诊断', icon: Database, path: '/admin/monitoring', group: 'platform' },
  { key: 'admin-settings', label: '系统设置', icon: Settings2, path: '/admin/settings', group: 'platform' },
  { key: 'admin-storage', label: '存储管理', icon: HardDrive, path: '/admin/storage', group: 'platform', comingSoon: true },

  // ── 供给与成本（模型 / 技能 / 智能体 / 创作空间 / 参考图 / 盈亏）──
  { key: 'admin-model-hub', label: '模型 Hub', icon: Cpu, path: '/model-hub', group: 'supply', end: true },
  { key: 'admin-models', label: '模型价格', icon: SlidersHorizontal, path: '/admin/models', group: 'supply' },
  { key: 'admin-routing', label: '智能路由', icon: Route, path: '/admin/routing', group: 'supply' },
  // 技能注册原本错挂"财务与电商"，后端实属 shop 域的能力注册表（市集+智能体共用），
  // 归到供给侧更贴切。
  { key: 'admin-skills', label: '技能注册', icon: Boxes, path: '/admin/skills', group: 'supply' },
  { key: 'admin-agents', label: '智能体层', icon: Bot, path: '/admin/agents', group: 'supply' },
  { key: 'admin-studio', label: '创作空间管理', icon: Clapperboard, path: '/admin/studio', group: 'supply', comingSoon: true },
  { key: 'admin-reference-styles', label: '参考样式审核', icon: Palette, path: '/admin/reference-styles', group: 'supply' },
  { key: 'admin-samples', label: '示例库', icon: Library, path: '/admin/samples', group: 'supply' },
  // 后端 /api/admin/ledger/summary（consumption_ledger 双边盈亏）已就绪，前端此前漏接，
  // 此处先占位，下一步接入真实盈亏看板。
  { key: 'admin-ledger', label: '盈亏看板', icon: LineChart, path: '/admin/ledger', group: 'supply', comingSoon: true },

  // ── 集市与推荐 ────────────────────────────────────────
  { key: 'admin-ecommerce', label: '电商后台', icon: Store, path: '/admin/ecommerce', group: 'demand' },
  { key: 'admin-recommend', label: '推荐管理', icon: Sparkles, path: '/admin/recommend', group: 'demand', comingSoon: true },

  // ── 用户与财务 ────────────────────────────────────────
  { key: 'admin-users', label: '用户管理', icon: Users, path: '/admin/users', group: 'people' },
  { key: 'admin-finance', label: '账务中心', icon: Wallet, path: '/admin/finance', group: 'people' },
  { key: 'admin-payment-settings', label: '支付设置', icon: CreditCard, path: '/admin/payment-settings', group: 'people' },
  { key: 'admin-transactions', label: '积分流水', icon: Receipt, path: '/admin/transactions', group: 'people' },
];
