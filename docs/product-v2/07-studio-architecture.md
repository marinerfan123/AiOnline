# 07 — Moling Studio 架构 (无限画布)

日期: 2026-08-27
定位: 产品核心。全屏独立 Shell。技术: @xyflow/react (v12) + Zustand (画布状态) + Tailwind。
替代: 旧 src/features/canvas (React context 内存态, 4 节点, 无持久化 — 全量重写)。

## 1. 分层

```
StudioShell (路由级)
├── CanvasCore (@xyflow/react ReactFlow + Provider)
│   ├── NodeLibrary (左抽屉, 16 类节点拖入)
│   ├── CommandPalette (Cmd+K: 创建节点/跳转/执行/搜索资产)
│   ├── ContextMenu (右键: 节点/边/空白)
│   ├── Inspector (右抽屉: 选中节点参数/模型选择/成本)
│   ├── Minimap / Controls (缩放/适应) / Frames (分组框)
│   └── ExecutionOverlay (运行态: 节点状态色/进度/错误)
├── State: canvasStore (Zustand) — 见 §4
├── Services: canvasPersistence (G1 save/load), executor (DAG 执行), costEngine
└── Bridges: sseBridge (任务事件→节点状态), assetBridge (结果→资产/参考)
```

## 2. 节点体系 (16 类, 一期全实现)

| 节点 | 输入 | 输出 | 执行 | 状态 |
|---|---|---|---|---|
| Prompt | 文本 | 文本 | 无 (纯数据) | — |
| Script | 文本/概念 | 剧本 | agent (copy_writer skill) | ✓ |
| Episode | 剧本 | 集列表 | 解析 (前端) | ✓ |
| Scene | 集 | 场景列表 | 解析 (前端) | ✓ |
| Character | 参考图+设定 | 角色卡 | 无 (绑定角色库) | ✓ |
| Storyboard | 场景 | 分镜组 | agent (comic_layout skill, 若启用) | ✓ |
| Text | 文本 | 文本 | agent optimize/translate | ✓ |
| Image | 文本+参考 | 图片 | Generation V2 (t2i/i2i) | ✓ |
| Image-to-Image | 图+文本 | 图片 | Generation V2 referenceImages | ✓ |
| Text-to-Video | 文本 | 视频 | Generation V2 (video) | ✓ |
| Image-to-Video | 图+文本 | 视频 | Generation V2 videoMode | ✓ |
| Reference | 资产/角色 | 参考 | 无 (只读引用) | ✓ |
| Audio | 文本 | 音频 | TTS — G7 后端缺失, 一期 disabled | ✗ 禁用 |
| Subtitle | 视频/剧本 | 字幕轨 | agent skill (文案) | ✓ |
| Timeline | 镜头列表 | 排序/时长 | 前端 | ✓ |
| Output | 任意 | 打包清单 | 前端 (下载/存资产) | ✓ |

生成节点契约: 全部调 POST /api/generate (modelId canonical), 节点存 taskId; SSE 事件 (task-updates:{userId}) 映射状态到节点; 失败显示用户面原因, 节点详情展开才见技术信息。

## 3. 执行模型

- 单节点: Inspector "运行" → 校验 (模型选择/积分预估 CostTag 确认) → 提交 → 状态机 queued/generating/processing/completed/failed (对齐 V2, 节点显示 5 态)
- 批量: 拓扑排序 → 按层并行提交 (层内并行, 层间等待) → G12 一期前端编排, 每节点独立任务+独立积分; 中断策略: 任一 failed 默认停 (可配"跳过失败继续")
- 重跑: 节点级 (保留参数, 新 taskId); 幂等: 每次运行新 idempotencyKey
- 成本预估: costEngine 读模型单价×count, 提交前 Inspector 显示, 批量显示合计

## 4. 状态架构 (canvasStore, Zustand)

- nodes/edges (xyflow 受控) + selection + viewport
- execution: { [nodeId]: {taskId, status, progress, error, cost, mediaRef} }
- history (undo/redo, 快照栈, 上限 50)
- persistence: dirty flag + 自动保存 (5s debounce → G1 API) + 保存状态显示
- 与 React Flow useNodesState 的分工: xyflow 管几何, store 管业务 (执行/成本/历史)

## 5. 画布交互规范

- 连线: 仅允许 输出端口→输入端口; 类型兼容矩阵 (文本→文本系, 图片→Image-to-*/Video/Reference, 角色→Character 绑定)
- 多选: 框选/Shift; 组合: 成组 (Group 节点 = frame, 整体移动); 对齐辅助线
- 缩放: 25%-400%, 适应画布/选中; 快捷键: Del 删, Cmd+D 复制, Cmd+Z 撤销, Cmd+K 命令, Space+拖 平移
- 节点视觉: 状态色边框 (运行 accent 呼吸/完成绿/失败红), 缩略图 (图/视频首帧), 成本角标, 错误角标
- 性能: >200 节点启用 viewport culling; 视频节点仅 metadata + 缩略图, 播放走详情抽屉 (不内嵌多 video 元素)

## 6. 与短剧流程的关系
- DramaFlowPage 每个阶段产物 = 画布节点模板; "打开画布" 将 drama 状态序列化为初始画布 (Concept→Prompt, Character→Character 节点, Keyframe→Image 节点, Shot→Video 节点, Timeline→Timeline 节点)
- 画布内 "保存回流程" 反向更新 drama 阶段状态 (存 studio_projects.meta, G1)

## 7. 一期不做 (记 GAP)
- 多人协作画布 (G11 workspace)
- 服务端 DAG 执行/断点恢复 (G12)
- 音频节点 (G7)
- 画布内视频合成 (G9)
