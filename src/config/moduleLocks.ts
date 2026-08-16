// 模块锁定 · 单一事实来源
// ─────────────────────────────────────────────────────────────
// 全站所有「尚未完善」的模块都在这里集中登记。
// 解锁某模块只需把对应项从 LOCKED_MODULES 移除（或置 enabled:false），
// 以下 4 个入口会自动跟随，无需改其它文件：
//   1. 路由网关  ModuleLockGate（app.tsx）
//   2. 顶部产品切换 ProductSwitcher
//   3. 全局导航台 globalNavSection（navigationDockConfigs.ts）
//   4. 落地页 CTA（LandingPage.tsx）
// 该机制是「可逆软锁」，不依赖环境变量，便于上线后逐步解封。

export interface LockedModule {
  /** 路由前缀，命中即锁定（含所有子路由，如 /studio、/studio/123） */
  prefix: string;
  /** 锁页标题 */
  title: string;
  /** 即将上线描述 */
  desc: string;
  /** 预计上线阶段（纯展示） */
  eta?: string;
}

export const LOCKED_MODULES: LockedModule[] = [
  {
    prefix: '/studio',
    title: '创作工作室',
    desc: '五阶段创作流水线（点子 → 剧本 → 分镜 → 视频 → 剧集）正在紧锣密鼓打磨中，敬请期待。当前可先用「工作台」完成生图与生视频。',
    eta: 'Phase 4',
  },
];

/**
 * 判断 pathname 是否命中锁定模块；命中返回元数据，否则返回 null。
 * 同时兼容「精确前缀」与「前缀 + 子路由」两种情况。
 */
export function getLockedModule(pathname: string): LockedModule | null {
  for (const m of LOCKED_MODULES) {
    if (pathname === m.prefix || pathname.startsWith(m.prefix + '/')) {
      return m;
    }
  }
  return null;
}

/** 判断某个导航路径是否处于锁定前缀之下（用于导航项过滤） */
export function isPathLocked(path: string): boolean {
  return getLockedModule(path) !== null;
}
