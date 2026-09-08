'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { parseJsonBody } = require('../../request-body.cjs');

function bodyStream(chunks) {
  return Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
}

test('request body parser rejects once cumulative bytes exceed limit', async () => {
  const req = bodyStream(['12345', '67890', 'x']);
  await assert.rejects(
    parseJsonBody(req, { maxBytes: 10 }),
    (error) => error && error.code === 'PAYLOAD_TOO_LARGE' && error.statusCode === 413,
  );
});

test('request body parser parses valid JSON within byte limit', async () => {
  const req = bodyStream(['{"ok":', 'true}']);
  assert.deepEqual(await parseJsonBody(req, { maxBytes: 64 }), { ok: true });
});

test('request body parser preserves legacy null result for invalid JSON', async () => {
  assert.equal(await parseJsonBody(bodyStream(['not-json']), { maxBytes: 64 }), null);
});
