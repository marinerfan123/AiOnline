'use strict';
// G08 — 生成图/视频结果 asset_versions 版本化写入。
// 覆盖：finalize 成功落 media 行后补写 asset_versions（字段齐、kind/status/storage_key/size_bytes）、
//       未绑定项目时跳过（project_id NOT NULL 防护）、version_id 幂等（ON CONFLICT DO NOTHING）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { finalizeUrl, insertAssetVersion, recordAssetVersion } = require('../../assetFinalize.cjs');

const ossMod = require('../../oss.cjs');
const ssrfMod = require('../../ssrf.cjs');

async function ensureVersionSchema(pg) {
  await pg.query(`CREATE TABLE IF NOT EXISTS asset_versions (
    version_id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    origin_asset_id TEXT,
    generation_id TEXT,
    model TEXT,
    provider TEXT,
    storage_key TEXT,
    size_bytes BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pg.query(`ALTER TABLE media ADD COLUMN IF NOT EXISTS project_id TEXT`);
}

async function insertUserAndMedia(pg, { mediaId, uid, projectId }) {
  await pg.query(
    "INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES ($1,$2,'ver','x','user','active')",
    [uid, `${uid}@t.com`],
  );
  await pg.query(
    `INSERT INTO media (id, user_id, type, source, status, project_id) VALUES ($1,$2,'image','user','pending_upload',$3)`,
    [mediaId, uid, projectId || null],
  );
}

test('G08: finalize 成功后补写 asset_versions 行且字段齐（project-bound media，OSS 未启用路径）', { concurrency: 1 }, async (t) => {
  const { assertSafeTestDatabase, createTestPool, initTestSchema, closeTestPool } = require('../helpers/test-db.cjs');
  assertSafeTestDatabase();
  const pg = createTestPool();
  await initTestSchema(pg);
  await ensureVersionSchema(pg);

  const uid = `u-ver-${Date.now()}`;
  const mediaId = `m-ver-${Date.now()}`;
  const projectId = `proj-${Date.now()}`;
  await insertUserAndMedia(pg, { mediaId, uid, projectId });

  // Mock 网络/OSS：fetch 返回假 PNG 字节，SSRF 放行，OSS 未启用 → finalizeUrl 走 OSS 未启用成功分支。
  const origFetch = global.fetch;
  const origCheck = ssrfMod.asyncCheckUrl;
  const origLoad = ossMod.loadOssConfigs;
  global.fetch = async () => ({ ok: true, headers: { get: () => null }, body: null, arrayBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
  ssrfMod.asyncCheckUrl = async () => ({ ok: true });
  ossMod.loadOssConfigs = async () => ({ enabled: false, activeId: '', list: [] });

  t.after(async () => {
    global.fetch = origFetch;
    ssrfMod.asyncCheckUrl = origCheck;
    ossMod.loadOssConfigs = origLoad;
    try {
      await pg.query('DELETE FROM asset_versions WHERE media_id=$1', [mediaId]);
      await pg.query('DELETE FROM media WHERE id=$1', [mediaId]);
      await pg.query('DELETE FROM users WHERE id=$1', [uid]);
    } catch (_) {}
    await closeTestPool(pg);
  });

  const res = await finalizeUrl(pg, {
    userId: uid, taskId: 'gt-ver', idx: 0,
    providerUrl: 'https://img.example.com/x.png',
    type: 'image', prompt: 'p', model: 'm', ratio: '1:1',
    pendingId: mediaId,
  });
  assert.equal(res.status, 'success');

  const v = await pg.query('SELECT * FROM asset_versions WHERE media_id=$1', [mediaId]);
  assert.equal(v.rows.length, 1, 'finalize 后应存在且仅一条 asset_versions 行');
  const row = v.rows[0];
  assert.match(row.version_id, /^av-/, 'version_id 应为 av- 前缀（rid("av") 风格）');
  assert.equal(row.media_id, mediaId);
  assert.equal(row.project_id, projectId);
  assert.equal(row.kind, 'generated');
  assert.equal(row.status, 'ready');
  assert.equal(row.generation_id, 'gt-ver');
  assert.equal(row.model, 'm');
  assert.equal(Number(row.size_bytes), 4, 'size_bytes 应为拉取字节数');
  assert.equal(row.storage_key, '', 'OSS 未启用时 storage_key 为空');
});

test('G08: 未绑定项目（project_id 为空）时跳过 asset_versions，不违反 NOT NULL', { concurrency: 1 }, async (t) => {
  const { assertSafeTestDatabase, createTestPool, initTestSchema, closeTestPool } = require('../helpers/test-db.cjs');
  assertSafeTestDatabase();
  const pg = createTestPool();
  await initTestSchema(pg);
  await ensureVersionSchema(pg);

  const uid = `u-noproj-${Date.now()}`;
  const mediaId = `m-noproj-${Date.now()}`;
  await insertUserAndMedia(pg, { mediaId, uid, projectId: null });

  t.after(async () => {
    try {
      await pg.query('DELETE FROM asset_versions WHERE media_id=$1', [mediaId]);
      await pg.query('DELETE FROM media WHERE id=$1', [mediaId]);
      await pg.query('DELETE FROM users WHERE id=$1', [uid]);
    } catch (_) {}
    await closeTestPool(pg);
  });

  const wrote = await recordAssetVersion(pg, { mediaId, taskId: 'gt-noproj', model: 'm', storageKey: 'img/k.png', sizeBytes: 10 });
  assert.equal(wrote, false, '未绑定项目应跳过写入');
  const v = await pg.query('SELECT 1 FROM asset_versions WHERE media_id=$1', [mediaId]);
  assert.equal(v.rows.length, 0);
});

test('G08: insertAssetVersion 幂等（同一 version_id 重复写仅一行）且字段可覆写参数', { concurrency: 1 }, async (t) => {
  const { assertSafeTestDatabase, createTestPool, initTestSchema, closeTestPool } = require('../helpers/test-db.cjs');
  assertSafeTestDatabase();
  const pg = createTestPool();
  await initTestSchema(pg);
  await ensureVersionSchema(pg);

  const uid = `u-idem-${Date.now()}`;
  const mediaId = `m-idem-${Date.now()}`;
  const projectId = `proj-${Date.now()}`;
  const versionId = `av-${Date.now()}`;
  await insertUserAndMedia(pg, { mediaId, uid, projectId });

  t.after(async () => {
    try {
      await pg.query('DELETE FROM asset_versions WHERE media_id=$1', [mediaId]);
      await pg.query('DELETE FROM media WHERE id=$1', [mediaId]);
      await pg.query('DELETE FROM users WHERE id=$1', [uid]);
    } catch (_) {}
    await closeTestPool(pg);
  });

  const row = {
    versionId, mediaId, projectId, kind: 'generated', status: 'ready',
    storageKey: 'images/k1.png', sizeBytes: 2048, generationId: 'gt-idem', model: 'model-x',
  };
  await insertAssetVersion(pg, row);
  await insertAssetVersion(pg, { ...row, storageKey: 'images/k2.png' }); // 重复写 → DO NOTHING
  const v = await pg.query('SELECT * FROM asset_versions WHERE media_id=$1', [mediaId]);
  assert.equal(v.rows.length, 1, 'ON CONFLICT DO NOTHING 应保持仅一行');
  assert.equal(v.rows[0].version_id, versionId);
  assert.equal(v.rows[0].storage_key, 'images/k1.png', '首次写入的值应保留');
  assert.equal(Number(v.rows[0].size_bytes), 2048);
});
