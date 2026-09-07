'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { insertMedia, finalizeTask } = require('../../assetFinalize.cjs');

test('insertMedia persists reference_images for generated media rows', async () => {
  const calls = [];
  const pg = {
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return { rows: [], rowCount: 1 };
    },
  };
  await insertMedia(pg, {
    mediaId: 'm-ref-1',
    userId: 'u1',
    taskId: 'gt-ref-1',
    type: 'image',
    prompt: 'p',
    model: 'm',
    ratio: '1:1',
    providerUrl: 'https://cdn/out.png',
    referenceImages: ['https://ref/a.png', 'https://ref/b.png'],
    ossUrl: 'https://cdn/out.png',
    ossObjectKey: '',
    ossUploaded: false,
    status: 'success',
    errorMessage: '',
    fileSize: 12,
  });
  const ins = calls.find((c) => /INSERT INTO media /.test(c.sql));
  assert.ok(ins, 'media insert query exists');
  assert.match(ins.sql, /reference_images/);
  assert.equal(ins.params[16], JSON.stringify(['https://ref/a.png', 'https://ref/b.png']));
});

test('finalizeTask carries ctx.referenceImages into each finalized asset', async () => {
  const inserted = [];
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => String(name).toLowerCase() === 'content-type' ? 'image/png' : null },
    arrayBuffer: async () => Buffer.from('png-bytes').buffer,
    body: null,
  });
  const pg = {
    query: async (sql, params) => {
      const s = String(sql);
      if (/SELECT \* FROM oss_config WHERE id=1/.test(s)) return { rows: [{ enabled: false, active_id: null }], rowCount: 1 };
      if (/SELECT \* FROM oss_configs/.test(s)) return { rows: [], rowCount: 0 };
      if (/^INSERT INTO media /.test(s)) {
        inserted.push({ sql: s, params });
        return { rows: [], rowCount: 1 };
      }
      if (/^SELECT project_id FROM media /.test(s)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  try {
    await finalizeTask(pg, {
      userId: 'u1',
      taskId: 'gt-ref-finalize',
      prompt: 'p',
      model: 'm',
      ratio: '1:1',
      contentType: 'image',
      pendingIds: ['p1', 'p2'],
      referenceImages: ['https://ref/a.png'],
    }, ['https://cdn/out1.png', 'https://cdn/out2.png'], null);
  } finally {
    global.fetch = origFetch;
  }
  assert.equal(inserted.length, 2);
  assert.deepEqual(inserted.map((x) => JSON.parse(x.params[16])), [['https://ref/a.png'], ['https://ref/a.png']]);
});
