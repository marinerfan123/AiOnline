# 34 完整画布差距清单（2026-09-05 盘点）

方法：纯盘点，逐条引用行号，不声称任何未实测结论。只读全仓（`src/features/studio-v2/` 全部 + `src/app/router/V2App.tsx` + 前端路由挂载链 + 服务端 `studioCanvasPersistence/studioRunEngine/studioRunApi/runEventStore/runEventsApi/runEventRelay/canvasCommandLogApi/canvasProjection/shotLineage/commandLogStore` 读面）。本文件为可写产物；未改任何代码（M1 视口叶在飞，勿动 StudioCanvas/store）。

> 关键事实修正（先于清单）：doc 33 断言「无 pan/zoom/wheel/transform 命中」**与当前代码不符**——react-flow 内建 pan/zoom/minimap/controls 已在 StudioCanvas 接线（见域①）。33 号文档的 M1「无限视口」应理解为「世界坐标 + 无边网格 + 视口语义化」，不是「从零做 pan/zoom」。

---

## A) 『完整画布』验收清单（8 域）

现状标记：**已有** = 接线且可工作 / **部分** = 有实现但未接终端消费或未闭环 / **缺失** = 无实现或纯占位。

### ① 画布视口

| 项 | 现状 | 文件证据 |
|---|---|---|
| pan（平移） | 已有 | `StudioCanvas.tsx` L269 `panOnDrag={[1]}`（中键）、L270 `panActivationKeyCode="Space"` |
| zoom（缩放） | 已有 | L261-262 `minZoom=0.05/maxZoom=2`、L272 `zoomOnScroll`、L323-324 `<MiniMap>`+`<Controls>` |
| fit（适应） | 已有 | L199 `fitView`（加节点聚焦）、L233-242 键盘 F/Shift+F、L334-335 工具栏 fit/reset |
| 网格背景 | 部分 | L322 `Background variant=Dots gap=24`（点阵，**非「无边网格线」**，M1 目标） |
| 多选 | 已有 | L268 `selectionOnDrag`（LMB 空白拖拽 = 框选）；Inspector L131-142 多选工具栏 |
| 框选 | 已有 | 同上 `selectionOnDrag` |
| 键盘 | 已有 | L214-246（Ctrl+Z/Y/A/D/G/C/V、Del/Backspace、F/Shift+F、Esc） |
| 视口持久化 | 已有 | `useStudioCanvasPersistence.ts` L222 缓冲 viewport→patch；L191 重载恢复 |
| 双击语义 | 部分 | L271 `zoomOnDoubleClick={false}`、L315-320 双击空白开新建菜单（**双击节点无预览/定位**，M1 待做「节点双击定位」） |

结论：视口 **基本已有**（react-flow 内建 + 工具条），缺「无边网格线 / 世界坐标 store / 双击节点定位」。

### ② 节点系统

| 项 | 现状 | 文件证据 |
|---|---|---|
| 类型覆盖 | 已有 | `registry.ts` NODE_DEFS L217-401 共 15 类：text/image/audio/storyboard/video-clip/prompt/script/character/reference/image-generation/image-to-video/text-to-video/video/output/frame（图像/视频/文本/分镜/资产全覆盖） |
| 增 | 已有 | `store.ts` L282-298 `addNode`；NodeLibrary L30-34 拖拽+点击；StudioCanvas L282-296 onDrop、L173-202 addAtCenter、L315 双击 |
| 删 | 已有 | `store.ts` L300-319 `removeSelection`；Del/Backspace L231 |
| 拖移 | 已有 | L202-225 `applyNodeChanges` + frame 群组联动 L205-223 |
| 连线 | 已有 | L239-275 `onConnect` + `graphRules.ts` G04 类型/环/基数门 L71-124；edge-to-empty 菜单 StudioCanvas L298-314 |
| 端口 | 已有 | `StudioNode.tsx` L210-234 Handle 全由 registry input/outputPorts 派生 |
| 锁定 | **缺失** | 画布节点无锁定。唯一 lock 是分镜 shot 域（`storyboardLock.ts`，属域⑦非节点域） |
| 复制/粘贴/删除 | 已有 | `store.ts` copySelection L353 / paste L368 / duplicateSelection L321 / mintNodeId（types.ts L237） |
| 对齐/成组 | 已有 | alignSelection L399、groupSelection L421（frame 容器） |

