// ── Model UI — Custom Renderer Registry（L42，§13 注册面）───────────────────
//
// 规范锚点（墨渊 V2.0 §12-13）：
//   - §13 禁止 `if(model==="kling")` 式硬编码分支；renderer 以注册名
//     （renderer_id，如 `video.motion-control`）标识，新增模型不加代码分支。
//   - §12 ui_schema 通过 `rendererHint` 引用注册名（示例 `video.asset.first-frame`）。
//   - 本模块只做「注册面」：注册 / 按类型解析 / hint 解析 / 列表。它不渲染任何
//     节点（渲染接线留后续叶），也绝不改动既有节点渲染。
//
// 解析优先级（resolveRenderer）：
//   1. rendererHint（非空）→ 按 name 精确查找；命中即返回（hint 优先于 type）。
//      未命中 → null（调用方回退默认控件，绝不 throw）。
//   2. 无 hint → 按 forTypes 匹配 type；同 type 多命中取 priority 最高者，
//      同 priority 取 name 字典序更小者（稳定、确定）。
//   3. 皆不命中 → null。
//
// 注册覆盖语义（registerRenderer）：同 name 再注册时，仅当新 priority >= 旧
// priority 才覆盖；低优先级注册不降级既有高优先级 renderer。

import type { ComponentType } from 'react';

export interface RendererDefinition {
  /** 注册名（renderer_id）；ui_schema rendererHint 引用此名。 */
  name: string;
  /** 该 renderer 的组件（类型层面 React 组件；本模块不渲染、不实例化）。 */
  component: ComponentType<unknown>;
  /** 覆盖的字段类型（FormFieldType，如 'text' / 'number' / 'slider' / 'file'）。 */
  forTypes: string[];
  /** 覆盖优先级（默认 0）。 */
  priority?: number;
}

export interface RegisteredRenderer {
  name: string;
  component: ComponentType<unknown>;
  forTypes: readonly string[];
  priority: number;
}

export interface ResolveRendererInput {
  /** 字段类型（如 'number'）。 */
  type?: string;
  /** ui_schema rendererHint：注册名；存在时优先于 type 解析。 */
  rendererHint?: string;
}

const byName = new Map<string, RegisteredRenderer>();

/** 注册（或按优先级覆盖）一个 renderer。 */
export function registerRenderer(def: RendererDefinition): void {
  const priority = def.priority ?? 0;
  const existing = byName.get(def.name);
  // 同 name：低优先级注册不降级既有高优先级 renderer。
  if (existing && existing.priority > priority) return;
  byName.set(def.name, {
    name: def.name,
    component: def.component,
    forTypes: Object.freeze([...def.forTypes]),
    priority,
  });
}

/**
 * 解析 renderer。
 * - rendererHint 非空：按 name 精确命中返回；未知 hint → null（非 throw）。
 * - 无 hint：按 type 匹配，最高 priority 胜（tie → name 字典序）。
 * - 无 type 且无 hint：null。
 */
export function resolveRenderer(input: ResolveRendererInput = {}): RegisteredRenderer | null {
  const hint = input.rendererHint;
  if (typeof hint === 'string' && hint.trim() !== '') {
    return byName.get(hint) ?? null;
  }

  const type = input.type;
  if (typeof type === 'string' && type !== '') {
    let best: RegisteredRenderer | null = null;
    for (const r of byName.values()) {
      if (!r.forTypes.includes(type)) continue;
      if (!best || r.priority > best.priority || (r.priority === best.priority && r.name < best.name)) {
        best = r;
      }
    }
    return best;
  }

  return null;
}

/** 已注册 renderer 列表（按 priority 降序、name 升序，稳定）。 */
export function listRenderers(): readonly RegisteredRenderer[] {
  return [...byName.values()].sort(
    (a, b) => b.priority - a.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

/** 清空注册表（测试隔离用；生产代码无需调用）。 */
export function resetRenderers(): void {
  byName.clear();
}
