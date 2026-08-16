// src/components/navigationDockConfigs.ts — 各模块导航台预设配置

import type { LucideIcon } from 'lucide-react';
import {
  LayoutGrid,
  Image as ImageIcon,
  Video,
  User,
  FolderOpen,
  Sparkles,
  MoreHorizontal,
  Upload,
  Clapperboard,
  ShoppingBag,
  ShieldAlert,
  Settings2,
  Receipt,
  Store,
  Home,
  ShoppingCart,
  Package,
} from 'lucide-react';
import type { MediaCounts } from '@/services/api';
import type { NavigationDockProps, NavSection } from '@/components/NavigationDock';
import { ADMIN_MODULES, ADMIN_GROUP_ORDER } from '@/config/adminRegistry';

// ───────────────────────────────────────────────
// 全站跨模块导航（每个导航台底部都带，方便任意页面跳转）
// ───────────────────────────────────────────────
function globalNavSection(
  userRole?: string,
  opts?: { collapsible?: boolean; excludeWorkspace?: boolean },
): NavSection {
  const items = [
    ...(opts?.excludeWorkspace
      ? []
      : [{ key: 'global-workspace', label: '工作台', icon: LayoutGrid, path: '/workspace', end: true }]),
    { key: 'global-studio', label: '创作工作室', icon: Clapperboard, path: '/studio', end: true },
    { key: 'global-shop', label: 'AI 市集', icon: ShoppingBag, path: '/shop', end: true },
    ...(userRole === 'admin'
      ? [{ key: 'global-admin', label: '管理后台', icon: ShieldAlert, path: '/admin', end: true }]
      : []),
  ];
  return {
    title: '全站',
    items,
    ...(opts?.collapsible ? { collapsible: true } : {}),
  };
}

// ───────────────────────────────────────────────
// 1. 工作台 / 前台素材壳（对应用户截图）
// ───────────────────────────────────────────────
export function workspaceDockConfig(
  counts: MediaCounts | null,
  userRole?: string,
): NavigationDockProps {
  return {
    storageKey: 'workspace',
    // 不再按项目分栏：头部改为通用模块标题，去掉「重命名/删除项目」等项目级菜单
    header: {
      title: '工作台',
      backTo: '/',
      backLabel: '返回主页',
    },
    showSearch: true,
    searchPlaceholder: '搜索',
    sections: [
      // ── 总览（overview）────────────────────────
      {
        items: [
          {
            key: 'workspace',
            label: '工作台',
            icon: LayoutGrid,
            path: '/workspace',
            end: true,
            count: counts?.total,
          },
        ],
      },
      // ── 素材库（供给侧 supply）──────────────────
      // 后台注册表把模型 Hub / 参考图 / 示例库等归为供给侧；前台创作者的生产入口首先是素材库。
      {
        title: '素材库',
        collapsible: true,
        defaultExpanded: true,
        items: [
          { key: 'lib-all', label: '全部', icon: LayoutGrid, path: '/library', end: true, count: counts?.total },
          { key: 'lib-image', label: '图片', icon: ImageIcon, path: '/library/image', end: true, count: counts?.image },
          { key: 'lib-video', label: '视频', icon: Video, path: '/library/video', end: true, count: counts?.video },
          { key: 'lib-character', label: '角色', icon: User, path: '/library/character', end: true, count: counts?.character },
          { key: 'lib-scene', label: '场景', icon: FolderOpen, path: '/library/scene', end: true, count: counts?.scene },
          { key: 'lib-prop', label: '道具', icon: Sparkles, path: '/library/prop', end: true, count: counts?.prop },
          { key: 'lib-other', label: '其他', icon: MoreHorizontal, path: '/library/other', end: true, count: counts?.other },
          { key: 'lib-upload', label: '上传的内容', icon: Upload, path: '/library/upload', end: true, count: counts?.upload },
        ],
      },
      // ── 我的（用户与财务 people）────────────────
      // 角色管理是创作者的个人资产维护，与账户设置同属用户侧，避免和素材库「角色」分类混淆。
      {
        title: '我的',
        collapsible: true,
        items: [
          { key: 'characters', label: '角色管理', icon: User, path: '/characters', end: true },
          { key: 'account', label: '账户设置', icon: Settings2, path: '/account', end: true },
        ],
      },
      // ── 全站（跨模块跳转）──────────────────────
      // 与创作工作室、AI 市集保持一致：底部统一放置到其他主模块的入口。
      globalNavSection(userRole, { collapsible: true, excludeWorkspace: true }),
    ],
  };
}

