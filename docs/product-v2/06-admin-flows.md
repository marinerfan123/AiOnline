# 06 — Admin Flows (V2)

日期: 2026-08-27
铁律: 认证核心 (Generation V2 执行链) 不重写; Admin 对其只做只读观测 (G3 新增 API 仅 SELECT)。

## A1 运营总览 (/admin)
- 顶: KPI 行 (用户数/今日生成/成功率/收入/余额池) 来自 finance.overview + generations 聚合
- 中: 实时活动流 (console/stream SSE) + 队列深度 (queue-status) + worker 心跳 (G3)
- 底: 最近失败任务 / 未处理 issues / 对账异常 (review_required) 三栏, 分别深链 generations/security/attempts

## A2 Provider 运维 (拆散后的四页, 替代旧 ModelHub 大卡片)
1. Providers: 列表 (名称/baseUrl/协议/状态/并发) → 表单 (连接配置 only) → test-endpoint 即时回显。删除/禁用二次确认 (级联影响提示: 绑定数/key 数)。
2. Key Pool: 按 provider 分组; 批量导入 (多行粘贴→解析→冲突检测 UNIQUE(provider_id,api_key)) / 单 key 编辑 (label/status/weight) / 健康统计 (failures/lastUsedAt 列) / 禁用启用。
3. Provider Bindings: 矩阵 (模型行 × provider 列), 格子 = binding (enabled/upstream_model_name/priority/weight); 点格子编辑; 空态提示"该模型无可用线路"。
4. Provider Health: states 实时 (cooldown/circuit), 手动 set-cooldown, 同步模型 (sync → diff 预览 → 确认落库), preview-models 测试连接不落库。

## A3 模型与定价
- Model Hub: 模型 CRUD (type image/video/text, canonical model_id 唯一约束提示), batch 导入, 删除前检查绑定/历史任务。
- Pricing: 每模型用户价 (credit_cost) + 每线路成本 (provider_model_costs) + 历史 (model-price-history 图表); 改动走 revision 乐观锁。
- Smart Routing: decide 模拟器 (输入 model/contentType/seed → 显示完整路由决策链: 候选线路/权重/冷却/成本) + 参与视图 (各模型线路份额) + 路由任务日志 (routing/jobs)。

## A4 生成执行观测 (只读)
- Generation Tasks: 全量任务表 (状态/provider/耗时/成本/错误), 过滤 + 深链 Attempts。
- Attempts (G3): item_attempts 时间线 (每 item: 提交/key/响应/重试/fencing 结果) — 排障主视图。
- Workers (G3): 心跳表 (worker_id/last_beat/lease 持有数/内存), 离线高亮。
- 用户任务失败排障流: Tasks 行 → Attempts 时间线 → 关联 key 健康 → 结论 (上游 429/超时/SSRF/OSS) → 必要时 set-cooldown 或调绑定。

## A5 账务
- Finance: overview KPI + 盈亏 (ledger summary: 收入 vs 线路成本) + 对账 (reconcile 差异清单, review_required 处理: 人工确认/退款 — 后端既有能力)。
- Recharge: 充值包 CRUD + 订单 (状态/渠道/金额) + 手动充值 (users/:id/credits) + 积分流水 (transactions)。
- Payment: 渠道 (providers CRUD/toggle) + 设置 (payment-settings) + webhook 审计 (webhook_events/payment_audit 只读)。

## A6 内容与智能体
- Agents: 列表/新建 (agent_type)/toggle/providers 绑定; 子 tab: agent-providers, agent-rules (规则+日志)。
- Skills: skill_registry 管理 (启用/参数/定价 — /api/skill/run 真实扣积分, 改价即改收入)。
- Examples: 示例库 CRUD + 推送默认 (push)。
- Reference Styles: 审核队列 (approve/reject/promote + 分成率) + 已通过列表。

## A7 用户与平台
- Users: 搜索/角色/状态/积分调整/重置密码 (hashPassword 流程, 不用预计算 hash)/删除 (软删? 后端现状为准)。
- Storage: OSS 配置槽 CRUD + 激活 + test + 日志流 (oss/logs/stream) + 用量 (media 聚合)。
- Monitoring: 时间范围 + 3 tab (activity=request_logs 流 / logs=系统日志 SSE / diagnose=聚合诊断) + 清空 (带确认)。
- Security: 审计日志 (audit) + 错误归档 (errors+DELETE 清理) + 用户反馈 (feedback) + 举报 (reports) 处理队列。
- System Settings: app settings (并发上限等) + 功能开关 — 改前提示影响面。

## A8 权限边界
- 所有 admin 页 RequireAdmin (UX 层) + 后端 admin 校验 (最终边界)。
- 危险操作 (删 provider/删模型/改价/重置密码/清日志/手动充值) 一律二次确认 + 输入关键字或二次点击。
- 审计: 现有 audit_logs 已记录 admin 写操作, Security 页可见。
