'use strict';
// P0 Base64 Kill — 验收测试 T1/T2/T3/T6
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { finalizeUrl, materializeInlineUrl, isInlineDataUri } = require('../../assetFinalize.cjs');
const { createLocalMediaStore } = require('../../modules/media/localMediaStore.cjs');

const PAYLOAD = Buffer.from('hello-image-bytes-for-p0-kill');
const SHA256 = crypto.createHash('sha256').update(PAYLOAD).digest('hex');
const DATA_URI = `data:image/png;base64,${PAYLOAD.toString('base64')}`;

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-mgr-'));
  return createLocalMediaStore({ rootDir: dir });
}

// 构造 OSS 配置 mock：disabled / enabled-aliyun
function pgMock({ ossEnabled = false, ossList = [] } = {}) {
  return {
    query: async (sql, params) => {
      const s = String(sql);
      if (/SELECT \* FROM oss_config WHERE id=1/.test(s)) {
        return { rows: ossEnabled ? [{ enabled: true, active_id: 'oss-1' }] : [{ enabled: false, active_id: null }], rowCount: 1 };
      }
      if (/SELECT \* FROM oss_configs/.test(s)) return { rows: ossList, rowCount: ossList.length };
      if (/^INSERT INTO media /.test(s)) {
        // 捕获 media 写入参数做断言
        return { rows: [], rowCount: 1, _mediaParams: params };
      }
      if (/^SELECT project_id FROM media /.test(s)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('T1 — b64 + OSS OFF：managed local 成功，media 无 data URI，result 无 base64，checksum 正确', async () => {
  const store = tmpStore();
  const pg = pgMock({ ossEnabled: false });
  const captured = [];
  const pgCapture = {
    query: async (sql, params) => {
      const r = await pg.query(sql, params);
      if (String(sql).includes('INSERT INTO media')) captured.push(params);
      return r;
    },
  };
  const res = await finalizeUrl(pgCapture, {
    userId: 'u1', taskId: 'gt-p0-t1', idx: 0, providerUrl: DATA_URI, type: 'image',
    prompt: 'p', model: 'm', ratio: '1:1', pendingId: 'm-t1', managedStore: store,
  });
  assert.equal(res.status, 'success');
  assert.equal(res.ossUploaded, false); // 无 OSS
  assert.ok(res.ossUrl.startsWith('/local-media/'), `ossUrl 应为 managed local URL，实际 ${res.ossUrl}`);
  assert.equal(res.sha256, SHA256, 'sha256 必须正确');
  assert.ok(!isInlineDataUri(res.ossUrl), 'ossUrl 不得是 data URI');
  assert.ok(!isInlineDataUri(res.providerUrl), 'providerUrl 不得是 data URI');
  // media 写入参数不含 data URI
  const mediaParams = captured[0];
  assert.ok(mediaParams, '应有一次 media INSERT');
  const all = JSON.stringify(mediaParams);
  assert.ok(!all.includes('base64,'), 'media 参数不得含 base64');
  assert.ok(!all.includes('data:image'), 'media 参数不得含 data URI');
  // T6 readback：managed local 字节逐字节可读
  const key = res.ossUrl.replace('/local-media/', '');
  const decoded = require('../../oss.cjs').decodeUrlKey(res.ossUrl);
  const buf = await store.get({ objectKey: decoded });
  assert.ok(buf.equals(PAYLOAD), 'readback 字节一致');
});

test('T2 — b64 + OSS 失败：managed local 兜底，pending_upload，无 data URI', async () => {
  const store = tmpStore();
  const origFetch = global.fetch;
  // OSS PUT 失败
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'oss-down' });
  const pg = pgMock({
    ossEnabled: true,
    ossList: [{ id: 'oss-1', providerType: 'aliyun-oss', enabled: true, accessKeyId: 'k', accessKeySecret: 's', bucket: 'b', region: 'cn-1', pathPrefix: 'images/' }],
  });
  try {
    const res = await finalizeUrl(pg, {
      userId: 'u1', taskId: 'gt-p0-t2', idx: 0, providerUrl: DATA_URI, type: 'image',
      prompt: 'p', model: 'm', ratio: '1:1', pendingId: 'm-t2', managedStore: store,
    });
    assert.equal(res.status, 'pending_upload');
    assert.ok(res.ossUrl.startsWith('/local-media/'), 'OSS 失败应回退 managed local URL');
    assert.ok(!isInlineDataUri(res.ossUrl) && !isInlineDataUri(res.providerUrl), '绝不 data URI');
    const buf = await store.get({ objectKey: require('../../oss.cjs').decodeUrlKey(res.ossUrl) });
    assert.ok(buf.equals(PAYLOAD), 'managed local 副本保留');
  } finally {
    global.fetch = origFetch;
  }
});

test('T3 — b64 + OSS OFF + managed local 也失败：显式失败，不落 base64', async () => {
  // store 注入为「写必失败」
  const store = { put: async () => { throw new Error('disk full'); }, urlFor: () => { throw new Error('no url'); }, get: async () => { throw new Error('n/a'); } };
  const pg = pgMock({ ossEnabled: false });
  const captured = [];
  const pgCapture = {
    query: async (sql, params) => {
      const r = await pg.query(sql, params);
      if (String(sql).includes('INSERT INTO media')) captured.push(params);
      return r;
    },
  };
  const res = await finalizeUrl(pgCapture, {
    userId: 'u1', taskId: 'gt-p0-t3', idx: 0, providerUrl: DATA_URI, type: 'image',
    prompt: 'p', model: 'm', ratio: '1:1', pendingId: 'm-t3', managedStore: store,
  });
  assert.equal(res.status, 'failed');
  assert.ok(!isInlineDataUri(res.ossUrl) && !isInlineDataUri(res.providerUrl), '失败也绝不 data URI');
  const mediaParams = captured[0];
  assert.ok(mediaParams, '应有一次 media INSERT（failed）');
  const all = JSON.stringify(mediaParams);
  assert.ok(!all.includes('base64,'), 'media 参数不得含 base64');
});

test('materializeInlineUrl — 非内联 URL 原样返回；内联落 managed local', async () => {
  const store = tmpStore();
  const http = 'https://cdn.example/a.png';
  assert.equal(await materializeInlineUrl(http, { userId: 'u', taskId: 't', idx: 0, store }), http);
  const out = await materializeInlineUrl(DATA_URI, { userId: 'u', taskId: 't', idx: 0, store });
  assert.ok(out.startsWith('/local-media/'), '内联应落 managed local');
  assert.ok(!isInlineDataUri(out));
  const buf = await store.get({ objectKey: require('../../oss.cjs').decodeUrlKey(out) });
  assert.ok(buf.equals(PAYLOAD));
});