// ───────────────────────────────────────────────
// 2. 管理后台壳
// ───────────────────────────────────────────────
// 由模块注册表（src/config/adminRegistry.ts）数据驱动生成后台导航。
// 新增 / 调整后台模块只需改注册表，这里不再写硬编码分组。
function buildAdminSections(): NavSection[] {
  const sections: NavSection[] = [];
  for (const g of ADMIN_GROUP_ORDER) {
    const mods = ADMIN_MODULES.filter((m) => m.group === g.key);
    if (!mods.length) continue;
    const items = mods.map((m) => ({
      key: m.key,
      label: m.comingSoon ? `${m.label}（建设中）` : m.label,
      icon: m.icon,
      path: m.path,
      end: m.end,
    }));
    sections.push(g.title ? { title: g.title, items } : { items });
  }
  return sections;
}

export function adminDockConfig(userRole?: string): NavigationDockProps {
  return {
    storageKey: 'admin',
    header: {
      title: '管理后台',
      backTo: '/workspace',
      backLabel: '返回前台',
    },
    showSearch: true,
    searchPlaceholder: '搜索管理项',
    // 模型 Hub 已是供给侧一级入口，移除冗余的「工具」菜单
    sections: [...buildAdminSections(), globalNavSection(userRole)],
  };
}

// ───────────────────────────────────────────────
// 3. 创作工作室壳
// ───────────────────────────────────────────────
export function studioDockConfig(userRole?: string): NavigationDockProps {
  return {
    storageKey: 'studio',
    header: {
      title: '创作工作室',
      backTo: '/workspace',
      backLabel: '返回前台',
    },
    showSearch: true,
    searchPlaceholder: '搜索项目',
    sections: [
      {
        items: [
          { key: 'studio-projects', label: '项目列表', icon: Clapperboard, path: '/studio', end: true },
        ],
      },
      {
        title: '当前项目',
        items: [
          { key: 'studio-stage', label: '流水线阶段', icon: LayoutGrid, path: '/studio', end: true },
          { key: 'studio-assets', label: '项目资产', icon: FolderOpen, path: '/studio' },
          { key: 'studio-roles', label: '角色设定', icon: User, path: '/studio' },
        ],
      },
      globalNavSection(userRole),
    ],
    // 底部只显示收起/展开按钮，保持工作室界面清爽
  };
}

// ───────────────────────────────────────────────
// 4. AI 市集 / 电商壳
// ───────────────────────────────────────────────
export function shopDockConfig(userRole?: string): NavigationDockProps {
  return {
    storageKey: 'shop',
    header: {
      title: 'AI 市集',
      backTo: '/workspace',
      backLabel: '返回前台',
    },
    showSearch: true,
    searchPlaceholder: '搜索商品',
    sections: [
      {
        items: [
          { key: 'shop-home', label: '全部商品', icon: ShoppingBag, path: '/shop', end: true },
        ],
      },
      {
        title: '分类',
        items: [
          { key: 'shop-art', label: '艺术周边', icon: Sparkles, path: '/shop?cat=art' },
          { key: 'shop-figure', label: '手办模型', icon: User, path: '/shop?cat=figure' },
          { key: 'shop-digital', label: '数字藏品', icon: ImageIcon, path: '/shop?cat=digital' },
          { key: 'shop-book', label: '出版物', icon: Package, path: '/shop?cat=book' },
        ],
      },
      {
        title: '我的',
        items: [
          { key: 'shop-cart', label: '购物车', icon: ShoppingCart, path: '/shop/cart' },
          { key: 'shop-orders', label: '我的订单', icon: Receipt, path: '/shop/orders' },
          { key: 'shop-seller', label: '卖家中心', icon: Store, path: '/shop/seller' },
        ],
      },
      globalNavSection(userRole),
    ],
    // 底部只显示收起/展开按钮
  };
}