结论：节点系统 **接近完整**，唯一硬缺 = **节点锁定**；次要缺 = 无 z-order 排序/自动布局（DAG 分层，M2 目标）。

### ③ 检视器（参数面板）

| 项 | 现状 | 文件证据 |
|---|---|---|
| schema 驱动 | 已有 | `ParameterInspector.tsx` L110-253 全字段渲染（model/asset/textarea/boolean/select/multi-select/number/slider/seed/duration）；`registry.ts` L37 `parameterSchema` 为唯一源 |
| 非占位 | 已有 | 每字段有真控件；model 字段走 M02 目录 L58-108、asset 走 AssetPicker L153-159；validation 反馈 L43-51、196 |
| 有效 schema（模型约束） | 已有 | `registry.ts` L458-467 `getEffectiveParameterSchema`；ParameterInspector L217-220 |
| 状态/校验/就绪 | 已有 | `Inspector.tsx` L167-190（Status/Validation）、`validation.ts` L139-160 computeReadiness |
| 陈旧文案 | 部分 | Inspector L121-127 仍写「会话态 Canvas…刷新页面将丢失」——**与已接线的持久化矛盾（见域⑥）** |

结论：检视器 **schema 驱动完整、非占位**（这是任务提示中的「埋没能力」，实际已完整接线，无需重做）。唯一问题 = 持久化陈旧的说明文案。

### ④ 执行闭环（节点→job→产物→预览/下载/替换）

| 项 | 现状 | 文件证据 |
|---|---|---|
| 节点→job（Run 按钮） | **缺失** | `StudioComposer.tsx` L318-326 Generate 按钮只 `flush()` 存 prompt，title 明示「执行链经 G15 Run 层接入」；无 studio-run-client（`src/shared/api/contract/` 下无 run client，仅 canvas/shot/episode/structure/project） |
| job→产物缩略图上画布 | **缺失** | `StudioNode.tsx` AssetPreview L39-60 只按 `assetId` 拉 thumbnail，无 jobId→assetIds 绑定 |
| 双击预览/下载/替换 | **缺失** | `StudioCanvas.tsx` L315 onDoubleClick 仅开新建菜单；全 studio-v2 无 preview/download/replace 命中（grep 确认） |
| 服务端读面 | 已有（未消费） | `studioRunApi.cjs`（881L，L5-9 POST runs/GET runs/:id/events/cancel）、`studioRunEngine.cjs`（1592L）、`runEventStore/runEventsApi/runEventRelay`、`shotLineage.cjs`（220L）；server.js L2763-2772 已挂载 |
| 事件流前端钩子 | 已有（未消费） | `useRunEventsStream.ts` L171-418 完整 SSE resubscribe 客户端，**仅测试引用**（grep：仅 `__tests__/v2/useRunEventsStream.test.ts`） |

结论：执行闭环 **整链缺失在前端**；服务端引擎/事件/lineage 已备。这是影响度最高的缺项。

### ⑤ 历史（undo/redo 与命令日志）

