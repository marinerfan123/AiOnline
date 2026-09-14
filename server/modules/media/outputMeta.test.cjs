'use strict';
// server/modules/media/outputMeta.test.cjs — L29 Media Metadata 纯函数单测。
// 覆盖（任务测试清单）：
//   1. 元数据归一（normalizeOutputMetadata：codec/durationMs/width/height/thumbnailUrl，duration 统一整数 ms）。
//   2. 宽容缺失（缺字段 drop 为无键；空对象/非对象不炸）。
//   3. codec 未知不炸（未知 codec 字符串原样保留）。
//   4. checksum 校验（verifyChecksum：sha256/md5-hex/md5-base64/etag 匹配与 mismatch；opaque 宽容跳过）。
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeSha256,
  computeMd5Hex,
  computeMd5Base64,
  detectChecksumAlgorithm,
  verifyChecksum,
  normalizeOutputMetadata,
} = require('./outputMeta.cjs');

// ── 1. 元数据归一 ─────────────────────────────────────────────────────────────
test('normalizeOutputMetadata: 完整归一（float 秒→整数 ms；thumbnailUrl 透传）', () => {
  const meta = normalizeOutputMetadata(
    { codec: 'h264', duration: 10.5, width: 1920, height: 1080 },
    { thumbnailUrl: 'https://oss/x-thumb.jpg' },
  );
  assert.deepStrictEqual(meta, {
    codec: 'h264',
    durationMs: 10500,
    width: 1920,
    height: 1080,
    thumbnailUrl: 'https://oss/x-thumb.jpg',
  });
});

test('normalizeOutputMetadata: durationMs 已是整数则原样保留；duration_seconds 别名', () => {
  assert.equal(normalizeOutputMetadata({ durationMs: 1234 }).durationMs, 1234);
  assert.equal(normalizeOutputMetadata({ duration_seconds: '2.5' }).durationMs, 2500);
  assert.equal(normalizeOutputMetadata({ duration: 0 }).durationMs, 0);
});

test('normalizeOutputMetadata: 宽容缺失 —— 空对象/缺字段 → 无键（不炸不塞 undefined 键）', () => {
  assert.deepStrictEqual(normalizeOutputMetadata({}), {});
  assert.deepStrictEqual(normalizeOutputMetadata(null), {});
  assert.deepStrictEqual(normalizeOutputMetadata(undefined), {});
  assert.deepStrictEqual(normalizeOutputMetadata('not-an-object'), {});
  assert.deepStrictEqual(normalizeOutputMetadata({ width: 640 }), { width: 640 }, '缺失字段不得产出 undefined 键');
});

test('normalizeOutputMetadata: codec 未知不炸（原样保留字符串）', () => {
  const meta = normalizeOutputMetadata({ codec: 'vp09-some-future-codec', width: 1280 });
  assert.equal(meta.codec, 'vp09-some-future-codec');
  assert.equal(meta.width, 1280);
  assert.equal('durationMs' in meta, false, '无 duration 输入 → 不产出 durationMs 键');
});

test('normalizeOutputMetadata: codec 字段别名 + audioCodec 别名', () => {
  assert.equal(normalizeOutputMetadata({ videoCodec: 'hevc' }).codec, 'hevc');
  assert.equal(normalizeOutputMetadata({ codec_name: 'vp9' }).codec, 'vp9');
  assert.equal(normalizeOutputMetadata({ audio_codec: 'aac' }).audioCodec, 'aac');
});

test('normalizeOutputMetadata: 非法/负值/非整数/空字符串 → 宽容 drop', () => {
  const meta = normalizeOutputMetadata({
    width: -5, height: 'abc', duration: 'nope', codec: '', durationMs: 2.5,
  });
  assert.deepStrictEqual(meta, {}, '非法字段应全部 drop');
});

// ── 2. checksum 校验 ──────────────────────────────────────────────────────────
const BUF = Buffer.from('hello moling output metadata');

