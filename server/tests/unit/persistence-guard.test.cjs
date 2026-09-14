'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isInlineDataUri,
  assertNotInlinePayload,
  sanitizeGenerationResultForList,
} = require('../../modules/media/persistenceGuard.cjs');

test('T5 — persistence guard：持久化 data URI 必须抛 INLINE_PAYLOAD_PERSISTENCE_FORBIDDEN', () => {
  assert.throws(
    () => assertNotInlinePayload('data:image/png;base64,iVBORw0KGgo=', 'media.oss_url'),
    (e) => e && e.code === 'INLINE_PAYLOAD_PERSISTENCE_FORBIDDEN',
  );
  // 合法 URL 不抛
  assert.doesNotThrow(() => assertNotInlinePayload('https://cdn.example/a.png', 'media.oss_url'));
  assert.doesNotThrow(() => assertNotInlinePayload('/local-media/img-1.png', 'media.oss_url'));
});

test('isInlineDataUri 只命中 data URI（含 mime 变体），不误伤普通 URL', () => {
  assert.equal(isInlineDataUri('data:image/png;base64,AAA'), true);
  assert.equal(isInlineDataUri('data:video/mp4;base64,AAA'), true);
  assert.equal(isInlineDataUri('data:text/plain;base64,AAA'), true);
  assert.equal(isInlineDataUri('https://cdn.example/a.png'), false);
  assert.equal(isInlineDataUri('/local-media/a.png'), false);
  assert.equal(isInlineDataUri('data:image/png,notbase64'), false); // 非 base64 编码
  assert.equal(isInlineDataUri(null), false);
  assert.equal(isInlineDataUri(123), false);
});

test('T4 — sanitizeGenerationResultForList 递归剔除 base64 与禁止键', () => {
  const result = {
    type: 'image',
    images: [
      { mediaId: 'm1', ossUrl: 'data:image/png;base64,AAAA', status: 'success' },
      { mediaId: 'm2', ossUrl: 'https://cdn.example/ok.png', status: 'success' },
    ],
    b64_json: 'AAAA',
    rawResponse: { huge: 'data:image/png;base64,BBBB' },
    videoMedia: { ossUrl: 'data:video/mp4;base64,CCCC' },
    meta: { ok: true },
  };
  const out = sanitizeGenerationResultForList(result);
  assert.equal(out.images[0].ossUrl, null); // data URI → null
  assert.equal(out.images[1].ossUrl, 'https://cdn.example/ok.png'); // 合法 URL 保留
  assert.equal(out.b64_json, undefined); // 禁止键剔除
  assert.equal(out.rawResponse, undefined);
  assert.equal(out.videoMedia.ossUrl, null); // 嵌套 videoMedia 也清理
  assert.equal(out.meta.ok, true); // 普通字段保留
});
