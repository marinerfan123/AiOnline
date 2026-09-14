'use strict';
/**
 * Provider Certification — 词表 / 状态机 / 读取（Phase 1 L36，纯函数 + DB 读，无写入）。
 *
 * 职责（墨渊 V2.0 §19-20）：
 *   1. cert_status 状态机校验：uncertified → certified → revoked（revoked 终态）。
 *      - uncertified → certified：certify（落 certified_at）
 *      - certified   → revoked：revoke
 *      - revoked     → (无出边，终态)
 *   2. fidelity_class 词表：EXACT / COMPATIBLE / SIMILAR / UNKNOWN（§19），
 *      带偏序 rank（EXACT > COMPATIBLE > SIMILAR > UNKNOWN），供 fidelityAtLeast 过滤。
 *   3. listCertified({modelCode?, fidelityAtLeast?})：读 provider_certifications，
 *      只回 cert_status='certified' 的认证行，可选按 model_code 精确过滤、
 *      按 fidelity rank 下界过滤（§20：透明 Fallback 只允许 certified + fidelity 达标）。
 *
 * 词表单一来源（DB 只 CHECK 兜底，与 0056/0059 同款分层）：
 *   - cert_status       uncertified/certified/revoked
 *   - fidelity_class    EXACT/COMPATIBLE/SIMILAR/UNKNOWN
 * 写入方（后续 L35 admission / onboarding）须复用本文件的守卫，禁止在别处散写词表。
 */

// ── 词表 ──────────────────────────────────────────────────────────────
const CERT_STATUSES = ['uncertified', 'certified', 'revoked'];
const FIDELITY_CLASSES = ['EXACT', 'COMPATIBLE', 'SIMILAR', 'UNKNOWN'];

// §19 偏序：EXACT（同名同渠道最保真）> COMPATIBLE（能力经 contract 验证）>
//           SIMILAR（相似但未证等价）> UNKNOWN（未知，最低）。
const FIDELITY_RANK = { UNKNOWN: 0, SIMILAR: 1, COMPATIBLE: 2, EXACT: 3 };

// 状态机邻接表：revoked 为终态（无出边）；仅允许向前单步。
const CERT_TRANSITIONS = {
  uncertified: ['certified'],
  certified: ['revoked'],
  revoked: [],
};

// ── 校验（纯函数，无 DB）─────────────────────────────────────────────
function isValidCertStatus(status) {
  return CERT_STATUSES.includes(status);
}

function isValidFidelityClass(fidelityClass) {
  return FIDELITY_CLASSES.includes(fidelityClass);
}

/** 词表校验 → { ok, errors } 信封（codebase canonical shape）。 */
function assertCertStatus(status) {
  if (isValidCertStatus(status)) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: [`invalid cert_status '${status}': expected one of ${CERT_STATUSES.join('/')}`],
  };
}

function assertFidelityClass(fidelityClass) {
  if (isValidFidelityClass(fidelityClass)) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: [`invalid fidelity_class '${fidelityClass}': expected one of ${FIDELITY_CLASSES.join('/')}`],
  };
}

/**
 * cert_status 状态机转移校验 → { ok, errors }。
 * 允许：uncertified → certified（certify）、certified → revoked（revoke）。
 * 拒绝：revoked 出边、同态自环、跳态、非法词表值。
 */
function assertTransition(from, to) {
  const errors = [];
  if (!isValidCertStatus(from)) {
    errors.push(`invalid cert_status '${from}': expected one of ${CERT_STATUSES.join('/')}`);
  }
  if (!isValidCertStatus(to)) {
    errors.push(`invalid cert_status '${to}': expected one of ${CERT_STATUSES.join('/')}`);
  }
  if (errors.length) return { ok: false, errors };
  const allowed = CERT_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    errors.push(
      `illegal cert_status transition '${from}' -> '${to}': allowed transitions from '${from}' are [${allowed.join(', ') || 'none (terminal)'}]`,
    );
  }
  return { ok: errors.length === 0, errors };
}

/** fidelity_class 偏序 rank（非法值返回 null）。 */
function rankFidelity(fidelityClass) {
  return Object.prototype.hasOwnProperty.call(FIDELITY_RANK, fidelityClass)
    ? FIDELITY_RANK[fidelityClass]
    : null;
}

// ── 读取 ──────────────────────────────────────────────────────────────
/**
 * 列出「已认证」的 provider 认证行。
 * @param {object} pgPool                          PG 连接池
 * @param {{modelCode?:string, fidelityAtLeast?:string}} [opts]
 *   - modelCode        精确匹配 model_code（省略 = 不过滤；provider 级认证 model_code 为 NULL 不命中）
 *   - fidelityAtLeast  仅回 fidelity rank ≥ 该值的行（EXACT>COMPATIBLE>SIMILAR>UNKNOWN）
 * @returns {Promise<Array<object>>}  provider_certifications 行（cert_status='certified'）
 * @throws {TypeError}  fidelityAtLeast 为非法词表值时 fail-loud（admission fail-closed 语义）
 */
async function listCertified(pgPool, { modelCode, fidelityAtLeast } = {}) {
  if (!pgPool || typeof pgPool.query !== 'function') return [];
  const params = [];
  let sql = `SELECT * FROM provider_certifications WHERE cert_status = 'certified'`;
  if (modelCode !== undefined && modelCode !== null && modelCode !== '') {
    params.push(modelCode);
    sql += ` AND model_code = $${params.length}`;
  }

  let rows = [];
  try {
    const res = await pgPool.query(sql, params);
    rows = res.rows || [];
  } catch (e) {
    // DB 抖动 → 优雅降级返回空列表，由 admission（L35）统一 fail-closed，不向上抛。
    return [];
  }

  if (fidelityAtLeast !== undefined && fidelityAtLeast !== null && fidelityAtLeast !== '') {
    const minRank = rankFidelity(fidelityAtLeast);
    if (minRank === null) {
      throw new TypeError(
        `invalid fidelityAtLeast '${fidelityAtLeast}': expected one of ${FIDELITY_CLASSES.join('/')}`,
      );
    }
    rows = rows.filter((r) => {
      const rank = rankFidelity(r && r.fidelity_class);
      return rank !== null && rank >= minRank;
    });
  }

  return rows;
}

module.exports = {
  // 词表
  CERT_STATUSES,
  FIDELITY_CLASSES,
  FIDELITY_RANK,
  CERT_TRANSITIONS,
  // 校验
  isValidCertStatus,
  isValidFidelityClass,
  assertCertStatus,
  assertFidelityClass,
  assertTransition,
  rankFidelity,
  // 读取
  listCertified,
};
