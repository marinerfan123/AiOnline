# 22 — 前端 Parity 差距矩阵 (G02/G03/G05 交互声称 → 测试/实现状态)

日期: 2026-09-04 · 叶: flash G24-parity 前置 (前端 studio-v2)
证据基线: `git log -1` = 434b249 (工作树含本叶新增文件，未提交); 全量 v2 vitest **25 文件 / 186 用例全绿** (含新叶 11 用例); `tsc -p tsconfig.app.json --noEmit` exit 0。
测试运行: `npx vitest run src/__tests__/v2` (25 passed / 186 passed)。

## 0. 声称来源 (spec 证据路径)

| 代号 | 声称文档 | 位置 |
|---|---|---|
| 05 spec | MOLING STUDIO ACCEPTANCE & AGENT EXECUTION SPEC V2.0 (仓库外 governance) | `/home/dministrator/moling-control/governance/blueprint-v2.0/05_ACCEPTANCE_EXECUTION_SPEC_V2.0.md` G02:L44-47, G03:L49-52, G05:L60-67; §5 规范化旅程 L215-263 (双击建 Text=L222); §6 Parity E2E L267-283 |
| 02 UI spec | UI & INTERACTION SPEC V2.0 (同上) | 02 §3 Canvas Input Contract L64-90 (Space+LMB L69 / MMB L70 / LMB 框选 L71 / 双击空白=Create menu L74 / Delete L79 / Ctrl+Z L83 / Redo L84 / F L86 / Shift+F L87 / 平台冲突 L90); §4 Node Create Menu L94-123 (双击 world position 创建 L96; Edge-to-empty 过滤 L119-123) |
| Gate JSON | G02/G03/G05 acceptance deliverables + audit annex (运行时 gate 台账) | `/home/dministrator/moling-control/runtime/blueprint-v2/gates/G02_acceptance.json`(deliverables: pan/zoom/fit/viewportPersist/doubleClickReserved; auditAnnex20260904: F1/F2 findings), G03_acceptance.json, G05_acceptance.json |
| 实现内引用 | 代码注释直接标注声称组 | `src/features/studio-v2/StudioCanvas.tsx:232,271` (G02/G05) |

## 1. 差距矩阵

状态字段 = **实现**状态 (实测读码) / **测试**: `已测(文件:行)` · `本叶补测(文件:行)` · `缺(需 browser/E2E)`。

