'use strict';
/**
 * Provider Certification — 词表 / 状态机 / listCertified 单测。
 * 运行：node --test server/modules/modelhub/provider-cert.test.cjs
 *
 * 不依赖真实 PG：状态机/词表为纯函数；listCertified 用 fake pool 验证
 * cert_status='certified' 过滤 + modelCode 精确过滤 + fidelityAtLeast 偏序过滤。
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  CERT_STATUSES,
  FIDELITY_CLASSES,
  FIDELITY_RANK,
  isValidCertStatus,
  isValidFidelityClass,
  assertCertStatus,
  assertFidelityClass,
  assertTransition,
  rankFidelity,
  listCertified,
} = require('./provider-cert.cjs');

// ── 词表 ──────────────────────────────────────────────────────────────
test('cert_status 词表 = uncertified/certified/revoked（三态）', () => {
  assert.deepStrictEqual(CERT_STATUSES, ['uncertified', 'certified', 'revoked']);
});

test('fidelity_class 词表 = EXACT/COMPATIBLE/SIMILAR/UNKNOWN（§19）', () => {
  assert.deepStrictEqual(FIDELITY_CLASSES, ['EXACT', 'COMPATIBLE', 'SIMILAR', 'UNKNOWN']);
});

test('isValidCertStatus / isValidFidelityClass：合法值通过、非法值拒绝', () => {
  for (const s of CERT_STATUSES) assert.strictEqual(isValidCertStatus(s), true, s);
  for (const f of FIDELITY_CLASSES) assert.strictEqual(isValidFidelityClass(f), true, f);
  assert.strictEqual(isValidCertStatus('CERTIFIED'), false);       // 大小写敏感
  assert.strictEqual(isValidCertStatus('VERIFIED'), false);        // §19 富词表非本表词表
  assert.strictEqual(isValidCertStatus('bogus'), false);
  assert.strictEqual(isValidFidelityClass('exact'), false);
  assert.strictEqual(isValidFidelityClass('VERIFIED'), false);
});

test('assertCertStatus / assertFidelityClass：非法值返回错误信封', () => {
  assert.deepStrictEqual(assertCertStatus('certified'), { ok: true, errors: [] });
  const e = assertCertStatus('drifted');
  assert.strictEqual(e.ok, false);
  assert.ok(e.errors[0].includes('drifted'));
  const f = assertFidelityClass('PARTIAL');
  assert.strictEqual(f.ok, false);
  assert.ok(f.errors[0].includes('PARTIAL'));
});

// ── 状态机 ────────────────────────────────────────────────────────────
test('状态机：uncertified → certified 合法（certify）', () => {
  assert.deepStrictEqual(assertTransition('uncertified', 'certified'), { ok: true, errors: [] });
});

test('状态机：certified → revoked 合法（revoke）', () => {
  assert.deepStrictEqual(assertTransition('certified', 'revoked'), { ok: true, errors: [] });
});

test('状态机：revoked 是终态，无任何出边', () => {
  for (const to of CERT_STATUSES) {
    const r = assertTransition('revoked', to);
    assert.strictEqual(r.ok, false, `revoked -> ${to} 应被拒绝`);
  }
});

test('状态机：跳态/自环/回退均非法', () => {
  assert.strictEqual(assertTransition('uncertified', 'revoked').ok, false); // 跳态
  assert.strictEqual(assertTransition('uncertified', 'uncertified').ok, false); // 自环
  assert.strictEqual(assertTransition('certified', 'certified').ok, false); // 自环
  assert.strictEqual(assertTransition('certified', 'uncertified').ok, false); // 回退
});

test('状态机：非法词表值被拒绝并给出错误信息', () => {
  const r = assertTransition('bogus', 'certified');
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('bogus')));
  const r2 = assertTransition('uncertified', 'VERIFIED');
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.includes('VERIFIED')));
});

// ── fidelity 偏序 ─────────────────────────────────────────────────────
test('rankFidelity：EXACT > COMPATIBLE > SIMILAR > UNKNOWN，非法为 null', () => {
  assert.strictEqual(rankFidelity('EXACT'), 3);
  assert.strictEqual(rankFidelity('COMPATIBLE'), 2);
  assert.strictEqual(rankFidelity('SIMILAR'), 1);
  assert.strictEqual(rankFidelity('UNKNOWN'), 0);
  assert.strictEqual(rankFidelity('bogus'), null);
  assert.strictEqual(FIDELITY_RANK.EXACT, 3);
});

// ── listCertified ─────────────────────────────────────────────────────
// fake pool 忠实模拟 SQL 的 WHERE cert_status='certified' 与可选 model_code=$1。
function makePool({ rows = [] } = {}) {
  return {
    lastSql: '',
    lastParams: [],
    async query(text, params = []) {
      this.lastSql = text;
      this.lastParams = params;
      let out = rows.filter((r) => r.cert_status === 'certified');
      if (params.length && typeof params[0] === 'string' && params[0] !== '') {
        out = out.filter((r) => r.model_code === params[0]);
      }
      return { rows: out };
    },
  };
}

const CERT_ROWS = [
  { cert_id: 'c1', provider_id: 'p1', model_code: 'veo3.1', fidelity_class: 'EXACT', cert_status: 'certified' },
  { cert_id: 'c2', provider_id: 'p2', model_code: 'veo3.1', fidelity_class: 'COMPATIBLE', cert_status: 'certified' },
  { cert_id: 'c3', provider_id: 'p3', model_code: 'veo3.1', fidelity_class: 'SIMILAR', cert_status: 'certified' },
  { cert_id: 'c4', provider_id: 'p4', model_code: 'veo3.1', fidelity_class: 'UNKNOWN', cert_status: 'certified' },
  { cert_id: 'c5', provider_id: 'p5', model_code: 'seedance', fidelity_class: 'EXACT', cert_status: 'certified' },
  { cert_id: 'c6', provider_id: 'p6', model_code: 'veo3.1', fidelity_class: 'EXACT', cert_status: 'uncertified' },
  { cert_id: 'c7', provider_id: 'p7', model_code: 'veo3.1', fidelity_class: 'EXACT', cert_status: 'revoked' },
];

test('listCertified：只回 cert_status=certified 的行（剔除 uncertified/revoked）', async () => {
  const pool = makePool({ rows: CERT_ROWS });
  const rows = await listCertified(pool);
  assert.strictEqual(rows.length, 5); // c1..c5（剔除 c6 uncertified / c7 revoked）
  assert.ok(rows.every((r) => r.cert_status === 'certified'));
  assert.ok(pool.lastSql.includes("cert_status = 'certified'"));
});

test('listCertified：modelCode 精确过滤', async () => {
  const pool = makePool({ rows: CERT_ROWS });
  const rows = await listCertified(pool, { modelCode: 'veo3.1' });
  assert.strictEqual(rows.length, 4); // c1..c4（c5 seedance 剔除，c6/c7 非 certified）
  assert.ok(rows.every((r) => r.model_code === 'veo3.1'));
});

test('listCertified：fidelityAtLeast=COMPATIBLE 只回 COMPATIBLE/EXACT', async () => {
  const pool = makePool({ rows: CERT_ROWS });
  const rows = await listCertified(pool, { fidelityAtLeast: 'COMPATIBLE' });
  const fids = rows.map((r) => r.fidelity_class);
  assert.deepStrictEqual(fids.sort(), ['COMPATIBLE', 'EXACT', 'EXACT']);
});

test('listCertified：fidelityAtLeast=EXACT 只回 EXACT', async () => {
  const pool = makePool({ rows: CERT_ROWS });
  const rows = await listCertified(pool, { fidelityAtLeast: 'EXACT' });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.fidelity_class === 'EXACT'));
});

test('listCertified：fidelityAtLeast=UNKNOWN 回全部 certified（rank≥0）', async () => {
  const pool = makePool({ rows: CERT_ROWS });
  const rows = await listCertified(pool, { fidelityAtLeast: 'UNKNOWN' });
  assert.strictEqual(rows.length, 5);
});

test('listCertified：modelCode + fidelityAtLeast 组合过滤', async () => {
  const pool = makePool({ rows: CERT_ROWS });
  const rows = await listCertified(pool, { modelCode: 'veo3.1', fidelityAtLeast: 'COMPATIBLE' });
  assert.strictEqual(rows.length, 2); // c1 EXACT + c2 COMPATIBLE
  assert.ok(rows.every((r) => r.model_code === 'veo3.1' && ['EXACT', 'COMPATIBLE'].includes(r.fidelity_class)));
});

test('listCertified：非法 fidelityAtLeast fail-loud（throw TypeError）', async () => {
  const pool = makePool({ rows: CERT_ROWS });
  await assert.rejects(
    () => listCertified(pool, { fidelityAtLeast: 'bogus' }),
    /invalid fidelityAtLeast 'bogus'/,
  );
});

test('listCertified：无 pgPool → 返回空数组（不抛）', async () => {
  assert.deepStrictEqual(await listCertified(null), []);
  assert.deepStrictEqual(await listCertified(undefined), []);
});

test('listCertified：DB 抖动 → 优雅降级返回空数组（不抛）', async () => {
  const pool = {
    async query() { throw new Error('connection reset'); },
  };
  assert.deepStrictEqual(await listCertified(pool), []);
});
