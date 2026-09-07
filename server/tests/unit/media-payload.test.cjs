const test = require('node:test');
const assert = require('node:assert/strict');
const { compactMediaPayload, parseLegacyDataUrl, pickMediaProbeUrl } = require('../../media-payload.cjs');

test('media list replaces duplicated legacy data URLs with lazy authenticated content URL', () => {
  const data = 'data:image/png;base64,aGVsbG8=';
  const [item] = compactMediaPayload([{ id: 'm 1', thumbnail: '/api/media/m%201/content', fullUrl: '/api/media/m%201/content', ossUrl: '', providerUrl: data }]);
  assert.equal(item.thumbnail, '/api/media/m%201/content');
  assert.equal(item.fullUrl, '/api/media/m%201/content');
  assert.equal(item.ossUrl, '');
  assert.equal(item.providerUrl, '');
  assert.equal(JSON.stringify(item).includes('aGVsbG8='), false);
});

test('normal object-storage URLs are preserved', () => {
  const [item] = compactMediaPayload([{ id: 'm2', thumbnail: 'https://cdn/t.webp', fullUrl: 'https://cdn/f.png', ossUrl: 'https://cdn/f.png' }]);
  assert.equal(item.thumbnail, 'https://cdn/t.webp');
  assert.equal(item.fullUrl, 'https://cdn/f.png');
  assert.equal(item.ossUrl, 'https://cdn/f.png');
});

test('file-size probe ignores structured/non-public URL values and falls back to signed URL', () => {
  const structured = { getUrl: 'https://broken.example/object' };
  assert.equal(
    pickMediaProbeUrl(structured, structured, 'https://oss.example/signed', ''),
    'https://oss.example/signed',
  );
  assert.equal(pickMediaProbeUrl('/api/media/m/content', 'data:image/png;base64,aA=='), '');
});

test('legacy content parser validates and decodes image data URL', () => {
  const parsed = parseLegacyDataUrl('data:image/png;base64,aGVsbG8=');
  assert.equal(parsed.contentType, 'image/png');
  assert.equal(parsed.body.toString(), 'hello');
  assert.equal(parseLegacyDataUrl('data:text/html;base64,PGgxPg=='), null);
});
