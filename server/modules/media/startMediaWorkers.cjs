'use strict';
// ─── 媒体归一化 worker 统一启动（probe/thumbnail/proxy/waveform/stitch/frame_extract）───
// 从 server.js 内联块抽出，供两处复用：
//   - server.js（MEDIA_JOBS_WORKER=1 且 placement='api'）
//   - server/media-worker-entry.cjs（placement='worker' 独立进程/容器）
// ffmpeg/ffprobe 子进程经 ffmpegPool 全局信号量限并发（settings.app.ffmpegConcurrency）。

const fs = require('fs');
const ffmpegPool = require('./ffmpegPool.cjs');
const { createMediaWorker } = require('./mediaWorker.cjs');

function startMediaWorkers({ pgPool, nodeId, ossMod, mediaExecMod, ossSignedGetUrl, activeOssConfig, ffmpegConcurrency = 2 }) {
  ffmpegPool.setMax(ffmpegConcurrency);
  const EXECUTORS = mediaExecMod.EXECUTORS;
  const rid = () => `av-${globalThis.crypto.randomUUID()}`;
  const deriveKey = (assetId, kind, fileName) =>
    `derived/${assetId}/${kind}/${Date.now()}_${String(fileName || 'out').replace(/[^\w.\-]+/g, '_')}`;

  // Artifact persistence: PUT derived file to active OSS (signed headers),
  // record an asset_versions row, and point media.thumbnail at it for thumbnails.
  // No storage configured ⇒ {ok:false} and the local-file result is the honest state.
  const storeDerived = async ({ kind, assetId, file }) => {
    const cfg = await activeOssConfig();
    const fpath = String(file || '');
    const abs = fpath.startsWith('/') ? fpath : `${process.cwd()}/${fpath}`;
    const buf = await fs.promises.readFile(abs).catch(() => null);
    if (!cfg || !buf) return { ok: false, reason: cfg ? 'file-unreadable' : 'no-storage' };
    const objectKey = deriveKey(assetId, kind, abs.split('/').pop());
    const contentType = kind === 'thumbnail' ? 'image/jpeg' : kind === 'proxy' ? 'video/mp4' : 'application/octet-stream';
    let putUrl, putHeaders = null;
    const pType = String(cfg.providerType || cfg.provider || cfg.type || '');
    if (pType.includes('tencent') || pType.includes('cos')) {
      putUrl = `https://${cfg._hostName || `${cfg.bucket}${cfg.appId ? '-' + cfg.appId : ''}.cos.${cfg.region || 'ap-shanghai'}.myqcloud.com`}/${objectKey}`;
      putHeaders = ossMod.tencentCosPutHeadersStream(cfg, objectKey, buf, contentType);
    } else {
      const host = (cfg.endpointExternal || '').includes(cfg.bucket) ? cfg.endpointExternal : `${cfg.bucket}.${cfg.endpointExternal || ''}`;
      putUrl = `https://${host}/${objectKey}`;
      putHeaders = ossMod.aliyunPutHeadersStream(cfg, objectKey, buf, contentType);
    }
    const h = putHeaders && putHeaders.headers ? putHeaders.headers : putHeaders;
    const put = await fetch(putUrl, { method: 'PUT', headers: h, body: buf }).catch(() => null);
    if (!put || put.status >= 300) return { ok: false, reason: `put-${put ? put.status : 'network'}` };
    const getUrl = await ossSignedGetUrl(objectKey);
    const meta = await pgPool.query(`SELECT project_id FROM media WHERE id = $1`, [assetId]).catch(() => ({ rows: [] }));
    const projectId = meta.rows.length ? meta.rows[0].project_id : null;
    if (projectId) {
      await pgPool.query(
        `INSERT INTO asset_versions (version_id, media_id, project_id, kind, status, storage_key, size_bytes, model, provider)
         VALUES ($1,$2,$3,'derived','ready',$4,$5,'ffmpeg',COALESCE($6,'oss')) ON CONFLICT (version_id) DO NOTHING`,
        [`${rid()}`, assetId, projectId, objectKey, buf.length, String(cfg.providerType || cfg.provider || '')],
      ).catch(() => {});
      if (kind === 'thumbnail' && getUrl) {
        await pgPool.query(`UPDATE media SET thumbnail = $1, updated_at = NOW() WHERE id = $2`, [getUrl, assetId]).catch(() => {});
      }
    }
    return { ok: true, url: getUrl || objectKey };
  };

  const workers = [];
  for (const kind of ['probe', 'thumbnail', 'proxy', 'waveform', 'stitch', 'frame_extract']) {
    if (!EXECUTORS[kind]) continue;
    const w = createMediaWorker({
      pg: pgPool,
      executors: { [kind]: EXECUTORS[kind] },
      kind,
      workerId: `${nodeId}-${kind}`,
      pollMs: 2000,
      resolveSource: async (params) => (params && params.objectKey ? ossSignedGetUrl(params.objectKey) : null),
      onProbeMeta: async ({ assetId, meta }) => {
        if (!meta) return;
        const cols = {};
        if (Number.isInteger(meta.width)) cols.width = meta.width;
        if (Number.isInteger(meta.height)) cols.height = meta.height;
        if (Number.isInteger(meta.durationMs)) cols.duration_ms = meta.durationMs;
        if (!Object.keys(cols).length) return;
        const sets = Object.keys(cols).map((k, i) => `${k} = $${i + 2}`).join(', ');
        await pgPool.query(`UPDATE media SET ${sets}, updated_at = NOW() WHERE id = $1`, [assetId, ...Object.values(cols)]).catch(() => {});
      },
      onArtifact: storeDerived,
    });
    workers.push(w);
    console.log(`[media-worker:${kind}] started (${nodeId}, running=${w.started})`);
  }
  return workers;
}

module.exports = { startMediaWorkers };
