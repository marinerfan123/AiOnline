-- 0073_generation_outbox_v2_relax_notnull.sql
-- 根因修复（2026-09-05 真链 shadow 取证发现）：
--   generation_outbox_v2 为 0002 代 item 形状设计，item_id/batch_id/user_id 均 NOT NULL；
--   而 legacy 分发（dispatcher L11 'generate.requested'）与 V2 intake（'generation.batch.accepted'）
--   都是 aggregate 形状写入，不携带 item 三列 → 每次 INSERT 23502 → 静默 fail-open，
--   outbox 从未真正落行（单测假库无约束未暴露）。
-- 裁决：去 NOT NULL（additive、非破坏、不改数据），消费端另行按 event_type 分域
--   （dispatcher relay 只取 'generate.requested'；worker V2 outboxTick 排除之），
--   避免 worker V2 消费者误领 legacy 行标记 delivered 造成取证/续投丢失。
ALTER TABLE generation_outbox_v2
  ALTER COLUMN item_id  DROP NOT NULL,
  ALTER COLUMN batch_id DROP NOT NULL,
  ALTER COLUMN user_id  DROP NOT NULL;
