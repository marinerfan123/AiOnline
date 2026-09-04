'use strict';
/**
 * M02-A AI Control Plane — Agnes Provider Adapter (compatibility proof)
 *
 * 把已认证的 Agnes 视频运行逻辑（server/providers/video/agnes.cjs）适配到 M02
 * Provider Adapter Contract。这是 M02 的【第一个 adapter compatibility proof】：
 *   - normalizeInput 复用 agnes.cjs 的 buildAgnesVars（同一输入 → 同一 wire body，测试断言等价）
 *   - submit/poll 走可注入 transport（测试 = fake upstream，零付费；生产 = 真实 HTTP）
 *   - normalizeStatus/normalizeError/normalizeResult 用 M02 域（status/error 封闭枚举）
 *
 * credential 不在 adapter 内选择/持有 —— 由 key pool 选定后注入（保持 credential authority）。
 */

const { buildAgnesVars, resolveAgnesEndpoint } = require('../../../providers/video/agnes.cjs');
const { normalizeStatus, isTerminal } = require('../domain/status.cjs');
const { maskKey } = require('../domain/keypool.cjs');

const AGNES_STATUS_MAP = {
  // agnes 原始态 → 标准态（domain/status 默认表之外的 provider 特化覆盖）
  queued: 'QUEUED',
  inqueue: 'QUEUED',
  submitted: 'SUBMITTED',
  in_progress: 'PROCESSING',
  completed: 'SUCCEEDED',
  failed: 'FAILED',
  error: 'FAILED',
  expired: 'FAILED',
  canceled: 'CANCELLED',
  cancelled: 'CANCELLED',
};

function createAgnesAdapter(deps = {}) {
  // transport：{ submit(body, headers)→{status,body}, poll(query,headers)→{status,body} }
  // 默认 null → submit/poll 抛「无 transport」，强制测试注入 fake / 生产注入真实。
  const transport = deps.transport || null;

  return {
    name: 'agnes',

    validate(providerConfig, logicalModel, input) {
      const errors = [];
      if (!providerConfig || !providerConfig.base_url && !logicalModel) errors.push('缺 provider 配置');
      if (!input || typeof input.prompt !== 'string' || !input.prompt) errors.push('缺 prompt');
      if (input.referenceImages != null && !Array.isArray(input.referenceImages)) errors.push('referenceImages 必须是数组');
      return errors.length ? { ok: false, errors } : { ok: true };
    },

    // 纯：logical model + 用户参数 → agnes wire body（复用已认证 buildAgnesVars）
    normalizeInput(logicalModel, input, params = {}) {
      const model = { ...logicalModel };
      // buildAgnesVars 依赖 model.upstreamModelName / model.model_id
      if (params.upstreamModelName) model.upstreamModelName = params.upstreamModelName;
      return buildAgnesVars({
        prompt: input.prompt,
        ratio: input.ratio || params.ratio,
        durationSec: input.durationSec != null ? input.durationSec : params.durationSec,
        referenceImages: input.referenceImages,
        negative: input.negative,
        resolution: input.resolution || params.resolution,
      }, model);
    },

    estimateProviderCost() {
      // 成本估算钩子：Agnes 按 asset 计，真实成本逐线路在 provider_model_costs。
      // adapter 不持有成本数据 → 返回 null，由 repository 用逐线路成本填充。
      return null;
    },

    // 端点解析（复用 agnes.cjs，开箱即用）
    resolveEndpoint(provider, logicalModel) {
      return resolveAgnesEndpoint(provider, logicalModel);
    },

    async submit({ credential, provider, logicalModel, input, params }) {
      if (!transport) throw new Error('agnes adapter: 未注入 transport');
      if (!credential) return { status: 'error', error: '缺少 credential（key pool 未选定）' };
      const body = this.normalizeInput(logicalModel, input, params);
      const { submitEp } = this.resolveEndpoint(provider, logicalModel);
      const res = await transport.submit(body, { credential, submitEp, provider, logicalModel });
      if (res && res.status >= 400) {
        return this.normalizeError(res.body, res.status);
      }
      const taskId = String((res && res.body && (res.body.video_id ?? res.body.id)) ?? '').trim();
      if (!taskId) return { status: 'error', error: '未返回任务 ID' };
      return { status: 'SUBMITTED', taskId, providerTaskId: taskId };
    },

    async poll({ credential, provider, logicalModel, taskId }) {
      if (!transport) throw new Error('agnes adapter: 未注入 transport');
      const { pollEp } = this.resolveEndpoint(provider, logicalModel);
      const res = await transport.poll({ video_id: taskId }, { credential, pollEp, provider, logicalModel });
      const raw = String((res && res.body && res.body.status) ?? '').toLowerCase();
      const state = normalizeStatus(raw, AGNES_STATUS_MAP);
      if (state === 'SUCCEEDED') {
        const url = (res && res.body && (res.body.metadata?.url ?? res.body.url)) || '';
        return this.normalizeResult(url, raw);
      }
      if (state === 'FAILED' || state === 'CANCELLED') {
        return { ...this.normalizeError(res && res.body, res && res.status, raw), state };
      }
      return { status: state, provider_status_raw: raw, taskId };
    },

    async cancel({ credential, provider, logicalModel, taskId }) {
      // Agnes 当前无 cancel API（与 agnes.cjs 一致：不支持即 not_supported，不臆断成功）。
      return { status: 'not_supported', taskId };
    },

    normalizeStatus(raw) {
      return normalizeStatus(raw, AGNES_STATUS_MAP);
    },

    // 不泄漏 secret / stack；映射为安全错误码。
    normalizeError(body, httpStatus, rawStatus) {
      const status = typeof httpStatus === 'number' ? httpStatus : 0;
      let code = 'PROVIDER_ERROR';
      let retryable = false;
      if (status === 401 || status === 403) { code = 'CREDENTIAL_INVALID'; retryable = false; }
      else if (status === 429) { code = 'RATE_LIMITED'; retryable = true; }
      else if (status >= 500) { code = 'UPSTREAM_ERROR'; retryable = true; }
      else if (status === 0) { code = 'NETWORK'; retryable = true; }
      const msg = safeErrorText(body);
      return { status: 'FAILED', code, message: msg, retryable, http_status: status || null, provider_status_raw: rawStatus ?? null };
    },

    normalizeResult(url, rawStatus) {
      return {
        status: 'SUCCEEDED',
        url: url || '',
        provider_status_raw: rawStatus ?? null,
      };
    },
  };
}

function safeErrorText(body) {
  try {
    if (!body) return 'provider error';
    if (typeof body === 'string') return body.slice(0, 160);
    const s = body.error?.message || body.message || body.error || JSON.stringify(body);
    return String(s).slice(0, 160);
  } catch {
    return 'provider error';
  }
}

module.exports = { createAgnesAdapter, AGNES_STATUS_MAP };