| # | 声称项 (spec) | 实现证据 (仓库文件:行) | 测试证据 (vitest) | 判定 |
|---|---|---|---|---|
| 1 | 双击空白 → Create menu (02 §3 L74, §4 L96; 05 G05 "double click"; G03 create 面) | `StudioCanvas.tsx:315-320` onDoubleClick 仅 pane 类命中 → ContextMenu; `:55-90` 菜单注册表派生; `:340-361` 菜单渲染+关闭; 空态提示 `:121`; Composer 空态文案 `StudioComposer.tsx:210` | 缺(旧) → **本叶补测** `studioInteractionGaps.test.tsx:127-145` (pane 双击→菜单→选 Text→节点落在指针 flow 坐标并选中、菜单自关)、`:147-153`(非 pane 双击不开菜单)、`:155-164`(Esc 关菜单) | 实现=在, 接线=新测通过 |
| 2 | zoomOnDoubleClick=false ↔ 双击创建共存 (G02 deliverable "doubleClickReserved"; G05 声称双击不被 zoom 吃掉) | `StudioCanvas.tsx:271` zoomOnDoubleClick=false + 注释保留给 G05 | 缺(旧) → **本叶补测** `studioInteractionGaps.test.tsx:108(prop false)`+`:130(开菜单前再断言 false)` | 实现=在, 共存=新测通过; 真实浏览器双击手势本身仍需 E2E |
| 3 | F = fit selected / Shift+F = fit all + 钳制 (02 §3 L86-87; G02 deliverable "fit") | `StudioCanvas.tsx:232-242` F 带 `maxZoom:1.5, padding:0.3, duration:250` (selected) / Shift+F 或空选 `padding:0.15`; RF 全局钳 `minZoom 0.05/maxZoom 2` `:261-262`; 工具栏 fit/reset `:334-335` | 缺(旧) → **本叶补测** `studioInteractionGaps.test.tsx:193-209`(F 参数断言 nodes:[sel], maxZoom 1.5; Shift+F fit-all 参数; Ctrl+F 不触发)、`:211-216`(无选中时 F 退化为 fit-all) | 实现=在 (参数即钳制声明), 接线=新测通过; RF 实际拟合几何 = browser 范围 |
| 4 | Space + LMB pan (02 §3 L69; G02 deliverable "pan") | `StudioCanvas.tsx:270` panActivationKeyCode="Space"、`:269` panOnDrag=[1] (MMB) | 缺(旧) → **本叶补测** prop 断言 `studioInteractionGaps.test.tsx:111-112` | 实现=在; 手势物理执行 = 需 browser (G02 knownLimitation: Space 原生快捷键冲突未测, 05 §5/§6 E2E 项) |
| 5 | LMB 空白拖 = 框选 (02 §3 L71; G02 pan 项) | `StudioCanvas.tsx:268` selectionOnDrag | **本叶补测** prop `studioInteractionGaps.test.tsx:113` | 实现=在; 手势 = 需 browser |
| 6 | Delete/Backspace = 删除选中 + 输入守卫 (02 §3 L79; G05 "copyPaste"; G03 delete) | `StudioCanvas.tsx:231` Delete/Backspace→removeSelection、`:267` deleteKeyCode=null 关 RF 自带删除、`:216-222` INPUT/TEXTAREA/contentEditable 早退守卫; store `store.ts:300-319` (含 frame 连带删除 L305-318) | store 层已测 `studioCanvas.test.ts:131-138`(删除+undo), `:250-264`(frame 连带删) → **本叶补测** 键盘接线+守卫 `studioInteractionGaps.test.tsx:167-176`(canvas 内 Delete/Backspace 生效)、`:178-190`(textarea/input 内 Delete/Backspace 被守卫不动 store) | 实现=在, 全链=新测通过 |
| 7 | undo/redo 键位参数: Ctrl/Cmd+Z、Ctrl+Shift+Z、Ctrl+Y (02 §3 L83-84; G05 "undoRedo"; G02 toolbar) | `StudioCanvas.tsx:224-225`(z: shift?redo:undo; y:redo, preventDefault)、`:328-329` toolbar 按钮 disabled=canUndo/Redo; store `store.ts:515-541` undo/redo、`:125-129` pushUndo 清 redo、`:48` UNDO_LIMIT=100 | store 粒度已测 `studioStore.test.ts:36-77`(参数+拓扑同回一快照)、`:79-93`(有界+redo 清)、`studioCanvas.test.ts:172-182` → **本叶补测** 键位接线 `studioInteractionGaps.test.tsx:219-244`(Ctrl+Z undo / Ctrl+Shift+Z redo / Ctrl+Y redo / Meta+Z undo / preventDefault)、`:246-253`(字段内 Ctrl+Z 不劫持, 保原生) | 实现=在, 键位映射=新测通过 |
| 8 | cas 409 恢复 / viewport persist (G02 deliverable "viewportPersist"; 05 G02 "viewport persist") | server `server/modules/project-foundation/studioCanvasPersistence.cjs:201-202` CAS `revision=revision+1 WHERE revision=$2` 0 行→409 `{serverRevision,canvasId}`; 幂等 mutationId `:199-200,208` | server 已测 `.../studioCanvasPersistence.test.cjs:281-296`(同 mutationId 重放 idempotent:true)、`:307-323`(409 CONFLICT/零落库) | 实现=在, 服务端已测 |
| 9 | 409 本地编辑保留+retry 有效 (**G02 审计 F1 修复态**) | 客户端 `useStudioCanvasPersistence.ts:83-99`(409→保留 buffer 以 serverRevision 重放一次; 二次冲突才进 Conflict)、`:88-95`(Conflict 态仍留 buffer)、`:179-193` retry() 采纳 serverRevision 重放; `persistence.ts:166-186` peek/commitSnapshot (peek 不消费, 供 rebase) | 已测 `studioCanvasPersistenceHook.test.tsx:110-134`(单次 409→rebase 到 serverRevision, 本地编辑存活)、`:136-166`(双 409→Conflict + retry 后成功) | **修复态=已修** (commit cb55e59, 2026-09-04 v4pro audit wave-1, 附言 "G02: serialized flush mutex (F2) + 409 keeps buffer…"), 回归测试在 |
| 10 | 并发 flush 无重入 → 免自伤 409 (**G02 审计 F2 修复态**) | `useStudioCanvasPersistence.ts:32-35`(注释 F2) + `:109-126` single-flight mutex (inFlight/pendingFlush, 排队串行)、`:100-106` 非冲突失败同 cmid 重试(幂等去重) | 已测 `studioCanvasPersistenceHook.test.tsx:70-106`(并发 flush 串行化, 第二个用新 baseRevision=2 非陈旧 1) | **修复态=已修** (commit cb55e59), 回归测试在 |
| 11 | 右键空白 Context menu (02 §3 L75; G05 "rightClick") | `StudioCanvas.tsx:273-281` onPaneContextMenu→菜单 | 缺 | 实现=在; 需 browser (RF pane 事件域) — 05 §6/视觉验收项 |
| 12 | Edge-to-empty: 连线拖到空白→兼容节点菜单+自动连 (02 §3 L77 + §4 L119-123; G05 "edgeToEmpty") | `StudioCanvas.tsx:298-314` onConnectEnd (fromNode/handle/outPort → filtered kinds) + `:153-168` compatibleTargetKinds/firstCompatibleInput + `:345-358` 选中后自动 onConnect | 缺 (store `onConnect` gate 已测 `studioCanvas.test.ts:84-112`) | 实现=在; 交互手势 = 需 browser |
| 13 | 文件拖放→创建 (02 §3 L78; G05 "fileDrop") | `StudioCanvas.tsx:282-296` onDrop kind 拖放/真实文件→reference 节点落点创建 (上传绑定 G06) | 缺 | 实现=在 (节点创建部分); 拖放手势+上传 = 需 browser/E2E |
| 14 | Copy/Paste/Duplicate (02 §3 L80-82; G05 "copyPaste") | `StudioCanvas.tsx:227`(Ctrl+D)、`:229-230`(Ctrl+C/V)、`:330-331` toolbar | store 层已测 `studioCanvas.test.ts:140-150`(duplicate 新 id)、`:152-170`(copy/paste 内部边) → **本叶补测** Ctrl+A/D 接线 `studioInteractionGaps.test.tsx:257-265` | 实现=在; Ctrl+C/V 键位接线 = 缺 (本叶未加; 需 browser 剪贴板或后续小测) |
| 15 | Group Ctrl+G (02 §3 L85; G05 "group") | `StudioCanvas.tsx:228`; store `store.ts:421-450`; NodeResizer/分组语义 `StudioNode.tsx:128` | store 层已测 `studioCanvas.test.ts:212-227`(group)、`:229-248`(frame 拖带子) → **本叶补测** Ctrl+G 接线 `studioInteractionGaps.test.tsx:266-272` | 实现=在, 接线=新测通过 |
| 16 | Ctrl+A 全选 (输入合同 02 §3 未列但工具栏面; 选区前置给 delete/dup) | `StudioCanvas.tsx:226`; store `store.ts:362-366` | → **本叶补测** `studioInteractionGaps.test.tsx:257-260` | 实现=在, 新测通过 |
| 17 | 节点 resize (G03 "resize"; G05 "resize" NodeResizer) | `StudioNode.tsx:128` NodeResizer (非 frame, min 240×90); 尺寸持久化 `persistence.ts:71-82,84-111` | store/组件层缺 (依赖 RF 交互) | 实现=在; 交互手势 = 需 browser |
| 18 | Create/Move/Delete (G03 deliverable "create/move/resize/delete") | addNode `store.ts:282-298`; 拖移 `store.ts:202-225`(frame 连带)+drag 单条 undo `:278-280`; 删除见 #6 | store 已测 `studioCanvas.test.ts:117-129`(add)、`:229-248`(move 语义)、#6 删除 | 实现=在, store 全链已测 |
| 19 | Composer 提交写 schema 参数 (G07 面, 但属 G02 audit F 波回归; 双击空态文案依赖) | `StudioComposer.tsx:168-188` commit→updateNodeParameter(primaryTextParameterKey) / 兜底 data.prompt; dirty 判定 `:166`; promptValueOf `:39-43` | 已测 `studioComposer.test.tsx:61-100`(prompt/script/text 三键+STALE+镜像) | 实现=在, 已测 |
| 20 | Canvas 空态「双击快速添加」可发现性 (02 §5 空 canvas L699; F4 flow) | `StudioCanvas.tsx:110-125` EmptyState (`data-test=studio-empty-state`, 按钮 addAtCenter `:117-120` 直达 `:173-202`) | 组件层缺 (空态按钮→addAtCenter→focus 需 RF fitView 几何) | 实现=在; 按钮点击最小路径可 jsdom 补, 未补则标 需 browser/后续 |

