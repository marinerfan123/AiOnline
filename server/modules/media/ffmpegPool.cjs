'use strict';
// ─── ffmpeg/ffprobe 全局并发信号量（跨 6 类 media worker 共享）────────────────
// 目标：媒体归一化（probe/thumbnail/proxy/waveform/stitch/frame_extract）里的
// ffmpeg/ffprobe 子进程是 CPU 密集，必须在全局上限内排队，避免批量生成时
// 6 类 worker 背靠背 spawn 打满 2 核、饿死 HTTP/SSE（"卡前后台"根因之一）。
// 上限由 settings.app.ffmpegConcurrency 控制（默认 2），启动时 setMax，可热改。

let max = 2;
let active = 0;
const waiters = [];

function setMax(n) {
  const next = Math.max(1, Number(n) || 2);
  max = next;
  // 上限调大后放行等位者（上限调小不打断 in-flight，自然收缩）
  while (active < max && waiters.length > 0) {
    const wake = waiters.shift();
    if (wake) wake();
  }
}

function getMax() { return max; }
function getActive() { return active; }

async function acquire() {
  if (active < max) { active += 1; return; }
  await new Promise((resolve) => waiters.push(resolve));
  active += 1;
}

function release() {
  active = Math.max(0, active - 1);
  const wake = waiters.shift();
  if (wake) wake();
}

module.exports = { setMax, getMax, getActive, acquire, release };
