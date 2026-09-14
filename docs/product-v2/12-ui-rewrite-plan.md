# 12 — UI Rewrite Plan (分阶段实施)

日期: 2026-08-27
分支: feat/moling-product-ui-v2 (自 1515c05 / release/moling-commercial-v1)
纪律: 不动认证后端; 每阶段独立可部署 (前端静态替换); 生产 tv.moling.fun 在 Phase I 前不受影响。

## PHASE A — Foundation / Design System / App Shell (约 15-20 文件)
- DS V2 tokens (04): globals.css @theme, 色板/字阶/间距/动效变量
- 核心组件重写: Button/Input/Select/Table/Card/Modal/Drawer/Tooltip/Toast/Skeleton/Empty/Error/StatusBadge/Breadcrumb/Tabs/CostTag
- 三个 Shell: UserShell (sidebar+topbar) / AdminShell / StudioShell 骨架
- 导航注册表重写 (adminRegistry + userNav 数据驱动, 权限过滤)
- api client 基建: services/api/client.ts (request/auth refresh/error/retry/SSE 单例) + types/ 抽取
- TanStack Query 引入 (queryClient + 目录 hooks: models/providers/me)
- 验收: 空壳可跑 (路由全 404 占位), tsc 0 错, 旧 /workspace 可 301 到 /create 占位

## PHASE B — User Core (约 20 文件)
- /login /register /setup 重写
- /dashboard (KPI: 余额/进行中/最近资产)
- /create 快速生成 (模型选择器+参数+参考图 MediaPicker+生成闸门+5 态卡片) — 替代 WorkspacePage
- /tasks 任务中心 (SSE + history G2)
- 顶栏: Running Tasks / Credit / 搜索 (G6 前端组合) / User Menu
- 旧 useModelHub/useGenerationStream 全部迁 Query+sseClient
- 验收: 匿名→注册→充值→生成→完成→资产 全流程可用 (UAT 脚本 S1)

## PHASE C — Projects / Assets / Models / Tasks 深化 (约 18 文件)
- /assets (Grid/List/过滤/标签/详情抽屉/上传 OSS/编辑并入/举报/导出)
- /characters 重写 (参考图绑定)
- /models 用户目录 (只读: 能力/价格/示例)
- /projects 列表+详情 (studio_projects, meta 展示)
- /billing (余额/充值/订单/流水) + /account + /settings
- 验收: 资产全流程 (UAT S2), 计费对账 (UAT S3)

## PHASE D — Moling Studio / 无限画布 (约 30 文件, 最大块)
- @xyflow/react 引入; studioStore (Zustand); CanvasCore 分层 (07)
- 16 类节点 (Audio disabled); NodeLibrary/CommandPalette/ContextMenu/Inspector/Minimap
- 生成节点接 /api/generate + SSE 状态映射; costEngine; 批量执行 (拓扑序)
- 画布持久化 (G1, 经 PATCH meta.canvas)
- 旧 src/features/canvas 整体删除
- 验收: 画布 CRUD+保存恢复+单/批量生成+撤销重做 (UAT S4)

## PHASE E — 短剧生产 (约 12 文件)
- DramaFlowPage 13 阶段编辑器 (08); 引导↔画布双向序列化
- 批量 keyframe/video_shot; Timeline; Output 导出清单
- 项目模板 (3 预设画布 JSON)
- 验收: 模板→逐阶段→成片清单 全流程 (UAT S5)

## PHASE F — Admin V2 (约 24 文件)
- 22 admin 页 (06): Overview / Providers / Keys / Health / Models / Bindings / Pricing / Routing / Examples / RefStyles / Generations / Attempts(G3) / Workers(G3) / Agents / Skills / Users / Finance / Recharge / Payment / Storage / Monitoring / Security / Settings
- ModelHub 大卡片拆散完成; 3 监控页合并; 4 placeholder 消除
- 验收: admin 每页可操作+危险操作确认 (UAT S6)

## PHASE G — Finance / Ops / Monitoring 深化 (约 8 文件)
- 盈亏 ledger 图表; reconcile 差异处理; webhook 审计; 审计日志; OSS 日志流
- 验收: 账务对账闭环 (UAT S7)

## PHASE H — 性能 / 响应式 / 打磨 (跨文件)
- 表格虚拟滚动, 图片懒加载, 路由级 code-split (每 admin 页独立 chunk)
- 移动端只读降级; a11y (focus/aria); 动效统一
- 孤儿 chunk 清理流程 (部署铁律沿用)
- 验收: Lighthouse 基准 + 200 节点画布 60fps (UAT S8)

## PHASE I — UAT / 迁移 / 切换
- 按 13 迁移计划执行; 按 14 UAT 全跑
- 生产静态替换 (docker cp dist/build2 流程), 301 重定向表生效
- 观察 30min (5xx/生成成功率/画布保存)
- 回滚 = 恢复上一版 dist (旧 UI 保留一个发布周期)

## 旧代码处置清单
- REMOVE: shop 6 页, user/:id, model-console, edit/:id, 4 监控旧页, ecom 页, features/canvas
- MERGE: library→assets, transactions→recharge, ledger→finance, payment-settings→payment, samples→examples
- SPLIT: workspace→3, model-hub→5, system-settings→2, recharge→2, account→2
