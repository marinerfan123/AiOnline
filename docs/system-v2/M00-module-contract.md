# V2 M00 — Platform Foundation 模块契约

状态: M00 完成 (本文件即 M00 module contract)
分支: feat/moling-v2-m00-foundation
生产: tv.moling.fun — M00 不改生产，不切 V2，不改后端业务行为。

## 1. M00 范围

建立 V2 前端平台基础（design system + state + api + shell 骨架），
所有 legacy 路由/页面/行为零修改。V2 仅经 /__v2/* 预览入口，
feature flag V2_APP_SHELL 生产默认 OFF。

## 2. 交付物 (evidence-based)

| 项 | 位置 | 验证 |
|---|---|---|
| 版本审计 | scripts/audit-versions.sh + docs/system-v2/M00-VERSION-AUDIT.md | 脚本可重跑；记录见 docs |
| V2 module skeleton | src/app/ (router/shell/providers/config/nav) | tsc |
| design tokens | src/shared/ui/tokens.css (ml2-* 命名空间) | build + storybook |
| V2 primitives | src/shared/ui/v2/*.tsx (Button/Input/Select/Dialog/Drawer/Tooltip/Popover/Tabs/Badge/StatusBadge/Card/DataTable/ConfirmDialog/Toast/states) | tsc + storybook + vitest |
| Storybook | .storybook/ + src/shared/ui/v2/stories/ | npm run storybook:build |
| App Shell | src/app/shell/AppShellV2.tsx | playwright smoke (e2e/m00-smoke.spec.ts) |
| /__v2 preview | App.tsx 增量 Route + src/app/router/V2App.tsx | playwright smoke (e2e/m00-smoke.spec.ts) |
| API client | src/shared/api/client.ts + errors.ts | unit test + contract test |
| runtime validation | src/shared/api/contract/schemas.ts (zod) | unit test (真实 server JSON) |
| TanStack Query | src/shared/state/queryClient.ts + V2Providers | unit test + /__v2 dashboard |
| Zustand appStore | src/shared/state/appStore.ts (UI/session 仅) | unit test |
| SSE/realtime | src/shared/events/realtime.ts | unit test |
| contract proof | contracts/openapi/moling-v2.yaml → generated.d.ts → v2 client | 真实本地 API (staging :3001) 验证通过 |
| feature flags | src/shared/config/featureFlags.ts | unit test (prod 默认 + localStorage 隔离) |
| permission primitives | src/shared/auth/permissions.tsx | unit test |
| telemetry foundation | src/shared/telemetry/{logger,correlation,index}.ts | unit test。服务端 OTel: DEFERRED_WITH_REASON (见 §8) |
| test foundation | vitest (frontend) + src/__tests__/v2/*.test.tsx | npm test |
| security baseline | docs/system-v2/M00-SECURITY-BASELINE.md + build 检查 | 见 §7 |
| performance baseline | build 体积报告 + dashboard 无 N+1 | 见 §9 |
| M00 module contract | 本文件 | — |

## 3. 硬规则 (后续 phase 继承)

- legacy src/components/ui/*、src/pages/*、src/services/api.ts 在 M00 零修改。
- Zustand 只存 shell/UI 状态；服务器数据一律 TanStack Query (11-state-architecture)。
- 权限原语只是 UX 层；后端 middleware 永远是最终权威。
- feature flag 不是安全边界；生产 build 中 localStorage 覆盖被禁用。
- 每个 V2 API 响应必须过 zod schema (runtime boundary)。
- 新 V2 模块响应模式: OpenAPI → generated.d.ts → api client → zod → 组件。

## 4. API contract 现状

仅 healthz / readiness / auth.me 三个低风险只读端点。
后端零变更。contracts/openapi/moling-v2.yaml 为 M00 切片，
后续模块端点按同一流程追加 (openapi-typescript 重新生成)。

## 5. 回滚

M00 全部为新增文件 + App.tsx 两条增量 import/Route。
回滚 = revert 单个 commit，生产不受影响（flag 默认 OFF 时
/__v2 渲染 "V2 预览未启用" 卡片，不进 shell）。

## 6. 不做的事 (M00 明确排除)

M02 AI control plane、Studio、Provider 页面、Drama、Commerce、
Generation V2 改动、业务数据库 migration、legacy 页面重写。

## 7. Security baseline 摘要

详见 M00-SECURITY-BASELINE.md。要点:
- build 产物不含 secret (env 仅 VITE_* 白名单进 bundle)。
- legacy auth httpOnly cookie 机制未动。
- admin 后端鉴权未动 (M00 零后端业务修改)。
- /__v2 guard: 未登录 → /login (UX redirect)，后端 401/403 仍为权威。
- 错误展示不泄漏 stack: v2 errors.ts 只映射安全文案。
- prod build: flag 默认全 OFF + localStorage 覆盖禁用。

## 8. Telemetry

前端: logger (bounded sink) + correlation id 架构 (request_id 透传)。
服务端 OTel tracing/metrics: DEFERRED_WITH_REASON —
当前生产栈 (moling-v1-api 容器) 未接 OTel exporter，M00 阶段
引入 collector 依赖/配置属高风险变更，超出 M00 基础范围。
架构预留: correlation.ts 的 request_id 字段与未来 OTel trace
context 兼容 (W3C traceparent 透传位已留)。

## 9. Performance baseline

- V2 走 React.lazy 分包: legacy 主 bundle 不承载 V2 shell 代码。
- 首次 /__v2 加载仅 V2 chunk + 现有 vendor (react/radix/zustand/query)。
- dashboard 单请求 healthz (staleTime 10s, retry 0) — 无 N+1。
- build 产物体积记录于 M00-VERSION-AUDIT.md 附注。
