'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const ossMod = require('../../oss.cjs');

test('uploadObject uploads Aliyun bytes server-side without browser CORS', async (t) => {
  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: opts.method, headers: opts.headers, body: opts.body });
    return { ok: true, status: 200, text: async () => '' };
  };
  t.after(() => { global.fetch = origFetch; });
  const cfg = {
    providerType: 'aliyun-oss',
    bucket: 'bucket-a',
    endpointExternal: 'oss-cn-test.aliyuncs.com',
    accessKeyId: 'ak-test',
    accessKeySecret: 'sk-test',
  };
  const body = Buffer.from('hello-upload');
  const r = await ossMod.uploadObject(cfg, 'images/u1/file.png', body, { contentType: 'image/png' });
  assert.equal(r.ok, true);
  assert.equal(r.key, 'images/u1/file.png');
  assert.equal(r.providerType, 'aliyun-oss');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].body.toString(), 'hello-upload');
  assert.equal(calls[0].headers['Content-Type'], 'image/png');
  assert.ok(calls[0].headers.Authorization.startsWith('OSS ak-test:'));
  assert.ok(calls[0].url.includes('bucket-a.oss-cn-test.aliyuncs.com/images/u1/file.png'));
});

test('buildOssGetUrl returns signed GET url for persisted media', () => {
  const cfg = {
    providerType: 'aliyun-oss',
    bucket: 'bucket-a',
    endpointExternal: 'oss-cn-test.aliyuncs.com',
    accessKeyId: 'ak-test',
    accessKeySecret: 'sk-test',
  };
  const { getUrl } = ossMod.buildOssGetUrl(cfg, 'images/u1/file.png');
  assert.match(getUrl, /^https:\/\/bucket-a\.oss-cn-test\.aliyuncs\.com\/images\/u1\/file\.png\?/);
  assert.ok(getUrl.includes('OSSAccessKeyId=ak-test'));
  assert.ok(getUrl.includes('Signature='));
});
