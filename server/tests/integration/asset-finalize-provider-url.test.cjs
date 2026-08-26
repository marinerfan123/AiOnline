'use strict';
// Regression: P0 — insertMedia must persist provider_url (INSERT + UPSERT),
// so the uploadQueue reaper can recover pending_upload rows instead of
// permanently marking them failed with 'provider_url missing, cannot upload'.
const test = require('node:test');
const assert = require('node:assert/strict');
const { insertMedia } = require('../../assetFinalize.cjs');

test('insertMedia persists provider_url (reaper recovery)', { concurrency: 1 }, async (t) => {
  const { assertSafeTestDatabase, createTestPool, initTestSchema, closeTestPool } = require('../helpers/test-db.cjs');
  assertSafeTestDatabase();
  const pg = createTestPool();
  await initTestSchema(pg);

  const mediaId = `m-regress-${Date.now()}`;
  const providerUrl = 'https://platform-outputs.example.space/images/regress-test.png';
  // media.user_id is FK to users — create a valid row
  const uid = `u-regress-${Date.now()}`;
  await pg.query("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES ($1,$2,'regress','x','user','active')", [uid, `regress-${Date.now()}@t.com`]);

  t.after(async () => {
    try {
      await pg.query('DELETE FROM media WHERE id=$1', [mediaId]);
      await pg.query('DELETE FROM users WHERE id=$1', [uid]);
    } catch (_) {}
    await closeTestPool(pg);
  });

  // INSERT path: pending_upload row (fetch failed once) must keep provider_url
  await insertMedia(pg, {
    mediaId, userId: uid, taskId: 'gt-regress', type: 'image',
    prompt: 'p', model: 'm', ratio: '1:1',
    providerUrl, ossUrl: '', ossObjectKey: '', ossUploaded: false,
    status: 'pending_upload', errorMessage: 'transient fetch fail', fileSize: 0,
  });
  const row1 = await pg.query('SELECT provider_url, status FROM media WHERE id=$1', [mediaId]);
  assert.equal(row1.rows.length, 1);
  assert.equal(row1.rows[0].provider_url, providerUrl, 'INSERT must persist provider_url');

  // UPSERT path: reaper re-finalizes on same mediaId (pendingId) → provider_url must survive
  await insertMedia(pg, {
    mediaId, userId: uid, taskId: 'gt-regress', type: 'image',
    prompt: 'p', model: 'm', ratio: '1:1',
    providerUrl, ossUrl: providerUrl, ossObjectKey: '', ossUploaded: false,
    status: 'success', errorMessage: '', fileSize: 1234,
  });
  const row2 = await pg.query('SELECT provider_url, status FROM media WHERE id=$1', [mediaId]);
  assert.equal(row2.rows[0].provider_url, providerUrl, 'UPSERT must keep provider_url');
  assert.equal(row2.rows[0].status, 'success');

  await pg.query('DELETE FROM media WHERE id=$1', [mediaId]);
});
