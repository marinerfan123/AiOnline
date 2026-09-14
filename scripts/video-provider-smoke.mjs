#!/usr/bin/env node
// 视频 provider 冒烟脚本（最小验证工具，flash 构建叶专用）
//
// 目标：不经 server，直连 Agnes Video V2.0 API 验证「key + 模型」是否可用。
//   仅提交任务 + 15s 后一次状态查询；不轮询长任务、不接 server 代码、不改任何现有文件。
//
// 契约要点（源自 server/providers/video/agnes.cjs + shared.cjs，wire 级复刻）：
//   - 提交 POST {base_url}/videos          base_url 缺省 https://api.agnes-ai.cn/v1
//   - 查询 GET  {origin}/agnesapi?video_id=<taskId>   （origin = base_url 去 /v1 等路径）
//   - 鉴权 Authorization: Bearer <AGNES_KEY>；Content-Type: application/json
//   - 线体：model=agnes-video-v2.0（binding 的 upstreamModelName / model_id）
//           width/height 按 ratio+resolution 档位（agnesVideoSize 同表），1k 默认
//           num_frames = durationSec×25，夹取 [9,441] 且 8n+1（frame_rate=25）
//   - 提交返回 taskId 路径：默认 video_id（taskIdPath）；同步返回/终态也原样打印
//   - 成功终态判定：status ∈ ['completed']；视频地址 metadata.url（旧版回退根 url）
//   - 轮询默认间隔 8000ms，适配器 async 语义 —— 本脚本不接轮询循环
//
// 用法：
//   AGNES_KEY=sk-xxx node scripts/video-provider-smoke.mjs            # env 给 key
//   node scripts/video-provider-smoke.mjs --key=sk-xxx [--seconds=3]  # arg 给 key
//   node scripts/video-provider-smoke.mjs --dry                        # 只打印请求，不出网
//   可选：AGNES_BASE_URL=https://api.agnes-ai.cn/v1（覆盖默认提交 base）
//   退出码：0 = 提交拿到 taskId；2 = key 缺失/参数错；1 = 提交失败/HTTP 错误
'use strict';

const HELP = `用法:
  AGNES_KEY=sk-xxx node scripts/video-provider-smoke.mjs [--seconds=N] [--ratio=16:9] [--base=URL]
  node scripts/video-provider-smoke.mjs --key=sk-xxx --dry
选项:
  --key=sk-xxx    API key（优先取 env AGNES_KEY，其次此 arg）
  --seconds=N     视频时长秒（默认 6；num_frames=round(N×25) 夹 [9,441] 且 8n+1）
  --ratio=16:9    画幅 16:9|9:16|1:1|4:3|3:4（默认 16:9；尺寸按 agnesVideoSize 1k 档）
  --base=URL      提交 base_url（缺省 AGNES_BASE_URL env 或 https://api.agnes-ai.cn/v1）
  --dry           仅打印将发送的请求，不发网络
  -h|--help       本帮助`;

// ─── 小工具（复刻 shared.cjs getByPath 语义）──────────────────────
function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  const tokens = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(path))) {
    if (m[2] != null) tokens.push(Number(m[2]));
    else if (m[1] != null) tokens.push(m[1]);
  }
  let cur = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = typeof t === 'number' ? cur[t] : cur[t];
  }
  return cur;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 复刻 agnesVideoSize：ratio×resolution(默认1k)→width/height（与适配器同表）
const RATIO_SIZE = { '16:9': [1152, 648], '9:16': [648, 1152], '4:3': [1024, 768], '3:4': [768, 1024], '1:1': [1024, 1024] };
function agnesVideoSize(ratio, resolution) {
  const base = RATIO_SIZE[ratio] || RATIO_SIZE['1:1'];
  const scale = { '1k': 1, '2k': 1.5, '3k': 2, '4k': 2.5 }[String(resolution || '1k').toLowerCase()] || 1;
  return { width: Math.round(base[0] * scale), height: Math.round(base[1] * scale) };
}

// 复刻 buildAgnesVars 的时长→帧数规则：round(N×25)，夹 [9,441]，8n+1
function numFramesFor(seconds) {
  const n = Math.round((Number(seconds) || 6) * 25);
  const clamped = Math.min(441, Math.max(9, n));
  return Math.floor((clamped - 1) / 8) * 8 + 1;
}

// ─── 参数解析 ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const pick = (flag, envName) => {
  for (const a of args) if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  return envName ? (process.env[envName] || undefined) : undefined;
};
if (args.includes('-h') || args.includes('--help')) { console.log(HELP); process.exit(0); }

const apiKey = pick('--key', 'AGNES_KEY');
const baseUrl = (pick('--base', 'AGNES_BASE_URL') || 'https://api.agnes-ai.cn/v1').replace(/\/+$/, '');
const seconds = Number(pick('--seconds', undefined) || 6);
const ratio = pick('--ratio', undefined) || '16:9';
const dry = args.includes('--dry');
const model = 'agnes-video-v2.0'; // binding upstreamModelName / model_id