test('computeSha256: 已知向量', () => {
  // echo -n "hello moling output metadata" | sha256sum
  assert.equal(computeSha256(BUF), require('crypto').createHash('sha256').update(BUF).digest('hex'));
  assert.equal(computeSha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('verifyChecksum: sha256 hex 匹配 / mismatch', () => {
  const sha = computeSha256(BUF);
  const ok = verifyChecksum(BUF, sha);
  assert.equal(ok.verifiable, true);
  assert.equal(ok.matched, true);
  assert.equal(ok.algorithm, 'sha256');

  const bad = verifyChecksum(BUF, '0'.repeat(64));
  assert.equal(bad.verifiable, true);
  assert.equal(bad.matched, false, 'sha256 mismatch 必须判失败');
});

test('verifyChecksum: md5 hex（32 hex）匹配 / mismatch', () => {
  const md5 = computeMd5Hex(BUF);
  assert.equal(verifyChecksum(BUF, md5).matched, true);
  assert.equal(verifyChecksum(BUF, 'f'.repeat(32)).matched, false);
});

test('verifyChecksum: md5 base64（含引号 etag）匹配 / mismatch', () => {
  const b64 = computeMd5Base64(BUF);
  assert.equal(verifyChecksum(BUF, b64).matched, true);
  assert.equal(verifyChecksum(BUF, `"${b64}"`).matched, true, 'etag 带引号应剥离后匹配');
  assert.equal(verifyChecksum(BUF, 'Y29tcGxldGVseS13cm9uZy1ldGFn').matched, false);
});

test('verifyChecksum: opaque/空 checksum → 宽容不校验（verifiable=false 不炸不判失败）', () => {
  const opaque = verifyChecksum(BUF, 'opaque-s3-etag-not-a-hash');
  assert.equal(opaque.verifiable, false, '不可识别算法 → 跳过校验');
  assert.equal(opaque.matched, false);

  assert.equal(verifyChecksum(BUF, '').verifiable, false);
  assert.equal(verifyChecksum(BUF, null).verifiable, false);
  assert.equal(verifyChecksum(BUF, undefined).verifiable, false);
});

test('detectChecksumAlgorithm: 长度判别（引号剥离后；opaque → null 不校验）', () => {
  assert.equal(detectChecksumAlgorithm('a'.repeat(64)), 'sha256');
  assert.equal(detectChecksumAlgorithm('a'.repeat(32)), 'md5-hex');
  assert.equal(detectChecksumAlgorithm(`"${'b'.repeat(32)}"`), 'md5-hex', '引号包裹的 32 hex 仍判 md5-hex');
  assert.equal(detectChecksumAlgorithm('A'.repeat(22)), 'md5-base64', '22 字符 base64 md5');
  assert.equal(detectChecksumAlgorithm(`${'A'.repeat(22)}==`), 'md5-base64', '24 字符（含 == padding）base64 md5');
  assert.equal(detectChecksumAlgorithm('opaque'), null, 'opaque etag → null（不校验）');
  assert.equal(detectChecksumAlgorithm(''), null);
  assert.equal(detectChecksumAlgorithm(null), null);
});

// ── 3. 端到端：缺则补 sha256 计算 + 有则核验 的编排语义 ──────────────────────
test('编排语义：无 provider checksum → 补 sha256；有且匹配 → 通过；有且不匹配 → 判失败', () => {
  // 模拟 finalizeUrl 的校验逻辑（见 assetFinalize.cjs 1.5 段）
  function decide(buffer, expectedChecksum) {
    const sha256 = computeSha256(buffer);
    if (!expectedChecksum) return { status: 'success', checksum: sha256 }; // 缺则补
    const v = verifyChecksum(buffer, expectedChecksum);
    if (v.verifiable && !v.matched) return { status: 'checksum_mismatch' }; // 有则核验失败
    return { status: 'success', checksum: sha256 }; // 核验通过（或 opaque 宽容通过）
  }

  const r1 = decide(BUF, undefined);
  assert.equal(r1.status, 'success');
  assert.equal(r1.checksum, computeSha256(BUF), '缺 provider checksum → 补 sha256 落库');

  const r2 = decide(BUF, computeSha256(BUF));
  assert.equal(r2.status, 'success', '有且匹配 → 通过');

  const r3 = decide(BUF, 'f'.repeat(64));
  assert.equal(r3.status, 'checksum_mismatch', '有且不匹配 → 判失败（§79 VERIFY 闸）');
});
