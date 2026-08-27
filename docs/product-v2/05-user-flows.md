# 05 — User Flows (V2)

日期: 2026-08-27
用户角色: 匿名 / user / creator(同 user, 有项目) / admin。后端授权为最终边界。

## F1 注册 → 首启创作
1. /register 提交 → 2. /dashboard (首次: 余额 0 提示充值 CTA + 模板引导) → 3. 全局 Create → /create → 4. 选模型 (Models 目录数据) / 写 prompt (可选 optimize-prompt) / 参考图 (MediaPicker 从 /assets) / 参数 (ratio/resolution/count 1-4) → 5. 提交 POST /api/generate (idempotencyKey 前端生成) → 6. 顶栏 Running Tasks +1, SSE 推送状态 → 7. 完成 → toast + 资产落 /assets, 可"送画布"。
充值分支: 余额不足 → /billing → 选充值包 → 下单 (支付壳, G10: 线下/admin 代充) → 轮询订单状态 → 到账 (webhook/对账) → 返回生成。

## F2 快速生成 (Creation)
- 无项目上下文; 支持 图/视频; 队列状态 5 态; Advanced details 折叠区才显示 provider/modelId/耗时/token 错误码。
- 失败: 用户面文案 ("生成失败, 已退回积分" — 以 hold release 实际账务为准) + 重试按钮 (同 idempotencyKey 换新)。

## F3 项目 → 短剧
1. /projects 新建 (名称/类型: 短剧/自由) → 2. 进入 /studio/:id/drama (引导式) → 3. Concept→Script (agent 生成/手改)→ Episode 拆分 → Scene 列表 → Character 设定 (绑定角色库参考图) → Storyboard (每 scene 关键帧描述) → Keyframe (图生成, 批量, 每 scene 可回画布微调) → Video Shot (图生视频/文生视频逐镜) → Subtitle (文案 skill 生成) → Timeline (拖序/时长) → Final Export (一期: 分镜视频列表+逐条下载+清单; 服务端合成 G9 二期)。
- 任意步骤"打开画布" → /studio/:id (自由模式), 引导产物映射为画布节点 (Concept/Prompt/Character/Image/Video/Reference 节点), 双向: 画布产物可回填 drama 状态。

## F4 Moling Studio (无限画布)
1. 节点库拖入 / Cmd+K 命令创建 / 右键上下文菜单 → 2. 连线 (依赖 DAG) → 3. 单节点执行 (调 Generation V2, 状态实时回节点) / 批量执行 (按拓扑序, G12 前端串行) → 4. 结果预览 (节点内 thumbnail, 点击开详情抽屉) → 5. 节点成本预估 (CostTag: 单价×count, 提交前显示) → 6. 画布保存 (自动 5s + 手动, G1) → 7. 导出 (图片打包/视频列表) + "存为资产"。
画布内多用户一期不支持 (单 owner)。

## F5 资产库
- /assets 类型 tab (image/video/character/reference/audio/document) + 视图 Grid/List + 搜索 (prompt/文件名) + 过滤 (模型/provider/项目/日期/来源: 生成/上传) + 标签。
- 详情抽屉: 预览 / prompt 全文 / model+provider+cost / 生成任务链 / 来源节点 / 操作 (下载、复用为参考图、送画布、编辑(图片)、举报、删除)。
- 上传: OSS 直传 (sign-upload) 失败降级本地 /api/media 直存。

## F6 角色管理
- 角色 = 形象参考图 + 设定文本 + 标签; 用于生成时注入 referenceImages (一致性) 与画布 Character 节点; 统计 (被引用次数, characters/:id/stats)。

## F7 任务中心
- /tasks 全部任务 (G2 history) 5 态 + 过滤; 进行中置顶 (SSE 实时更新); 失败任务显示用户面原因 + Advanced details; 取消/重试; 与顶栏 Running Tasks 同源。

## F8 账户 / 计费 / 设置
- Account: 资料/改密/反馈。Billing: 余额+流水+充值订单+充值。Settings: 偏好 (主题/语言/默认参数模板) + 导出我的媒体 + 危险区 (注销 — 一期仅前端提示, 后端 G: 无注销 API, 记 GAP 不实现)。

## 错误与边界流
- 401: 单例处理 → 刷新 token → 失败跳 /login (保留 redirect)。
- 503/shedding: 生成闸门 (沿用现 apiGenerate 90s 预算) → UI 显示 "系统繁忙, 自动重试中"。
- SSE 断线: 3s 重连, 期间轮询 status 兜底; 重连后拉 /generate/active 对齐。
- 空状态: 真空库, 禁止 mock (铁律)。
