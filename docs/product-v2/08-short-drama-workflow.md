# 08 — 短剧生产工作流

日期: 2026-08-27
定位: 引导式流程 + 自由画布双轨。数据全部落 studio_projects (meta JSON, G1/G8 — 一期不建新表)。

## 1. 阶段模型 (13 阶段)

```
concept → story → script → episode → scene → character
        → storyboard → keyframe → video_shot → audio → subtitle
        → timeline → final_export
```

每阶段状态: empty | draft | ready | locked; 项目当前阶段 = max(ready 阶段) 指针 (沿用旧 current_stage 语义, 扩展枚举)。

## 2. 各阶段定义 (产物 / 工具 / 画布节点映射)

| 阶段 | 产物 (meta 结构) | 工具 | 画布节点 |
|---|---|---|---|
| concept | {title, logline, genre, targetEp, refStyles[]} | 手填 + agent 扩写 (optimize-prompt) | Prompt |
| story | {synopsis, beats[]} | agent 生成剧本大纲 (skill) | Script |
| script | {episodes:[{title, content, chars[]}] } | 逐集编辑 + agent | Script→Episode |
| episode | 集拆分 (script 产物的结构化) | 列表编辑 | Episode |
| scene | {episodes:[{id, scenes:[{id, desc, chars[], shots[]}]}] } | 场景卡片编辑 | Scene |
| character | 绑定 characters 库 (形象图+设定) 或新建 | 角色选择器 (MediaPicker) | Character |
| storyboard | 每 scene 分镜组 [{desc, framing, duration}] | agent (comic_layout skill, 若启用) 或手填 | Storyboard |
| keyframe | 每分镜 1 张图 (Image 节点批量) | Generation V2 t2i/i2i (角色参考图注入) | Image |
| video_shot | 每分镜 1 段视频 (图生视频优先) | Generation V2 video | Image-to-Video |
| audio | BGM/旁白 (G7 无 TTS — 一期仅手选 OSS 上传的音频资产, 节点 disabled 提示) | 上传 | Audio(disabled) |
| subtitle | 每镜字幕文案 | agent 从剧本抽取 | Subtitle |
| timeline | 镜头排序/时长/转场 (纯前端数据) | 拖拽列表 | Timeline |
| final_export | 导出清单: 逐镜视频+字幕文件+工程 JSON (一期 G9 无服务端合成: 下载清单+说明; 二期服务端合成) | Output 节点 | Output |

## 3. 双轨交互

引导式 (DramaFlowPage):
- 左: 阶段导航 (13 步, 状态点) / 中: 当前阶段编辑器 (卡片式, 批量操作) / 右: 检查器 (角色/参考/参数)
- 阶段完成 → "下一阶段" CTA; 任意阶段右上角"打开画布" → 产物序列化为画布 (07 §6)
- 批量生成 (keyframe/video_shot): 一次提交 N 任务 (受 count 与积分闸门), 进度面板实时

自由画布 (StudioCanvasPage):
- 用户可丢弃引导结构, 纯节点编排; "保存回流程" 反向映射
- 短剧模板: 新建项目时可选模板 (3 集竖屏短剧/单集/自由), 模板 = 预置画布 JSON

## 4. 状态存储 (studio_projects.meta 契约)

```json
{
  "version": 2,
  "type": "drama" | "free",
  "currentStage": "keyframe",
  "stages": { "concept": {...}, "...": {} },
  "canvas": { "nodes": [], "edges": [], "viewport": {} }   // G1
}
```
- 写入走 PATCH /api/studio/projects/:id (现有 API), meta 深合并冲突一期用整 meta 覆盖 + 前端版本号防冲突
- 自动保存: 5s debounce + 离开页面前 flush

## 5. 边界
- 单项目单 owner (G11 无 workspace 协作)
- 积分: 每阶段批量生成前显示总成本预估, 确认后提交
- 失败: 单镜失败不阻塞, 标红可重跑; 账务以 V2 实际 commit/release 为准
