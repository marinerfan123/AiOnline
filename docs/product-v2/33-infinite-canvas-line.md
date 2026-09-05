# 33 无限画布产品线（2026-09-05 纠偏启动）

背景：前几日重心压至可靠性/墨渊视频运行时（引擎层），画布产品面搁浅。用户点名"无限画布这么没用"——纠偏：画布为产品主线，其余为并行后台。

## 现状（实测盘点）
- src/features/studio-v2/ 39 文件全为既有（StudioCanvas/StudioComposer/StudioNode/StudioPage/Inspector/TopToolbar/BottomDock/AssetLibraryDrawer/NodeLibrary…）
- 无 pan/zoom/wheel/transform 命中 → 画布为固定视口摆放，非"无限画布"
- 近期新增仅外围：CanvasConflictBanner、StoryboardRowsPanel/LockBadge、视频节点语义(服务端 0069 parked) —— 无一项是画布核心交互

## 里程碑
- M1 无限视口（本周）：世界坐标 + 平移(拖拽/空格) + 缩放(wheel/pinch/±/fit) + 无边网格背景 + 视口持久化 + 节点双击定位；vitest 覆盖纯逻辑
- M2 画布编辑力：多选/框选、对齐分布、自动布局(DAG 分层)、撤销/重做(命令日志消费)、锁定/冲突呈现完善
- M3 画布与媒体闭环：视频/图像节点真实出片上画布（jobId 绑定→产物缩略图→双击预览）、连续镜头链可视化、协作在场(presence 光标)
- 服务端底子已备：CAS/命令日志/投影/0069 parked/lineage —— M1-M3 直接消费，不再扩服务端

## 验收
- 每 M 里程碑：vitest 全绿 + tsc 0 + 测试环境 http://47.122.107.24:13001 画布页可感操作 + 持久化重载不丢
- 不许用 mock 冒充真实交互；Canvas 组件交互(pointer/wheel)用手动浏览器验证记录

## 波次划分（文件域互斥）
- W1: viewport store+transform 纯逻辑（composerModel/store）
- W2: StudioCanvas 渲染接入（world→screen、grid、拖拽平移、wheel 缩放）
- W3: TopToolbar 控件（fit/zoom in-out/百分比/重置）+ 双击节点定位
- W4: 视口持久化 + 重载恢复 + 冒烟文档
