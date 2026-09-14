# 14 — UAT Plan

日期: 2026-08-27
环境: 本地隔离 (TEST_PG_PORT=5433 moling_test + Redis 16379, 铁律) → staging 预检 → 生产切换观察。
原则: 无执行证据不宣称 PASS; 失败 3 次/20 分钟无新证据 → 停, 写 BLOCKER。

## S1 注册-充值-生成闭环 (Phase B 门禁)
1. 新邮箱注册 → 登录 → /dashboard 显示余额 0
2. /billing 充值 (线下/admin 代充, G10) → 余额更新
3. /create 文生图 count=4 → 5 态流转 (SSE, 无轮询闪烁) → 4 张完成
4. 账务: 扣费 = 单价×4 (credit_transactions 1 commit); 中途取消 1 张 → release 正确
5. 余额不足场景: 扣到 0 提交 → 明确错误 + 充值 CTA
证据: 任务 ID/流水 ID/截图

## S2 资产库 (Phase C 门禁)
1. /assets 7 类型切换, Grid/List, 搜索 prompt, 过滤 model/provider/日期
2. 上传 (OSS 开/关 双跑), 详情抽屉: prompt/model/cost/来源任务
3. 图片编辑回写; 送画布; 下载; 删除; 举报
4. 空库 = 真空状态 (无 mock — 回归铁律)
5. /characters 角色 CRUD + 参考图绑定 + stats

## S3 计费对账 (Phase C/G)
- 用户: /billing/history 流水与 credit_transactions 一致
- admin: finance overview/kpi 与 DB 聚合一致; ledger 盈亏 = 收入-线路成本
- reconcile: 构造 review_required (测试 fake provider 超时) → admin 处理路径

## S4 无限画布 (Phase D 门禁, 最高风险)
1. 建画布: 16 节点类型拖入 (Audio 禁用态提示), 连线类型矩阵拦截非法连接
2. 单节点生成 (Image t2i) → 节点 5 态 → 结果预览 → 存资产
3. 批量 DAG (Prompt→Image→Video 3 层) → 拓扑序执行 → 层内并行 → 成本合计预估准确
4. 撤销/重做 50 步; 刷新恢复 (自动保存); 手动保存
5. 失败注入 (G3 fake/断网): 节点 failed 显示用户面原因, 重跑不重复扣 (idempotencyKey)
6. 200 节点性能: 拖拽/缩放 60fps (Chrome perf 面板)
7. 命令面板 Cmd+K 创建/搜索; 右键菜单; 多选成组移动

## S5 短剧流程 (Phase E 门禁)
1. 模板 (3 集) 新建 → 13 阶段逐步: concept→script(agent)→episode→scene→character(绑定)→storyboard→keyframe(批量 9 张)→video_shot(批量)→subtitle→timeline 排序→export 清单
2. 每阶段"打开画布" → 节点映射正确; 画布改动"保存回流程" → 阶段状态更新
3. 断点: 中途刷新 → 阶段产物不丢 (meta)
4. 账务: 批量 keyframe 扣费 = 张数×单价

## S6 Admin 全页 (Phase F 门禁)
- 23 页逐页: 加载/CRUD/过滤/危险操作确认
- Provider 四页拆分校验: 连接配置页无 key/模型混入; Key Pool 批量导入 (10 key 粘贴, 冲突检测); Bindings 矩阵编辑; Health 冷却/同步 diff
- 路由模拟器: decide 返回决策链与 model-participation 一致
- Monitoring 3 tab 合并: activity/logs SSE 流 + 诊断; 清空带确认
- Security: audit 记录可见 (每次写操作留痕)

## S7 财务运营 (Phase G 门禁)
- webhook 事件审计页; OSS 日志流; 充值包 CRUD 生效于用户侧 /billing

## S8 性能/响应式/打磨 (Phase H 门禁)
- 路由级 chunk: admin 每页独立加载 (network 面板验证)
- <1024 sidebar overlay; <768 画布只读提示
- a11y: 键盘走查 (Tab/focus ring/aria 标签)
- 回归: 现有 51 vitest 用例 + API 40/40 + V2 213/213 全绿 (不得回归)

## 切换观察 (生产, 30min)
- 5xx=0; 登录/注册/生成/画布保存/资产上传 各 1 真实验证
- SSE 重连; 301 重定向表全量 curl; 旧 bundle hash 替换确认
- 回滚演练: 备份 dist 恢复 < 5min (切换前演练一次)

## 通过标准
- S1-S8 全 PASS 且有证据; 无 P0/P1 未决; P2 可带病上线 (记录)
- 认证后端 (V2 213 用例) 零改动零回归
