'use strict';
/**
 * M05-D1 — Studio executor registry.
 *
 * Production M05-D1 registers ONLY deterministic executors (source/asset
 * resolution + output collector). Generation nodes (image-generation,
 * image-to-video, text-to-video) have NO production executor — resolve()
 * returns an explicit EXECUTOR_NOT_AVAILABLE result so the run engine can
 * park them for the M05-E Generation V2 bridge.
 *
 * Test-only deterministic fake executors exist in studioRunTestExecutors.cjs
 * and are wired exclusively through an explicit `executors` injection
 * parameter — they can never be activated by production environment state.
 */
const { NODE_REGISTRY } = require('./studioNodeRegistry.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function upstreamResult(ctx, depNodeId) {
  const r = (ctx.upstreamResults || {})[depNodeId];
  if (!isPlainObject(r)) return null;
  return r.result && isPlainObject(r.result) ? r.result : null;
}

function hasValue(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * Deterministic production executor for SOURCE / ASSET / OUTPUT nodes.
 * Resolves synchronously from the immutable compiled input; it never calls
 * providers and never fabricates media.
 */
function makeDeterministicExecutor(def, ctx) {
  return {
    kind: 'deterministic',
    async execute() {
      const params = ctx.input.parameters || {};
      const result = { nodeType: def.id, executionKind: def.executionKind };

      if (def.executionKind === 'SOURCE') {
        if (def.id === 'prompt') result.text = typeof params.prompt === 'string' ? params.prompt : (ctx.input.prompt || '');
        if (def.id === 'script') {
          result.text = typeof params.scriptText === 'string' ? params.scriptText : (params.prompt || '');
          result.script = result.text;
          if (typeof params.title === 'string') result.title = params.title;
        }
        if (def.id === 'character') {
          result.name = typeof params.name === 'string' ? params.name : '';
          result.character = { name: result.name, description: typeof params.description === 'string' ? params.description : '' };
          if (typeof params.assetId === 'string' && params.assetId) result.assetId = params.assetId;
        }
        if (!hasValue(result.text) && !hasValue(result.character) && def.id !== 'character') {
          throw Object.assign(new Error('SOURCE_EMPTY'), { code: 'SOURCE_EMPTY' });
        }
        if (def.id === 'character' && !hasValue(result.name)) throw Object.assign(new Error('SOURCE_EMPTY'), { code: 'SOURCE_EMPTY' });
      } else if (def.executionKind === 'ASSET') {
        const assetId = typeof params.assetId === 'string' ? params.assetId : (typeof ctx.input.assetId === 'string' ? ctx.input.assetId : '');
        if (!assetId) throw Object.assign(new Error('ASSET_MISSING'), { code: 'ASSET_MISSING' });
        result.assetId = assetId;
        if (def.id === 'reference') {
          result.reference = { assetId, role: typeof params.referenceRole === 'string' ? params.referenceRole : 'visual', weight: Number(params.weight) || null };
          result.imageAssetId = assetId; // IMAGE-compatible output (durable ref, never a URL)
        }
        if (def.id === 'video') result.videoAssetId = assetId;
      } else if (def.executionKind === 'OUTPUT') {
        // Boundary/collector: gather resolved upstream durable references.
        const collected = { upstream: {} };
        for (const depId of ctx.dependencies) {
          const up = upstreamResult(ctx, depId);
          if (!up) continue;
          const entry = {};
          for (const k of ['text', 'script', 'assetId', 'imageAssetId', 'videoAssetId', 'name']) {
            if (up[k] !== undefined) entry[k] = up[k];
          }
          if (Object.keys(entry).length) collected.upstream[depId] = entry;
        }
        result.collected = collected;
      }

      return { ok: true, result };
    },
  };
}

/**
 * Resolve the production executor for a node.
 * @returns {{ok:true, executor} | {ok:false, code:string, message:string}}
 */
function resolveProductionExecutor(node, ctx) {
  const def = NODE_REGISTRY[node.nodeType];
  if (!def) return { ok: false, code: 'UNKNOWN_NODE_TYPE', message: `unknown node type: ${node.nodeType}` };
  if (def.executionKind === 'STRUCTURAL') return { ok: false, code: 'STRUCTURAL_NODE', message: 'structural nodes are not executed' };
  if (def.executorClass === 'generation-bridge-pending') {
    // M05-E bridge boundary: explicit, durable, no fabricated media.
    return { ok: false, code: 'EXECUTOR_NOT_AVAILABLE', message: 'generation executor pending M05-E bridge' };
  }
  if (!def.executorClass) return { ok: false, code: 'EXECUTOR_NOT_AVAILABLE', message: 'no executor registered' };
  return { ok: true, executor: makeDeterministicExecutor(def, ctx) };
}

/**
 * createStudioExecutorRegistry(opts)
 * opts.executors — OPTIONAL test-only injection map nodeId|nodeType -> executor factory.
 *   Production never passes this; the run engine asserts the injection flag.
 */
function createStudioExecutorRegistry(opts = {}) {
  const injected = isPlainObject(opts.executors) ? opts.executors : null;
  const testOnly = injected !== null;

  async function resolveExecutor(node, ctx) {
    if (injected) {
      const byId = injected[node.nodeId];
      const byType = injected[node.nodeType];
      const factory = byId || byType;
      if (factory) {
        const ex = typeof factory === 'function' ? await factory(node, ctx) : factory;
        return { ok: true, executor: ex, injected: true };
      }
    }
    return resolveProductionExecutor(node, ctx);
  }

  return { resolveExecutor, isTestOnly: testOnly };
}

module.exports = { createStudioExecutorRegistry, resolveProductionExecutor, makeDeterministicExecutor, sleep };