| 项 | 现状 | 文件证据 |
|---|---|---|
| undo/redo | 已有 | `store.ts` L121-129 pushUndo（UNDO_LIMIT=100 L48）、L515-541 undo/redo；StudioCanvas L328-329 按钮、L224-225 键盘 |
| undo 实现机制 | 部分 | **快照式**（undoStack/redoStack 全量 nodes+edges 快照），非命令日志消费 |
| 服务端命令日志 | 已有（未消费） | 迁移 `0046_command_log.sql`（`canvas_command_log` 表）；`commandLogStore.cjs`（234L，append 幂等）；`canvasCommandLogApi.cjs`（432L，读面 `GET …/canvas/commands`）；`canvasProjection.cjs`（405L，CAS 投影重放） |
| 挂载状态 | 已有 | server.js L62/L1553/L2738 已挂载 canvasCommandLogApi（**注意**：canvasCommandLogApi.cjs L3 头注释「未挂载 server.js」已过时，实已挂载） |
| 前端命令日志消费 | **缺失** | 无任何前端读 `canvas/commands`；undo/redo 不消费命令日志 |

结论：undo/redo **有（快照式）**，但**命令日志消费（协作历史/跨端 undo）缺失**。服务端 0046 命令日志 + 读 API + 投影已备，前端消费者为 0。（注：任务所说「0061」为 `0061_phase_reason.sql`，与命令日志无关；命令日志迁移是 `0046_command_log.sql`。）

### ⑥ 持久化与重载

| 项 | 现状 | 文件证据 |
|---|---|---|
| 刷新不丢 | 已有 | `StudioPage.tsx` L28 挂 `useStudioCanvasPersistence`；`useStudioCanvasPersistence.ts` L166-171 900ms debounce 自动保存、L173-205 reloadFromServer |
| CAS/冲突 | 已有 | L83-96 patch(baseRevision)+409 解析；F1 重放/F2 单飞 L108-164；`persistence.ts` DirtyOperationBuffer L137-199 |
| 冲突提示 | 已有 | `CanvasConflictBanner.tsx` L36-74（reject409 红 / lww-merge 琥珀 / append 中性）；TopToolbar L40 冲突 reload |
| 版本 | 已有 | `studio-canvas-client.ts` L61-75 listVersions/createVersion/restoreVersion；BottomDock L21-23、L37-41 Versions 面板 |
| 协作锁呈现 | **缺失** | 画布无 presence 光标/锁；仅有冲突 banner（非在场）。分镜 shot 锁（storyboardLock）属域⑦ |
| UI 文案一致性 | 部分 | Inspector L121-127「会话态…刷新丢失」与已接线持久化**矛盾**，误导用户 |

结论：持久化与重载 **基本完整**（真实 autosave + CAS + 版本 + 冲突 banner）。缺 = **协作在场呈现**；次要 = Inspector 陈旧文案未同步。

### ⑦ 工程组织（多画布/场景/图层）

| 项 | 现状 | 文件证据 |
|---|---|---|
| 多画布 | **缺失** | `studio-canvas-client.ts` L48-55 getCanvas/createCanvas 无 canvasId 参数（单「Primary Canvas」/project） |
| 场景页 | **缺失** | 无 scene 概念；仅 frame 节点（`store.ts` groupSelection L421）作结构容器 |
| 图层 | **缺失** | 无 layer/z 分层 |
| 分镜集成 | 部分 | `storyboard` 节点 registry L379；`StoryboardRowsPanel.tsx` L1-25 读 script plan 投影；但 StudioPage L69 未向 BottomDock 传 `scriptId` → Shots tab 恒「未绑定」空态（BottomDock L42-46） |
| 时间线/Runs dock | 部分 | BottomDock L10-12 Timeline/Runs 均为「reserved」占位 L47 |

结论：工程组织 **基本缺失**（单画布、无场景/图层）；分镜面板有实现但**未接线 scriptId**（埋没能力）。

### ⑧ 媒体资产

| 项 | 现状 | 文件证据 |
|---|---|---|
| 拖资产上画布成节点 | **缺失** | `AssetLibraryDrawer.tsx` 无 draggable；StudioCanvas onDrop 仅处理**文件**拖入→建 Reference 节点（L291-295，「upload→asset 绑定随 G06」） |
| asset drawer 接 media 表 | 已有（只读） | AssetLibraryDrawer L433-438 `v2asset.listProjectAssets`；分段/搜索/收藏/版本浏览 L404-781 |
| 上传/写 | **缺失** | 头注释 L3-5「Upload / write / drag-to-canvas 随 G06 上传端点」 |

