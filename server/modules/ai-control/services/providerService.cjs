'use strict';
/**
 * M02-B — Provider + Key Pool service (management boundary)
 *
 * 管理面 mutation 层：provider CRUD + key pool 生命周期。
 * 铁律：
 *  - 完整 secret 只出现在 WRITE 边界（addKey / createProvider 的入参），
 *    任何 READ 投影都经 keypool 脱敏（masked + fingerprint），绝不回读完整 key。
 *  - credential authority：api_keys（pool）优先；providers.api_key 仅作为
 *    显式 LEGACY_FALLBACK（B5），不删除、不隐藏，但要让 UI 能看见当前生效来源。
 *  - 每次 key pool 变更通过注入的 onPoolChanged(providerId) 同步 dispatcher
 *    运行时 key 池（syncKeyPool），与 legacy 路由行为一致；测试可注入 spy。
 *  - 乐观锁：provider 更新沿用 revision（与 legacy PATCH /api/providers 一致）。
 */

const crypto = require('node:crypto');
const keypool = require('../domain/keypool.cjs');
const { validateBinding } = require('../domain/binding.cjs');

const PLACEHOLDER_RE = /[*<>/]/; // 与 legacy 路由的占位密钥判定一致（含 '*' 等）

function isPlaceholderSecret(s) {
  const str = String(s ?? '');
  return !str || PLACEHOLDER_RE.test(str) || str.length < 6;
}

/**
 * 生效 credential 来源分类（B5）。
 * POOL              — api_keys 池中有 ≥1 把 active 且非占位的 key（runtime 走池内轮转）
 * LEGACY_FALLBACK   — 池为空/全不可用，但 providers.api_key 存在（runtime 回退列）
 * NONE              — 两者皆无（该 provider 当前无法出站）
 * @param {object} provider  { api_key?: string, key_pool?: object[] }（key_pool 为脱敏元数据）
 * @returns {{source:'POOL'|'LEGACY_FALLBACK'|'NONE', pool_count:number, eligible_count:number, has_legacy_key:boolean}}
 */
function classifyCredentialSource(provider) {
  const pool = Array.isArray(provider && provider.key_pool) ? provider.key_pool : [];
  const eligible = pool.filter((k) => k && k.enabled).length;
  const hasLegacy = !!(provider && provider.credential && provider.credential.has_legacy_key);
  let source = 'NONE';
  if (eligible > 0) source = 'POOL';
  else if (hasLegacy) source = 'LEGACY_FALLBACK';
  return { source, pool_count: pool.length, eligible_count: eligible, has_legacy_key: hasLegacy };
}

/**
 * 创建 provider。
 * @param {object} pg
 * @param {object} input { id, name, baseUrl, protocol?, enabled?, supportedTypes?, remark? }
 * @param {string|null} [apiKey]  完整 secret（仅 write 边界；占位串落空，与 legacy 一致）
 * @param {string} [actor]
 * @returns {object} masked provider view（credential 只出 masked）
 */
async function createProvider(pg, input, apiKey = '', actor = '') {
  if (!input || !input.id) throw httpError(400, '缺少 id');
  if (!input.name) throw httpError(400, '缺少 name');
  const id = String(input.id);
  const exists = await pg.query('SELECT id FROM providers WHERE id=$1', [id]);
  if (exists.rows[0]) throw httpError(409, '服务商已存在', { id });
  const secret = isPlaceholderSecret(apiKey) ? '' : String(apiKey);
  await pg.query(
    `INSERT INTO providers (id,name,type,base_url,api_key,supported_types,enabled,protocol,remark,revision,updated_at,updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,NOW(),$10)`,
    [
      id, String(input.name), input.type || 'official', input.baseUrl || '', secret,
      Array.isArray(input.supportedTypes) ? input.supportedTypes : (input.supportedTypes ? [input.supportedTypes] : []),
      input.enabled !== false, input.protocol || 'openai-compatible', input.remark || '', actor || '',
    ],
  );
  const view = await getProviderView(pg, id);
  return { ok: true, provider: view, revision: 1 };
}

/**
 * 更新 provider（乐观锁；apiKey 占位保护与 legacy 一致：传占位 → 沿用现值）。
 */
