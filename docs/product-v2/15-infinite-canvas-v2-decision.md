# 15 — 无限画布 V2 蓝图（将来形态决定）

日期: 2026-09-03
作者: 直接写码模式（USER_DIRECTED; 双审机制已剔除，见 moling-control/governance/REVISION-20260903-direct-write.md）
状态: 决定稿。本文件取代 07-studio-architecture.md 作为无限画布的权威设计蓝图；07 降级为历史愿景记录。

## 1. 记忆三层（为什么需要这份蓝图）

无限画布在记忆里经历了三层，互不一致，写码前必须先收敛：

| 层 | 来源 | 形态 |
|---|---|---|
| 1代 | src/features/canvas（commit 7415136） | React 内存态 4 节点分镜，接真实生成 API，无持久化 → 官方宣告全量重写替代 |
| 愿景 | 07-studio-architecture.md（2026-08-27） | 16 类节点全屏 Studio Shell（NodeLibrary/Palette/Inspector/Overlay），拓扑按层并行执行，部分依赖 agent skills，Audio 一期禁用 |
| 现实 | M05 系列 studio-v2（df3d7dd → 416c39f） | @xyflow/react + Zustand（undo/redo snapshot、跨项目 reset、错误隔离）；registry 驱动节点定义；服务端持久化 + revision 冲突；路由 /studio/:projectId；SSE 状态桥；M05-D durable run engine；W2-06/07/08 画布↔Shot/Structure 绑定 |

关键差距：
- 07 说 16 类节点；现实 registry 只有 10 kind（prompt/script/character/reference/image-generation/image-to-video/text-to-video/video/output/frame），且节点身份是 stable id，label 永不作文本身份。
- 07 假设节点是"通用执行工作流"；DAG 仲裁与 W2-06 决定画布是 Shot-centric 生产事实层的可视化绑定——节点不是流水线，是实体引用 + 执行视图。
- 产品锁要求：Shot 是权威生产实体；画布节点必须可绑定到权威结构/Shot（W2-06/07/08 已建绑定 + 持久化 + 编译 lineage）。

## 2. 将来形态（决定）

定义：无限画布 = 项目生产空间的可视化事实层（single visual source of production truth），不是通用流程图编辑器。

设计决策（D1-D10）：
- D1 实体权威：structure/Shot/Character/Environment/Reference/AssetVersion 是权威实体（DB 表）；画布节点要么绑定实体（binding），要么是生成执行块（generation），不复制实体数据进节点。
- D2 节点分类执行：SOURCE/TRANSFORM/GENERATION 参与执行；STRUCTURAL/binding 节点永不进入执行（M05-D 编译器按 NodeExecutionKind 编译，不按名字推断）。
- D3 节点清单以 registry 为准，10 kind 起步可扩展；新增节点必须先加 stable kind + 参数 schema（M05-B1/B2），UI 永不硬编码第二份列表。
- D4 持久化服务端权威：快照 + revision + 乐观冲突检测（已有 useStudioCanvasPersistence/DirtyOperationBuffer）；浏览器只存 UI 瞬态（选中/视口/undo），不进 node data。
- D5 生成执行走 W4 Product Generation Facade（Shot 下单 → job/attempt/asset version），画布只显示状态（queued/claimed/running/done/failed/canceled 映射），不直接调 provider。
- D6 运行态经 SSE（task-updates:{userId}）回投节点；失败显示用户面原因，技术细节进节点详情。
- D7 Shot 生命周期：shots.status 为画布/Inspector 展示的唯一权威列（draft → 生成态 → ready/failed），由 W4 facade 单一写入（待 0035 迁移补列，见 W1-09）。
- D8 画布是"一个项目一张生产板"：画布 = 项目视图，不跨项目共享状态（store.resetProjectState 已保证切换隔离）。
- D9 执行产物流向 Timeline：Shot 选定 Asset Version → W5 timeline 渐进装配；画布不替代 timeline。
- D10 成本透明：生成节点运行前 CostTag 预估确认（quoteService），积分不足/预算门 fail-closed（generationGate）。

## 3. 现状映射（哪些已有 / 要写 / 要拆）

已有（绿测证据）: registry + 10 kind、持久化+revision、undo/redo、错误隔离、绑定表、M05-D run engine、SSE 桥、/studio/:projectId 路由。
要写: ①shots.status 列（0035，W1-09 收尾）②画布空态/教学引导（10 kind 用户可见性）③Audio/Subtitle 类节点按 D10 门控后补 ④07 doc 中 16 类与 agent-skill 节点的清理引用。
要拆: src/features/canvas（1代 4 节点，已死代码）—— 确认无引用后删除，防双实现漂移。

## 4. 验收锚（写码后如何证明）
- 一个项目：建 Brief+DeliverySpec → 画布建 Shot 绑定节点 → 运行生成 → SSE 状态 → asset version → Inspector/画布显示 shots.status → timeline 引用选定版本（GP-01 主链闭环，见 e2e/m05a 与 harness GP01）。
- 绑定/持久化/编译 lineage 已有测试覆盖（studioCanvasBinding.test / studioRunGraphLineage.test）。