if (!apiKey) {
  console.error('[video-smoke] 缺少 API key：请设 env AGNES_KEY 或用 --key=sk-xxx 传入。');
  console.error(HELP);
  process.exit(2);
}
if (!RATIO_SIZE[ratio]) {
  console.error(`[video-smoke] 未知 ratio: ${ratio}（支持 ${Object.keys(RATIO_SIZE).join('|')}）`);
  process.exit(2);
}

// ─── 组装线体（与 agnes.cjs buildAgnesVars 逐字段一致）──────────────
const { width, height } = agnesVideoSize(ratio, '1k');
const body = { model, prompt: 'test minimal', height, width, num_frames: numFramesFor(seconds), frame_rate: 25 };

// 提交端点 + 轮询(查询)端点（复刻 resolveAgnesEndpoint 默认值）
const submitUrl = `${baseUrl}/videos`;
const origin = (() => { try { return new URL(baseUrl).origin; } catch { return 'https://api.agnes-ai.cn'; } })();
const pollUrlOf = (taskId) => `${origin}/agnesapi?video_id=${encodeURIComponent(taskId)}`;
const taskIdPath = 'video_id'; // submitEp.taskIdPath 默认

async function httpJson(url, { method = 'GET', jsonBody, timeoutMs = 60000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: jsonBody === undefined ? undefined : JSON.stringify(jsonBody),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: res.status, body: parsed };
  } finally { clearTimeout(timer); }
}

function summarizePoll(body) {
  // 成功 URL 优先级：metadata.url → 根 url（与适配器一致）
  let url = getByPath(body, 'metadata.url');
  if (!url) url = getByPath(body, 'url');
  const st = String(getByPath(body, 'status') ?? (body && body.status) ?? '');
  const line = { status: st, ...(url ? { url } : {}) };
  return JSON.stringify(line);
}

// ─── 执行 ─────────────────────────────────────────────────────────
const redacted = apiKey.length > 8 ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}` : '(short)';

async function main() {
  if (dry) {
    console.log(`[video-smoke] --dry 模式（不出网）。将发送：`);
    console.log(JSON.stringify({
      step: 'submit', method: 'POST', url: submitUrl,
      headers: { Authorization: `Bearer ${redacted}` },
      body,
    }, null, 2));
    const exampleId = 'vt-dry-example';
    console.log(`\n[video-smoke] 成功后 15s 的一次状态查询将发往：`);
    console.log(JSON.stringify({ step: 'poll', method: 'GET', url: pollUrlOf(exampleId) }, null, 2));
    console.log(`\n[video-smoke] --dry 校验通过：脚本可出网运行（需真实 AGNES_KEY）。`);
    return;
  }

  console.log(`[video-smoke] 提交: POST ${submitUrl}  model=${model}  frames=${body.num_frames}(${seconds}s×25fps)  ${width}x${height}  key=${redacted}`);
  const sub = await httpJson(submitUrl, { method: 'POST', jsonBody: body });
  console.log(`[video-smoke] 提交响应 HTTP ${sub.status}:`);
  console.log(JSON.stringify(sub.body, null, 2));

  if (sub.status >= 400) {
    const msg = (sub.body && (sub.body.error && sub.body.error.message)) || (sub.body && sub.body.message) || `HTTP ${sub.status}`;
    console.error(`[video-smoke] 提交失败：${msg}`);
    process.exit(1);
  }

  const taskId = String(getByPath(sub.body, taskIdPath) ?? '').trim();
  if (!taskId) {
    // 无 video_id：若响应已带视频 URL（同步返回终态），仍算验证通过
    let url = getByPath(sub.body, 'metadata.url') || getByPath(sub.body, 'url');
    if (url) { console.log(`[video-smoke] 同步返回视频 URL：${url}`); process.exit(0); }
    console.error(`[video-smoke] 提交成功但无 taskId(${taskIdPath}) 且无视频 URL：taskIdPath 配置？`);
    process.exit(1);
  }

  console.log(`\n[video-smoke] 任务已提交：taskId=${taskId}`);
  console.log(`[video-smoke] 等待 15s 后做一次状态查询（不轮询长任务）…`);
  await sleep(15_000);

  const pollUrl = pollUrlOf(taskId);
  console.log(`\n[video-smoke] 查询: GET ${pollUrl}`);
  const pr = await httpJson(pollUrl);
  console.log(`[video-smoke] 查询响应 HTTP ${pr.status}:`);
  console.log(JSON.stringify(pr.body, null, 2));
  console.log(`[video-smoke] 归一摘要: ${summarizePoll(pr.body)}`);
  const st = String((pr.body && (getByPath(pr.body, 'status') ?? pr.body.status)) || '').toLowerCase();
  if (st === 'completed' || st === 'succeeded') console.log('[video-smoke] 任务已完成 ✅（视频 URL 见上 metadata.url/url）');
  else if (['failed', 'error', 'canceled', 'cancelled'].includes(st)) console.log('[video-smoke] 任务终态失败 ❌（未计费成功）');
  else console.log(`[video-smoke] 任务仍在进行（status=${st || '(空)'}）。复跑轮询或接 dispatcher 续轮询。`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`[video-smoke] 执行异常：${(e && e.message) || String(e)}`);
  process.exit(1);
});
