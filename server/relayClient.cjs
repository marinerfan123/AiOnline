'use strict';

const crypto = require('node:crypto');

class RelayClientError extends Error {
  constructor(message, { status = 502, code = 'relay_error', retryable = false } = {}) {
    super(message);
    this.name = 'RelayClientError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function isRelayConfigured(env = process.env) {
  return Boolean(String(env.MODEL_RELAY_BASE_URL || '').trim())
    && Boolean(String(env.MODEL_RELAY_INTERNAL_TOKEN || '').trim())
    && Boolean(String(env.MODEL_RELAY_USER_SIGNING_KEY || '').trim());
}

function isRelayEnabled(env = process.env) {
  return env.MODEL_RELAY_ENABLED === 'true' && isRelayConfigured(env);
}

function signUserId(userId, signingKey) {
  return crypto.createHmac('sha256', signingKey).update(String(userId)).digest('hex');
}

function parseResponseBody(text) {
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

function sanitizeGenerationRequest(input) {
  const request = input && typeof input === 'object' ? input : {};
  const allowed = [
    'modelId', 'model', 'prompt', 'ratio', 'resolution', 'quality', 'count',
    'contentType', 'referenceImages', 'negative', 'duration', 'videoMode',
    'idempotencyKey', 'billingReference',
  ];
  return Object.fromEntries(allowed.filter((key) => request[key] !== undefined).map((key) => [key, request[key]]));
}

function relayErrorFromResponse(status, body) {
  const source = body && typeof body === 'object' ? body : {};
  const code = String(source.error || (status >= 500 ? 'relay_upstream_error' : 'relay_request_rejected'));
  const retryable = status === 502 || status === 503;
  const message = retryable ? '中转服务暂时不可用' : String(source.message || source.error || `中转请求失败（HTTP ${status}）`).slice(0, 200);
  return new RelayClientError(message, { status, code, retryable });
}

function createRelayClient({ env = process.env, fetchImpl = globalThis.fetch, logger = console, timeoutMs } = {}) {
  const baseUrl = String(env.MODEL_RELAY_BASE_URL || '').replace(/\/+$/, '');
  const internalToken = String(env.MODEL_RELAY_INTERNAL_TOKEN || '');
  const signingKey = String(env.MODEL_RELAY_USER_SIGNING_KEY || '');
  const configured = Boolean(baseUrl && internalToken && signingKey);
  const requestTimeoutMs = Number(timeoutMs || env.MODEL_RELAY_TIMEOUT_MS || 10000);
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

  async function request(pathname, { method = 'GET', userId, body, signal } = {}) {
    if (!configured) {
      throw new RelayClientError('中转服务未配置', { status: 503, code: 'relay_not_configured' });
    }
    if (!userId) throw new RelayClientError('用户身份缺失', { status: 401, code: 'unauthorized' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${internalToken}`,
      'x-user-id': String(userId),
      'x-user-signature': signUserId(userId, signingKey),
    };
    const options = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    try {
      let response;
      let lastError;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetchImpl(`${baseUrl}${pathname}`, options);
          if (response.ok || ![502, 503].includes(response.status) || attempt === 1) break;
        } catch (error) {
          lastError = error;
          if (attempt === 1 || controller.signal.aborted) break;
          continue;
        }
      }
      if (!response) {
        throw new RelayClientError('中转服务连接失败', { status: 502, code: 'relay_network_error', retryable: true });
      }
      const payload = parseResponseBody(await response.text());
      if (!response.ok) throw relayErrorFromResponse(response.status, payload);
      return payload;
    } catch (error) {
      if (error instanceof RelayClientError) throw error;
      if (error?.name === 'AbortError') {
        throw new RelayClientError('中转服务请求超时', { status: 504, code: 'relay_timeout', retryable: true });
      }
      logger.warn?.('[relay-client] request failed', { path: pathname, code: 'relay_network_error' });
      throw new RelayClientError('中转服务连接失败', { status: 502, code: 'relay_network_error', retryable: true });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  return {
    isConfigured: () => configured,
    createGeneration: ({ userId, request: generationRequest }) => requestApi('/v1/generations', { method: 'POST', userId, body: sanitizeGenerationRequest(generationRequest) }),
    getTask: ({ userId, taskId }) => requestApi(`/v1/tasks/${encodeURIComponent(taskId)}`, { userId }),
    cancelTask: ({ userId, taskId }) => requestApi(`/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', userId, body: {} }),
    listModels: ({ userId }) => requestApi('/v1/models', { userId }),
    request: requestApi,
  };

  function requestApi(pathname, options) {
    return request(pathname, options);
  }
}

module.exports = { RelayClientError, createRelayClient, isRelayConfigured, isRelayEnabled, signUserId, sanitizeGenerationRequest };