结论：媒体资产 **只读已接、写/拖拽未做**。

---

## B) 与『可用完整画布』的差距 Top 缺项（影响度 × 成本）

| 序 | 缺项 | 域 | 影响度 | 成本 | 说明 |
|---|---|---|---|---|---|
| 1 | **执行闭环前端接线**（Run 按钮→job→产物缩略图→双击预览/下载/替换） | ④ | 极高（画布「有用」的命门） | 中 | 服务端引擎/事件/lineage 全备，前端 0 消费 |
| 2 | **媒体资产拖拽上画布 + G06 上传写能力** | ⑧ | 高 | 中 | drawer 只读已接，仅差 drag/upload 两端 |
| 3 | **协作在场（presence 光标/节点锁）** | ⑥/② | 高（协作产品力） | 高 | presenceBus 服务端存在，前端 0 |
| 4 | **工程组织（多画布/场景/图层）** | ⑦ | 高 | 高 | 单画布 + frame 容器，缺结构层 |
| 5 | **undo/redo 消费命令日志（协作历史）** | ⑤ | 中 | 低 | 服务端 0046+读 API+投影已备，前端仅快照 |
| 6 | **分镜面板接线 scriptId + 节点锁定** | ⑦/② | 中 | 低 | StoryboardRowsPanel 已实现未接线；节点 lock 缺失 |

---

## C) 建议波次（每波 ≤6 叶，文件域互斥）

> 与 doc 33 M1（视口）不重叠：M1 已占 StudioCanvas/store/composerModel 视口域，本清单波次从「视口之外」的缺口补起。

| 波次 | 目标 | 叶（文件域） |
|---|---|---|
| W1 | 执行闭环·读面接线 | ① `studio-run-client.ts`（contract，新）② `Inspector.tsx` Run 按钮 + `store.ts` runState ③ `BottomDock.tsx` Runs tab（消费 `useRunEventsStream.ts`）④ `StudioNode.tsx` jobId/outputAssetIds→缩略图 |
| W2 | 执行闭环·产物交互 | ⑤ `StudioCanvas.tsx` 双击节点预览（新建 `NodePreviewModal.tsx`）⑥ 预览面板下载/替换按钮（asset-client 写面） |
| W3 | 媒体资产闭环 | ① `AssetLibraryDrawer.tsx` 资产 draggable + onDrop 绑定成 image/video/audio/reference 节点 ② G06 上传端点 client + drawer 上传入口 |
| W4 | 协作历史 | ① `store.ts` undo/redo 改命令日志消费 ② `canvasCommandLogApi` 前端 client（新）③ `BottomDock.tsx` History 面板（读 commands） |
| W5 | 协作在场/锁 | ① presence 前端 client（新）② `StudioCanvas.tsx` 光标 overlay ③ `StudioNode.tsx` 节点锁定 UI + `store.ts` lock 语义 |
| W6 | 工程组织 + 收尾 | ① 多画布结构（canvas 列表/切换）② `StudioPage.tsx` 向 BottomDock 传 scriptId（分镜接线）③ `Inspector.tsx` 陈旧持久化文案修正 ④ 自动布局（DAG 分层，M2） |

波次内部文件域互斥；跨波次仅 W1④/W2⑤ 共享 `StudioNode.tsx` 的缩略图/预览域但分工不同（绑定 vs 交互），可合并为同一叶域时需排它。

---

## D) 已存在但被埋没的能力点名（接线点标注）

