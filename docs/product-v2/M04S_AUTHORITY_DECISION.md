# M04-S AUTHORITY DECISION

Date: 2026-08-28
Baseline: 336e79e. Evidence: M04S_REALITY_AUDIT.md (Q1-Q8, all file/line-cited).

## Authoritative Asset Entity

**`media` table, evolved in place.**

Evidence that a parallel `assets` table is NOT justified:
1. `media.id` is already the stable identity every consumer knows:
   dispatcher placeholders, Generation V2 `pendingId=item_id`, frontend
   GenerationBar id-locking, `reference_styles.source_media_id`,
   `style_earnings.media_id`, `projects.cover_asset_id` (reserved in 0012).
2. Both generation pipelines (legacy dispatcher, Generation V2 upload worker)
   already converge on a single idempotent write: `assetFinalize.insertMedia`.
   A second table would require either dual-writes (new authority split) or
   migrating the durable write path (rewriting Generation V2 durable core —
   explicitly forbidden by the M04-S brief).
3. `media` already carries owner, storage key, status, file size, task
   provenance — the 80% of an AssetRef. Missing pieces (project/workspace
   scope, normalized type/status/origin) are additive columns + one relation
   table, not a structural rewrite.

AssetRef projection (V2 API) is computed from `media` (+ `projects`/
`workspaces` joins) with zero new identity: `assetId === media.id`.

## Authoritative Storage Metadata

`media.oss_object_key` remains the single storage key of record.
`oss_configs` (admin) remains the credential store — unchanged.
The **Asset URL resolver** is the new boundary: V2 asset responses are
produced by `server/modules/project-foundation/assetFoundation.cjs`
`resolveAssetUrls()`, which reuses the EXISTING `oss.cjs` primitives
(`loadOssConfigs`, `buildOssGetUrl`, `buildOssThumbUrl`,
`buildOssVideoSnapshotUrl`) — the same read-time re-sign logic `GET /api/media`
already uses (server.js:2565). No OSS rewrite, no new SDK, no credential
exposure: the V2 API returns only resolved URLs + `ossUploaded` boolean.

## Legacy Media Compatibility

- `media` schema changes are **additive only** (0013: new nullable columns
  `workspace_id`, `project_id`, `mime_type`, `width`, `height`, `duration_ms`,
  `origin`, `generation_batch_id` + indexes). All existing rows remain valid;
  all legacy DML (assetFinalize, POST /api/media, reaper) is untouched except
  the minimal project-scoped upsert extension (opt-in params, default NULL).
- `media.status` is NOT replaced: V2 asset status is a projection
  (`success`→READY, `pending_upload`→PROCESSING, `failed`→FAILED,
  `is_deleted`→ARCHIVED). Legacy `status` values keep meaning unchanged.
- `media.type` is NOT replaced: V2 assetType is a projection
  (`image`/`video` kept, `audio`/other→OTHER, new rows may store
  normalized type).
- Legacy `/api/media*` and `/api/oss*` behavior is byte-identical for callers
  that don't use the new optional fields.

## Generation Result Provenance (minimum)

- `media.task_id` (existing) = legacy generation task link.
- New `media.generation_batch_id` = Generation V2 batch (nullable; set via the
  same finalize path, `pendingId` already carries item identity).
- New `media.origin` ∈ {`upload`,`generation`,`import`,`derived`} — default
  derived from existing `source`/`category` columns at read time for legacy
  rows (no backfill needed); written explicitly for new rows.
- Future version/lineage stack: `assetId` stays stable and
  `projects.cover_asset_id` + any future node payload stores only `assetId`,
  so a later `asset_versions`/lineage table can attach without re-identifying
  anything. Nothing in 0013 blocks that.

## Project ↔ Asset Relation

New `project_assets(project_id, asset_id, added_at)` — explicit many-to-many
(relation table, NOT project JSONB). Backed by `media.project_id` as the fast
filter column for "list project assets"; `project_assets` is the canonical
membership (allows an asset to belong to multiple projects in the future,
e.g. shared references). Authorization: project access (workspace membership,
M01-S `requireProjectAccess` semantics) + asset owner check for register.

## What is deliberately NOT decided here (M05+)

- Canvas node persistence format (contract only: nodes store `assetId`,
  optional future `assetVersionId`; never base64/credentials/temp URLs).
- Version stack / lineage graph / derived-asset DAG.
- Transcoding/thumbnail platform (existing OSS thumb + video snapshot rules
  are reused as-is; missing dimensions/duration stay `null`).
