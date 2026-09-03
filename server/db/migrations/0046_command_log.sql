-- 0046_command_log.sql
-- G22 (2026-09-04) collaboration command-log storage foundation (地基, 未挂载).
-- 依据 docs/product-v2/18-collaboration-g22-audit.md: 仓库有命令信封纯契约
-- (envelopes.cjs COMMAND_TYPES 35 种 / collabContract.validateCommandEnvelope)
-- 与整画布 CAS revision，但零逐命令持久化日志 —— 命令总线尚未实现，本表即其
-- 存储底座：每条命令一行，追加式(append-only)，读方按 (canvas_id, seq) 有序回放。
--
-- 设计决策:
--   * seq = BIGSERIAL，由 PG 序列分配(非应用层计算)；复合主键 (canvas_id, seq)
--     使 seq 只在画布域内有意义 —— 每画布的命令流严格按追加序递增，永不改写/删除。
--     ⚠️ 注意: 单条全局序列被所有画布共享，因此某画布自己的 seq 数值序列按追加序
--     严格递增，但若多画布并发追加，数值上会有跨画布间隙；且 ON CONFLICT DO NOTHING
--     的重复尝试也会消费 nextval 但不落行(留洞)。消费方只能用 "seq > 游标" 的游标
--     语义(见 listAfter)，绝不可用 seq 数值做计数/差值运算。
--   * 幂等: UNIQUE (canvas_id, command_id) —— 同一 canvasId+commandId 的重复追加被
--     ON CONFLICT DO NOTHING 静默吞掉，不产生第二行 (写入语句带 RETURNING seq 时
--     冲突路径无返回行，调用方据此判定 idempotent)。
--   * 与 0043 run_events (run_id, seq) 同构: 本表键为 (canvas_id, command_id)
--     命令 id 幂等，而非 (canvas_id, seq) —— seq 由 DB 分配、重试不回填。
--   * payload JSONB 可空: 信封语义(非空纯对象)由 validateCommandEnvelope 负责，
--     存储层不重复设 CHECK；actor_id / base_revision 可空(枚举/正则约束同前)。
--   * received_at TIMESTAMPTZ: 服务端接收时刻；默认 DB NOW() 兜底(手工/脚本插入)，
--     正常写入路径由 store 显式传 to_timestamp(epoch_ms/1000) 保持与 app 时钟一致。
--   * additive / forward-only / 无 FK(不引用任何既有表，纯地基表)。
CREATE TABLE IF NOT EXISTS canvas_command_log (
  canvas_id      TEXT NOT NULL,
  seq            BIGSERIAL,
  command_id     TEXT NOT NULL,
  type           TEXT NOT NULL,
  actor_id       TEXT,
  base_revision  INT,
  payload        JSONB,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (canvas_id, seq),
  UNIQUE (canvas_id, command_id)
);
