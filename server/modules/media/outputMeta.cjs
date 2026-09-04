'use strict';
/**
 * L29 — Output metadata（§82 Media Metadata 扩展）：checksum + probe 归一。
 *
 * 落点裁决（实查后）：
 *   - metadata 存 `generation_output_manifests.artifacts[].metadata`（JSONB 宽容）。
 *   - checksum  存 `generation_output_manifests.artifacts[].checksum`（sha256 hex）。
 *   - 理由：artifacts 已是 `JSONB NOT NULL DEFAULT '[]'`（0065/L27 已合表），
 *     纯 JSONB 扩展即零新列、零新迁移 DDL；media 表(0001) 无 width/height/duration/codec
 *     专属列，media_derived_artifacts(0050) 是「派生产物按 (asset_id,kind) 台账」，承载
 *     stitch/frame_extract 等派生 kind，与「主产物元数据」语义不贴；故不加列，走 artifacts JSONB。
 *
 * 全部纯函数 + 可注入 probe；永不 throw（probe 失败 → null，缺字段 → drop）。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function computeSha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function computeMd5Hex(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}
function computeMd5Base64(buf) {
  return crypto.createHash('md5').update(buf).digest('base64');
}

/**
 * 识别 provider checksum 算法（宽容：strip 引号后按长度判别）。
 *   64 hex → sha256；32 hex → md5-hex；其余（含 opaque etag）→ md5-base64 尝试。
 *   空/缺省 → null（不校验不炸）。
 */
function detectChecksumAlgorithm(expected) {
  const s = String(expected == null ? '' : expected).trim().replace(/^"|"$/g, '');
  if (!s) return null;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return 'sha256';
  if (/^[0-9a-fA-F]{32}$/.test(s)) return 'md5-hex';
  // md5 base64：16 字节 → 22 chars（无 padding）或 24 chars（'==' padding）。
  // 其余（opaque etag / S3 multipart etag 等）→ null = 不校验（宽容跳过，sha256 作权威锚点）。
  if (/^[A-Za-z0-9+/]{22}(==)?$/.test(s)) return 'md5-base64';
  return null;
}

/**
 * 校验 provider checksum vs 实际字节。永不 throw。
 * @returns {{ verifiable: boolean, matched: boolean, algorithm: string|null,
 *             actualSha256: string, actualMd5Hex: string, actualMd5Base64: string }}
 *   - verifiable=false：算法不可识别（如 opaque etag）→ 调用方跳过校验（宽容，不判失败）。
 *   - verifiable=true 且 matched=false：mismatch → 调用方判失败（完整性破坏，§79 VERIFY 闸）。
 */
function verifyChecksum(buffer, expected) {
  const actualSha256 = computeSha256(buffer);
  const actualMd5Hex = computeMd5Hex(buffer);
  const actualMd5Base64 = computeMd5Base64(buffer);
  const algorithm = detectChecksumAlgorithm(expected);
  if (!algorithm) {
    return { verifiable: false, matched: false, algorithm: null, actualSha256, actualMd5Hex, actualMd5Base64 };
  }
  const exp = String(expected).trim().replace(/^"|"$/g, '');
  let matched = false;
  if (algorithm === 'sha256') matched = exp.toLowerCase() === actualSha256.toLowerCase();
  else if (algorithm === 'md5-hex') matched = exp.toLowerCase() === actualMd5Hex.toLowerCase();
  else matched = exp === actualMd5Base64;
  return { verifiable: true, matched, algorithm, actualSha256, actualMd5Hex, actualMd5Base64 };
}

/**
 * 宽容归一 provider/probe 元数据 → { codec, audioCodec, durationMs, width, height, thumbnailUrl }。
 *   - duration 统一整数毫秒（float 秒绝不进 DB 主时间单位）。
 *   - 未知 codec 原样保留字符串（绝不炸）；缺字段 drop（宽容缺失）。
 * 永不 throw。
 */
function normalizeOutputMetadata(raw = {}, opts = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pickInt = (v) => {
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const toMs = (v) => {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v * 1000);
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Math.round(Number(v) * 1000);
    return undefined;
  };
  const str = (v) => (v == null || String(v).trim() === '' ? undefined : String(v));

  const out = {};
  const codec = str(src.codec ?? src.videoCodec ?? src.video_codec ?? src.codec_name ?? src.vcodec);
  if (codec !== undefined) out.codec = codec;
  const audioCodec = str(src.audioCodec ?? src.audio_codec ?? src.acodec);
  if (audioCodec !== undefined) out.audioCodec = audioCodec;
  const durationMs = pickInt(src.durationMs) ?? toMs(src.duration ?? src.duration_seconds);
  if (durationMs !== undefined) out.durationMs = durationMs;
  const width = pickInt(src.width);
  if (width !== undefined) out.width = width;
  const height = pickInt(src.height);
  if (height !== undefined) out.height = height;
  const thumb = str(opts.thumbnailUrl ?? src.thumbnailUrl ?? src.thumbnail);
  if (thumb !== undefined) out.thumbnailUrl = thumb;
  return out;
}

/**
 * 真实 ffprobe 探针：buffer 落临时文件 → ffprobe -show_format -show_streams。
 * 返回 normalizeOutputMetadata 的入参 raw（duration 秒 / width / height / codec / audioCodec）；
 * 失败/无 ffprobe/非媒流 → null（宽容，绝不炸）。spawn 可注入（测试用 fake）。
 */
function probeBufferWithFfprobe(buffer, { spawn = require('child_process').spawn, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return resolve(null);
    let tmpDir;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'outmeta-'));
      fs.writeFileSync(path.join(tmpDir, 'probe.bin'), buffer);
    } catch (_e) {
      return resolve(null);
    }
    const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} };

    let proc;
    try {
      proc = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', path.join(tmpDir, 'probe.bin')], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (_e) {
      cleanup();
      return resolve(null);
    }
    let out = '';
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; cleanup(); resolve(v); };
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('error', () => { clearTimeout(timer); finish(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return finish(null);
      try {
        const json = JSON.parse(out);
        const streams = Array.isArray(json.streams) ? json.streams : [];
        const video = streams.find((s) => s.codec_type === 'video');
        const audio = streams.find((s) => s.codec_type === 'audio');
        finish({
          duration: json.format && json.format.duration,
          width: video && video.width,
          height: video && video.height,
          codec: video && video.codec_name,
          audioCodec: audio && audio.codec_name,
        });
      } catch (_e) {
        finish(null);
      }
    });
  });
}

module.exports = {
  computeSha256,
  computeMd5Hex,
  computeMd5Base64,
  detectChecksumAlgorithm,
  verifyChecksum,
  normalizeOutputMetadata,
  probeBufferWithFfprobe,
};
