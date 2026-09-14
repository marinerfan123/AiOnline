# M04-S REALITY AUDIT

Date: 2026-08-28
Baseline: 336e79e (M01-S project workspace foundation, clean tree)

Scope: durable media/asset authority, generation result persistence, OSS storage
metadata, project/media relationship, existing API/UI surface. Evidence only —
no code changed for this audit.

## Q1. What is the current durable media/asset authority?

**`media` table.** All durable media rows (uploaded, generated, pending) live in
`media` (server/db/migrations/0001_baseline_legacy_schema.sql:42, runtime DDL
server/server.js:172). It is written by:

- `server/assetFinalize.cjs` → `insertMedia()` (ON CONFLICT (id) DO UPDATE,
  idempotent) — the single write path for generation results (both legacy
  dispatcher `finalizeTask` and Generation V2 `production-adapters.uploadToOss`
  call `assetFinalize.finalizeUrl`).
- `POST /api/media` (server/server.js:2650) — client-side upload registration
  after presigned OSS PUT (`/api/oss/sign-upload`, server.js:4293). Server
  re-signs `oss_url` server-side; client URL is never trusted.
- Reaper repair paths (`server/scripts/repair-base64-media.cjs`,
  `probeBatchAndMarkFailed`, `enrichMediaFileSize`).

There is **no separate asset/version/lineage table** anywhere in migrations
0001-0012. `generation_items_v2` (migrations 0002/0003) stores `oss_url` per
item for the V2 pipeline, but that is pipeline state, not the durable media
authority: the finalize step writes the same bytes/URL into `media`
(`upload-worker.cjs` → `upload-finalize.finalizeUploadedItem` settles the hold
and the media row written by `assetFinalize` is the durable record).

## Q2. What is the `media` table's role?

Unified durable media ledger:
- identity: `id` (TEXT PK; `mf-`/`v` prefixed ids minted by `genMediaId`, or
  `pendingId` from the intake so placeholder id = final asset id)
- ownership: `user_id` (FK users, SET NULL; legacy NULL rows are public)
- content refs: `full_url`, `thumbnail`, `oss_url`, `oss_object_key`,
  `oss_uploaded`, `provider_url` (reaper recovery), `file_size`
- provenance (weak): `task_id` (generation_tasks.task_id), `source`
  ('user'|'generated'|'default'), `category` ('generated','upload','character',
  'scene','prop','other'), `prompt`, `model`, `ratio`, `tags`
- lifecycle: `status` ('success'|'pending_upload'|'failed'), `error_message`,
  `failed_at`, soft delete `is_deleted`, `is_favorite`
- cross-refs: `character_id`, `reference_style_id`, `default_key`

Read path `GET /api/media` (server.js:2565) re-signs expired OSS URLs at read
time (`buildOssGetUrl`, pure HMAC) — this is the existing **URL resolver**.

## Q3. How do generation results reach media/storage?

- Legacy: dispatcher task done → `assetFinalize.finalizeTask(pgPool, ctx,
  providerImages, providerVideoUrl)` → per item `finalizeUrl()`:
  fetch provider bytes (SSRF-guarded) → OSS/COS PUT via
  `aliyunPutHeaders`/`tencentCosPutHeaders` (no SDK) → re-signed 7d GET URL →
  `insertMedia()` idempotent upsert. Failures write
  `status='pending_upload'` placeholder keeping `provider_url` for the reaper.
- Generation V2: worker tick `upload-worker.processUploadItem` →
  `production-adapters.uploadToOss` → **same** `assetFinalize.finalizeUrl`
  (with `pendingId = item.item_id`) → `upload-finalize.finalizeUploadedItem`
  CAS item + settle hold in one transaction. The media row is the durable
  asset; `generation_items_v2.oss_url` is pipeline projection.

## Q4. Where do OSS/COS object key / url / checksum / metadata live?

- `media.oss_object_key` — the storage object key (durable, namespaced
  `{prefix}/{userId}/{ts}_{name}`).
- `media.oss_url` — signed GET URL (7d; re-signed at read time).
- `media.thumbnail` — OSS image thumb / video snapshot signed URL.
- **No checksum stored** (Aliyun Content-MD5 is computed in-flight for PUT
  signing only, not persisted). `file_size` is persisted.
- Bucket credentials live in `oss_configs` (admin-only API `/api/oss*`);
  `oss.cjs` `loadOssConfigs` resolves the active config.

## Q5. Where do image/video/audio metadata live today?

- image: `type='image'`, `ratio`, `file_size`, `thumbnail` (OSS thumb rule).
  **No width/height persisted** (probed client-side via `useImageProbe`).
- video: `type='video'`, `thumbnail` = OSS video snapshot frame.
  **No durationMs persisted.**
- audio: no dedicated handling; `type` is free text, no audio pipeline today.
- provenance text: `prompt`, `model`, `ratio`, `tags`.

## Q6. Current project ↔ media relationship

**None.** `projects` (migration 0012, M01-S) has `cover_asset_id TEXT`
(reserved, nullable, no FK) but no project-scoped media linkage. `media` has
no `project_id`/`workspace_id`. Projects and media are only related transitively
via the same user. M01-S API never touches media.

## Q7. Does an asset/version/lineage concept already exist?

No. No `assets`, `asset_versions`, or lineage tables in 0001-0012. The closest
concepts: `media.id` as stable identity, `media.task_id` as generation
provenance, `default_assets` (seeded default media, separate table, unrelated
to user assets). No version stack.

## Q8. Which legacy APIs/UI must stay compatible?

- `GET/POST /api/media`, `GET /api/media/counts`, `DELETE/PUT /api/media/:id`
  (server.js:2565-2790) — used by legacy WorkspacePage/MediaPicker/GenerationBar.
- `/api/oss/sign-upload`, `/api/oss/ingest` (upload pipeline) — frontend
  presigned direct PUT.
- `assetFinalize.finalizeUrl` contract — called by dispatcher **and**
  Generation V2 production adapters; signature must stay backward compatible.
- Legacy `reference_styles.source_media_id`, `style_earnings.media_id`,
  `media.character_id` cross-refs — media.id is load-bearing.
- V1 media read path re-sign behavior (expired URL refresh) — must keep working.

## Conclusion

The real durable authority is `media` and it is structurally sound for long-term
asset identity (stable id, owner, storage key, status, provenance task link).
What it lacks for Studio/Canvas: workspace/project scoping, normalized
assetType/status/origin, and a resolver boundary that consumers (Canvas nodes)
can use without touching OSS details.

→ Decision: **evolve `media` in place** (additive columns + new `project_assets`
relation + V2 Asset API/projection on top). Do NOT create a parallel assets
table — that would fork the authority in exactly the way the M04-S brief
forbids. See M04S_AUTHORITY_DECISION.md.