## 2. 覆盖盘点 (实测)

- v2 目录 vitest 全绿: **25 files / 186 tests** (本叶新增 1 file / 11 tests)。
- 旧覆盖直接命中声称项的套件:
  - `studioCanvas.test.ts` 17 用例 (注册表/端口/ops 全量 store 语义)
  - `studioStore.test.ts` 7 用例 (G00/G03/G05 审计回归: undo 粒度/LoadGraph/状态本地来源/registry 15 kinds)
  - `studioCanvasPersistence.test.ts` 7 用例 (序列化安全边界 + DirtyOperationBuffer)
  - `studioCanvasPersistenceHook.test.tsx` 3 用例 (F2 串行 + F1 rebase + Conflict 保留重试)
  - `studioComposer.test.tsx` 3 用例 (commit 三键)
- 本叶新文件 `src/__tests__/v2/studioInteractionGaps.test.tsx` 11 用例 (见矩阵 #1-7, 14-16):
  渲染**真实** StudioCanvas (真实 store + 真实 CanvasCore 键盘/pane/菜单 handler); 仅第三方布局引擎 `@xyflow/react` stub 成被动 prop 记录组件 (partial mock 保留 applyNodeChanges/addEdge 等真实逻辑)。**未 mock 任何仓库组件** (StudioCanvas/StudioComposer/store 全真)。

## 3. 仍需 browser / E2E 的缺口 (明确不声称)

- 真实双击手势命中 pane 的浏览器事件域、zoomOnDoubleClick 视觉零放大 (已测: prop=false + 同 handler 菜单共存, 未测浏览器像素)。
- Space+LMB / MMB 实际平移、wheel 指针中心缩放、pinch、LMB 框选手势 (RF 内部几何)。
- F/Shift+F fitView 实际拟合结果与 minZoom/maxZoom 硬钳 (已测: 调用参数即钳制声明)。
- 右键菜单、edge-to-empty 拖放手势、文件拖放、NodeResizer 拖角、Ctrl+C/V 真实剪贴板。
- 以上归 05 §5 Canonical Journey (步骤 3 双击建 Text 等) 与 05 §6 Parity E2E + G23 视觉验收; 对齐 G02/G05 acceptance knownLimitations (Space 原生快捷键冲突优先级测试、runtime 视觉证明 deferred)。

## 4. 结论要点

1. 矩阵 20 行声称全部**实现存在**、无实现缺失; 3 行标 G02 审计 **F1/F2 已修复** (cb55e59) 且客户端 hook 回归测试在 (3 用例, `studioCanvasPersistenceHook.test.tsx`), 服务端 CAS 409 + 幂等重放亦已测。
2. 本叶前 jsdom 可测缺口 (键盘契约接线 + RF 交互 prop + 双击菜单共存) 原为零覆盖 → 新增 11 用例全绿, tsc 0。
3. 不可 jsdom 项全部明确标注 需 browser/E2E (§3), 未做未实测声称。
4. 全部证据行号 = 上述矩阵 "实现证据/测试证据" 列; 声称来源 = §0 表。