async function updateProvider(pg, id, patch, actor = '') {
  const expectedRevision = Number(patch && patch.revision);
  if (!Number.isInteger(expectedRevision)) throw httpError(400, '缺少或非整数 revision（乐观锁基线）');
  const allowed = {
    name: (v) => String(v || ''),
    baseUrl: (v) => String(v || ''),
    protocol: (v) => String(v || 'openai-compatible'),
    remark: (v) => String(v || ''),
    enabled: (v) => v !== false,
    type: (v) => String(v || 'official'),
  };
  const cols = []; const vals = [];
  for (const [col, conv] of Object.entries(allowed)) {
    if (!(col in (patch || {}))) continue;
    cols.push(col === 'baseUrl' ? 'base_url' : col);
    vals.push(conv(patch[col]));
  }
  if ('apiKey' in (patch || {})) {
    const ak = patch.apiKey || '';
    if (!isPlaceholderSecret(ak)) { cols.push('api_key'); vals.push(String(ak)); }
    // 占位 → 沿用 DB 现值（与 legacy 一致；GENERATED 无关列，直接跳过即可保留）
  }
  if (!cols.length) throw httpError(400, '无可更新字段');
  const n = cols.length;
  const setClause = cols.map((c, i) => `${c}=$${i + 1}`).join(', ');
  const r = await pg.query(
    `UPDATE providers SET ${setClause}, revision=revision+1, updated_at=NOW(), updated_by=$${n + 3}
      WHERE id=$${n + 1} AND revision=$${n + 2} RETURNING revision`,
    [...vals, id, expectedRevision, actor || ''],
  );
  if (!r.rowCount) {
    const cur = await pg.query('SELECT revision FROM providers WHERE id=$1', [id]);
    if (!cur.rows[0]) throw httpError(404, '服务商不存在');
    throw httpError(409, '数据已被其他管理员修改（revision 不匹配）', { currentRevision: cur.rows[0].revision });
  }
  const view = await getProviderView(pg, id);
  return { ok: true, provider: view, revision: r.rows[0].revision };
}

/** 启用/禁用（便捷 mutation；内部走乐观锁）。 */
async function setProviderEnabled(pg, id, enabled, currentRevision) {
  return updateProvider(pg, id, { enabled: enabled !== false, revision: currentRevision });
}

/**
 * 读取 provider 的脱敏视图（含 key pool 元数据 + credential 来源分类 + 汇总）。
 * 与 legacy GET /api/providers 的数据口径对齐，但字段命名与 M02 契约一致，
 * 且绝不返回完整 secret。
 */
async function getProviderView(pg, id) {
  const r = await pg.query('SELECT * FROM providers WHERE id=$1', [id]);
  const row = r.rows && r.rows[0];
  if (!row) return null;
  const { api_key, ...rest } = row;
  const view = {
    ...rest,
    credential: {
      has_legacy_key: !isPlaceholderSecret(api_key),
      masked_legacy_key: keypool.maskKey(api_key),
    },
    key_pool: null,
  };
  const kr = await pg.query(
    `SELECT id, provider_id, api_key, label, status, weight, rpm, concurrency, health, cooldown_until, last_used_at, last_error_code, created_at, updated_at
       FROM api_keys WHERE provider_id=$1 ORDER BY created_at`,
    [id],
  );
  view.key_pool = (kr.rows || []).map((row2) => keypool.keyMetadata(row2));
  view.key_pool_count = view.key_pool.length;
  view.active_key_count = view.key_pool.filter((k) => k.enabled).length;
  view.credential_source = classifyCredentialSource(view);
  // 绑定/模型汇总（B1: provider binding summary）
  const br = await pg.query(
    `SELECT b.id, b.model_id, b.upstream_model_name, b.enabled, b.priority, b.weight, m.display_name
       FROM provider_model_bindings b LEFT JOIN models m ON m.model_id=b.model_id AND m.provider_id=b.provider_id AND m.enabled=true
      WHERE b.provider_id=$1 ORDER BY b.priority DESC, b.weight DESC`,
    [id],
  );
  view.bindings = (br.rows || []).map((x) => ({
    binding_id: x.id, model_id: x.model_id, model_name: x.display_name || null,
    provider_model_code: x.upstream_model_name, enabled: x.enabled !== false,
    priority: x.priority, weight: x.weight,
  }));
  const mr = await pg.query('SELECT model_id, display_name, type, enabled FROM models WHERE provider_id=$1 AND enabled=true ORDER BY created_at', [id]);
  view.models = mr.rows || [];
  return view;
}

