-- 0047_canvas_presence.sql
-- G22 (2026-09-04) collaboration presence PG storage foundation (地基, 未挂载).
-- 依据 docs/product-v2/18-collaboration-g22-audit.md §3 与 presenceBus.cjs 的设计决策：
-- presenceBus 默认注入内存 Map 存储，仅用于开发/单测；生产应注入 PG 实现（同一
-- 记录形态 { userId, canvasId, state, lastSeenMs }，寻址键 (canvas_id, user_id) 复合主键）。
-- 本表即该 PG 落点（presencePgStore.cjs 的存储底座）。
--
-- 设计决策:
--   * 一行 = 某画布上某用户的最新一条 presence 记录（心跳 upsert 全量覆盖，
--     复合主键 (canvas_id, user_id) 保证每 (画布,用户) 至多一行）。
--   * state TEXT 无 CHECK —— 状态域校验（PRESENCE_STATES 单一真源枚举）由
--     presenceBus.cjs / presencePgStore.cjs 模块层负责（复制常量而非 require，
--     避免跨目录循环）；存储层保持纯存储，不裁决状态语义。
--   * last_seen_ms BIGINT：epoch 毫秒（与 Date.now() 同源）；过期判定/清理按
--     整数比较。⚠️ node-pg 把 int8 读回为字符串 —— store 层必须 Number() 归一。
--   * 无 TTL 触发器/无 FK：过期清理是应用层策略 —— presenceBus.peers 读时惰性
--     过滤，presencePgStore.sweep 按调度（如每 5s）DELETE last_seen_ms < 截止点；
--     DB 侧不加触发器，保持地基表单纯可移植。
--   * sweep 的 last_seen_ms < (nowMs - 30000) 为严格小于：age 恰为 TTL(30000ms)
--     的记录本次保留、下一拍清扫 —— 与 peers 的「age >= TTL 即过期」同语义上界，
--     方向安全（略晚清理不产生错误在线判定，peers 已惰性排除）。
--   * 复合主键左前缀 (canvas_id) 已覆盖按画布 list 的索引需求；last_seen_ms 无
--     独立索引 —— 行数量级 = 在线 (画布,用户) 数，全表范围扫描做 sweep 可接受。
--   * additive / forward-only / 无 FK（不引用任何既有表，纯地基表）。
CREATE TABLE IF NOT EXISTS canvas_presence (
  canvas_id     TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  state         TEXT NOT NULL,
  last_seen_ms  BIGINT NOT NULL,
  PRIMARY KEY (canvas_id, user_id)
);
