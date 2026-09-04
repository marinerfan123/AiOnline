-- 0065_output_manifest.sql
-- 墨渊 V2.0 §78-80 — OutputManifest / Provider Success≠Job Success / Finalize 独立重试（L27，独占 0065 段）。
--   后续叶 L28（Finalize 独立重试）+ L29（Media Metadata 扩展）会继续追加本文件（同段串行），
--   本批仅落 L27 的表 + 快照语义；下方以分隔线标记「L27 段结束」边界，追加内容写在其后，勿改写上方。
--
-- 背景（§78-80）：
--   §78 Driver 不返回单一 video_url，而返回 OutputManifest `{artifacts:[{role, media_type, source}], provider_metadata}`。
--       多产物（primary_video/preview_video/audio/thumbnail/first_frame/last_frame/image_sequence/alpha_video/metadata）归一。
--   §79 Provider Success ≠ Job Success：SUCCEEDED→FETCH OUTPUT→VERIFY→PERSIST→MEDIA METADATA→SETTLE→Job SUCCEEDED。
--       中间任何一步失败，Job 都未成功（仍处 retry 域）。
--   §80 Finalize 独立重试：Provider 成功 + OSS 故障 → 先存 provider result snapshot → 重试 FINALIZE，
--       绝不能重新生成。本表即该 snapshot 的持久化。
--
-- 语义（与 assetFinalize.cjs 的 snapshotOutputManifest / finalizeOutputManifest 对齐）：
--   provider_manifest  = provider 原始 OutputManifest 原样快照（JSONB，不做任何归一/改写）。
--   artifacts          = 归一产物列表 [{url, kind, mimeType, sizeBytes, checksum?}]。
--                         sizeBytes/checksum 在拉取落库成功前为 NULL/缺省；成功后由 finalize 回填。
--   media_ids          = 与 artifacts 下标对齐的「已落库 media 行 id」数组；未落库项为 NULL。
--                         「media_ids 齐」= 无 NULL = 所有 artifacts 已落库 = Job Success 的必要条件之一。
--   finalized_at       = 全部 artifacts 落库 + media_ids 齐时置 NOW()；否则 NULL（仍 retry 域）。
--   retry_count        = 同 attempt 的 FINALIZE 重试次数（快照重放计数）；新 attempt 重置为 0。
--
-- Provider Success 仅入快照：快照行的存在即「provider 已成功产出 manifest」的落库标记；
--   但 Job Success 仅当 finalized_at 非 NULL（artifacts 全落 + media_ids 齐）才算，两者严格区分（§79）。
--
-- 幂等：以 job_id 为幂等锚点（snapshotOutputManifest 用 upsert：不存在则 INSERT，存在则覆盖更新）；
--   同 attempt 重放 = retry_count+1 且保留已落库 media_ids；新 attempt = 重置 retry_count 与 media_ids。
--
-- EXTEND 原则：纯 additive（CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS），不改、不删既有表/列/数据。
-- Rollback：移除 generation_output_manifests 表即可（无外部引用，纯 additive 表）。

CREATE TABLE IF NOT EXISTS generation_output_manifests (
  job_id            TEXT PRIMARY KEY,
  attempt_id        TEXT NOT NULL,
  provider_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  artifacts         JSONB NOT NULL DEFAULT '[]'::jsonb,
  media_ids         TEXT[] NOT NULL DEFAULT '{}',
  finalized_at      TIMESTAMPTZ,
  retry_count       INT NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 查询索引：按 attempt 反查（webhook/activity 关联 attempt_id → 定位 job snapshot）。
CREATE INDEX IF NOT EXISTS ix_generation_output_manifests_attempt
  ON generation_output_manifests (attempt_id);

-- 未终结重试域扫描索引：finalized_at IS NULL = 仍处 retry 域（reconciler 重放 FINALIZE 用）。
CREATE INDEX IF NOT EXISTS ix_generation_output_manifests_unfinalized
  ON generation_output_manifests (created_at)
  WHERE finalized_at IS NULL;

-- ── 列注释 ───────────────────────────────────────────────────────────────────
COMMENT ON TABLE generation_output_manifests IS
  '墨渊 V2.0 §78-80: provider OutputManifest 原样快照 + 归一 artifacts + media_ids 落库追踪。Provider Success 仅入快照；Job Success 需 artifacts 全落 + media_ids 齐（finalized_at 非 NULL）。FINALIZE 独立重试从此快照重放，绝不重新生成';

COMMENT ON COLUMN generation_output_manifests.job_id IS
  'Job 标识（generation-v2 batch_id/item_id 语义）。PK：每 Job 一份输出快照（幂等锚点 ON CONFLICT (job_id)）';
COMMENT ON COLUMN generation_output_manifests.attempt_id IS
  '产出该 manifest 的 attempt 标识（generation_item_attempts_v2.attempt_id 语义）。同 attempt 重放=retry_count+1；新 attempt=重置';
COMMENT ON COLUMN generation_output_manifests.provider_manifest IS
  '§78: provider 原始 OutputManifest 原样快照（JSONB，零归一/零改写），供重试重放与审计';
COMMENT ON COLUMN generation_output_manifests.artifacts IS
  '§78: 归一产物列表 [{url,kind,mimeType,sizeBytes,checksum?}]。kind 取自 provider role；sizeBytes/checksum 拉取落库前缺省，成功后回填';
COMMENT ON COLUMN generation_output_manifests.media_ids IS
  '与 artifacts 下标对齐的已落库 media 行 id 数组；未落库项 NULL。media_ids 齐（无 NULL）= artifacts 全落';
COMMENT ON COLUMN generation_output_manifests.finalized_at IS
  '§79: 全部 artifacts 落库 + media_ids 齐时置 NOW()；否则 NULL（仍 retry 域）。Job Success 的唯一判据';
COMMENT ON COLUMN generation_output_manifests.retry_count IS
  '§80: 同 attempt 的 FINALIZE 重试次数（快照重放计数）；新 attempt 重置为 0。>= 0 CHECK';

-- ═══════════════════════════════════════════════════════════════════════════════
-- L27 段结束（本批到此为止）。
-- 后续 L28（Finalize 独立重试——reconciler/activity 接线 + 快照重放循环）与
--   L29（Media Metadata 扩展——checksum/codec/width/height/duration/fps 等）追加于下方，勿改写上方 L27 内容。
-- ═══════════════════════════════════════════════════════════════════════════════