async function listProviderViews(pg, { q, enabled } = {}) {
  const r = await pg.query(
    'SELECT id FROM providers ORDER BY created_at',
  );
  const views = [];
  for (const row of r.rows || []) {
    const v = await getProviderView(pg, row.id);
    if (!v) continue;
    if (enabled !== undefined && enabled !== '' && (v.enabled === true) !== (enabled === true || enabled === 'true')) continue;
    if (q) {
      const needle = String(q).toLowerCase();
      const hay = `${v.name} ${v.id} ${v.protocol}`.toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    views.push(v);
  }
  return views;
}

/**
 * 添加 key（单个）。去重：UNIQUE(provider_id, api_key) → 已存在则 skip（不报错）。
 * 返回的 view 为脱敏元数据。完整 secret 只在此 write 边界出现一次。
 */
async function addKey(pg, providerId, { apiKey, label = '', weight = 100 } = {}, { onPoolChanged } = {}) {
  if (!apiKey || isPlaceholderSecret(apiKey)) throw httpError(400, '无效的 key（至少6位，不可为占位符）');
  const p = await pg.query('SELECT id FROM providers WHERE id=$1', [providerId]);
  if (!p.rows[0]) throw httpError(404, '服务商不存在');
  const keyId = crypto.randomUUID();
  const r = await pg.query(
    `INSERT INTO api_keys (id, provider_id, api_key, label, status, weight, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'active',$5,NOW(),NOW())
     ON CONFLICT (provider_id, api_key) DO NOTHING RETURNING id`,
    [keyId, providerId, String(apiKey).trim(), label, Number.isFinite(weight) ? weight : 100],
  );
  if (!r.rowCount) {
    // 已存在（dedupe）→ 返回现有行的脱敏视图
    const ex = await pg.query('SELECT id, provider_id, api_key, label, status, weight FROM api_keys WHERE provider_id=$1 AND api_key=$2', [providerId, String(apiKey).trim()]);
    const meta = keypool.keyMetadata(ex.rows[0]);
    await syncPool(pg, providerId, onPoolChanged);
    return { ok: true, added: false, duplicate: true, key: meta };
  }
  await syncPool(pg, providerId, onPoolChanged);
  const ex = await pg.query('SELECT id, provider_id, api_key, label, status, weight, rpm, concurrency, health, cooldown_until, last_used_at, last_error_code, created_at, updated_at FROM api_keys WHERE id=$1', [keyId]);
  return { ok: true, added: true, duplicate: false, key: keypool.keyMetadata(ex.rows[0]) };
}

/**
 * 批量添加（B2）。接受 string[] 或换行分隔文本；逐条去重，正确统计 added/skipped。
 * 修复 legacy 路由的计数缺陷（ON CONFLICT DO NOTHING 时误计 added）。
 */
async function addKeysBatch(pg, providerId, keys, { onPoolChanged } = {}) {
  const lines = Array.isArray(keys)
    ? keys.map((k) => String(k ?? '').trim())
    : String(keys ?? '').split(/\r?\n/).map((s) => s.trim());
  const valid = [...new Set(lines.filter((s) => s && s.length >= 6))];
  if (!valid.length) throw httpError(400, '没有有效的 key（每把至少6位）');
  let added = 0; let skipped = 0;
  const results = [];
  for (const k of valid) {
    const r = await addKey(pg, providerId, { apiKey: k }, { onPoolChanged });
    if (r.added) added++; else skipped++;
    results.push(r.key);
  }
  // 只同步一次池（addKey 内已逐次同步，最后一次为准）
  const total = await poolCount(pg, providerId);
  return { ok: true, added, skipped, total, keys: results };
}

/** 更新 key 元数据（label/status/weight/rpm/concurrency）。weight 等 0010 列可能为 NULL。 */
async function updateKeyMetadata(pg, providerId, keyId, patch = {}, { onPoolChanged } = {}) {
  const allowed = {
    label: (v) => String(v || ''),
    status: (v) => (v === 'disabled' ? 'disabled' : 'active'),
    weight: (v) => Math.max(0, Math.floor(Number(v) || 0)),
    rpm: (v) => (v == null || v === '' ? null : Math.max(1, Math.floor(Number(v)))),
    concurrency: (v) => (v == null || v === '' ? null : Math.max(1, Math.floor(Number(v)))),
  };
  const cols = []; const vals = [];
  for (const [col, conv] of Object.entries(allowed)) {
    if (!(col in patch)) continue;
    cols.push(col); vals.push(conv(patch[col]));
  }
  if (!cols.length) throw httpError(400, '无可更新字段');
  const n = cols.length;
  const setClause = cols.map((c, i) => `${c}=$${i + 1}`).join(', ');
  const r = await pg.query(
    `UPDATE api_keys SET ${setClause}, updated_at=NOW() WHERE id=$${n + 1} AND provider_id=$${n + 2} RETURNING id`,
    [...vals, keyId, providerId],
  );
  if (!r.rowCount) throw httpError(404, 'key 不存在');
  await syncPool(pg, providerId, onPoolChanged);
  const ex = await pg.query(
    'SELECT id, provider_id, api_key, label, status, weight, rpm, concurrency, health, cooldown_until, last_used_at, last_error_code, created_at, updated_at FROM api_keys WHERE id=$1',
    [keyId],
  );
  return { ok: true, key: keypool.keyMetadata(ex.rows[0]) };
}

/** 删除 key。 */
async function deleteKey(pg, providerId, keyId, { onPoolChanged } = {}) {
  const r = await pg.query('DELETE FROM api_keys WHERE id=$1 AND provider_id=$2 RETURNING id', [keyId, providerId]);
  if (!r.rowCount) throw httpError(404, 'key 不存在');
  await syncPool(pg, providerId, onPoolChanged);
  return { ok: true, deleted: keyId };
}

/** 冷却某 key（B2 cooldown 控制面）。cooldownMs<=0 清除冷却。 */
async function setKeyCooldown(pg, providerId, keyId, cooldownMs, { onPoolChanged } = {}) {
  const ms = Math.max(0, Math.floor(Number(cooldownMs) || 0));
  const until = ms > 0 ? new Date(Date.now() + ms).toISOString() : null;
  const r = await pg.query(
    `UPDATE api_keys SET cooldown_until=$1, updated_at=NOW() WHERE id=$2 AND provider_id=$3 RETURNING id`,
    [until, keyId, providerId],
  );
  if (!r.rowCount) throw httpError(404, 'key 不存在');
  await syncPool(pg, providerId, onPoolChanged);
  return { ok: true, key_id: keyId, cooldown_until: until };
}

async function poolCount(pg, providerId) {
  const r = await pg.query('SELECT COUNT(*) c FROM api_keys WHERE provider_id=$1', [providerId]);
  return Number(r.rows[0].c);
}

/**
 * 与 legacy 路由一致的池同步：读 DB 全量 key 行 → onPoolChanged(providerId, rows)。
 * 生产注入 dispatcher.syncKeyPool；测试注入 spy。rows 含 api_key（server-side only，
 * 仅供 dispatcher 运行时使用，绝不进 response）。
 */
async function syncPool(pg, providerId, onPoolChanged) {
  if (typeof onPoolChanged !== 'function') return;
  const keys = await pg.query('SELECT id, provider_id, api_key, label, status, weight FROM api_keys WHERE provider_id=$1', [providerId]);
  await onPoolChanged(providerId, keys.rows || []);
}

function httpError(status, message, extra = {}) {
  const e = new Error(message);
  e.status = status;
  Object.assign(e, extra);
  return e;
}

module.exports = {
  classifyCredentialSource,
  createProvider, updateProvider, setProviderEnabled,
  getProviderView, listProviderViews,
  addKey, addKeysBatch, updateKeyMetadata, deleteKey, setKeyCooldown,
  isPlaceholderSecret,
  validateBinding,
};