| 能力 | 状态 | 埋没点 / 接线点 |
|---|---|---|
| 参数 schema 驱动检视器 | **已完整接线**（非占位） | `registry.ts` L37 parameterSchema → `ParameterInspector.tsx` L110-253 已消费；无需重做，勿误排进 W |
| 渲染 registry（单一真源） | 已接线 | `registry.ts` NODE_DEFS_LIST L403 → nodeTypes/NodeLibrary/StudioNode/Inspector 全派生；L458-467 有效 schema 已用 |
| **FormGenerator（model-ui）** | **未接线** | `model-ui/FormGenerator.tsx` L1「未接线」、L54-60 `file` 字段占位按钮、L19 onChange「未接线到任何 store/API」；与 ParameterInspector 功能重复。接线点：**废弃或接 L42/L46 AssetPicker**（勿与 ParameterInspector 并存双表） |
| 命令日志读 API | 已备未消费 | `canvasCommandLogApi.cjs` 已挂载（server.js L2738）；头注释 L3「未挂载」**过时**。接线点：前端 undo/redo + History 面板（W4） |
| run 事件 SSE 客户端 | 已备未消费 | `useRunEventsStream.ts` L171-418 完整实现，仅测试引用。接线点：BottomDock Runs tab（W1③） |
| Run API + 引擎 | 已备未消费 | `studioRunApi.cjs`(881L)+`studioRunEngine.cjs`(1592L) 挂载 server.js L2763-2772。接线点：前端 studio-run-client（W1①） |
| 画布投影 + shot lineage | 已备未消费 | `canvasProjection.cjs`(405L)+`shotLineage.cjs`(220L) 挂载 L2742。接线点：版本/血缘视图（未来） |
| react-flow 内建 pan/zoom/minimap/controls | **已接线** | `StudioCanvas.tsx` L261-324；doc 33 M1「无 pan/zoom」论断需更正，M1 应聚焦「无边网格 + 世界坐标 + 双击定位」 |
| 分镜 rows 面板 | 已实现未接线 | `StoryboardRowsPanel.tsx` L1-25 已实现；StudioPage L69 未传 `scriptId` → 恒空态。接线点：StudioPage 传 scriptId（W6②） |

## E) 实施进度（2026-09-05 更新）
- 已合入：M1 viewport(54824d2)/W1 run-client+Runs+节点缩略图+scriptId(96a9b26)/W1② Run+runState(54a63b8)/W2 NodePreviewModal 预览下载重跑(54a63b8)/W3 资产拖拽成节点(a485fd7)+G06 上传口(f6a27b9)/W4 canvasCommandLogClient+syncFromCommandLog 游标+History(a485fd7)/W5 presence client(7d97a26)+在场条+节点锁(2d3add6)/W6① canvasId 上提(7d65cba)/W6③ Inspector 陈旧文案已同步("会话态刷新丢失"→现 L144"自动保存约900ms不丢")/M2 快捷键真因修复(5aae41b)
- 测试(截至 f6a27b9): 全量套件前轮记录 531 绿; studio-v2+v2 子集 55 files/427 passed; tsc 0
- 剩余(未合入, 记录不臆造):
  - W6④ 自动布局(DAG 分层, M2 doc33) —— 核心 store.ts + Inspector/StudioCanvas 工具栏耦合(位置/undo 快照/锁语义同 alignSelection)。按用户并行纪律核心/耦合=父线 v4-pro 串行, flash cron 不写核心 store → 待父线/委托, 本轮不派。不派。
  - 服务端多画布 REST(list/副画布/切换) —— server+DB 级(客户端 W6① 已注 primary-only, 多画布留 DB-level)。本地无真 PG 无法取证(node --test 集成 fail-closed 属预期), 待容器/父线。不派。
- 本轮判定: 空闲无未合入叶(src/ 净, live/ 无 running); 仅剩两叶均属核心/服务端耦合, flash cron 依纪律不强行推进(不臆造 PASS), 故 round 无可见新画布能力合入, 只做 34 波次复核(本 E 更新) + LEDGER 记录。
- 测试环境 UI 刷新(13001 呈现): 待审批放行(大机预构建 dist + fast 镜像)
