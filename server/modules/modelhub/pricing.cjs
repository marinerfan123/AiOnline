'use strict';
/**
 * ModelHub — Pricing Rule 版本化计算器（L31）。
 *
 * 规范对齐 §84-91：
 *   - §84  Billing 三概念严格分（estimated/actual/user_charge 绝不混）——本模块只算
 *          单一「rule 价格」，不含供应商成本（Provider Cost ≠ 时长 §86），
 *           与 ai-control/domain/pricing.cjs 的 quoteGeneration 分层职责不重叠。
 *   - §86  Provider Cost ≠ 简单时长（Seedance 2.5 受输出秒数 + 输入/参考视频秒数 +
 *           分辨率共同影响）——故有 rate_per_second / rate_per_frame / tiered / fixed
 *           多维度公式，绝不只存 price_per_second。
 *   - §87  Pricing Rule 结构化公式 + versioned calculator；**禁止后台管理员填任意 JS**。
 *
 * 禁任意 JS 的落法：calculate() 是 formula_kind 白名单解释器——
 *   只认 fixed / rate_per_second / rate_per_frame / tiered / custom_ref 五种公式；
 *   无 eval、无 Function 构造器、无动态 require/import、无从 params 拼执行体；
 *   params 只读白名单键；custom_ref 仅返回引用字符串，绝不执行外部 calculator。
 *
 * resolveRule() 通过 pg 读 pricing_rules(0066) 解析「当前生效（effective 窗口）的
 * ACTIVE 最新版（rule_version DESC）」。calculate() 为纯函数（不碰 DB）。
 */

/** formula_kind 白名单（唯一允许的公式类；未知值一律拒绝）。 */
const FORMULA_KINDS = Object.freeze([
  'fixed', 'rate_per_second', 'rate_per_frame', 'tiered', 'custom_ref',
]);

/** 可计算类（custom_ref 是引用，不在此列——仅返回引用不执行）。 */
const COMPUTABLE_KINDS = new Set(['fixed', 'rate_per_second', 'rate_per_frame', 'tiered']);

/** tiered 允许的计量维度（白名单，禁任意键）。 */
const TIERED_DIMENSIONS = new Set(['seconds', 'frames', 'units']);

/** 安全数字归约：非有限数一律回退 fallback（默认 0）。 */
function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 纯函数：按 rule.formula_kind 白名单解释器计算价格。
 * 禁任意 JS：无 eval/Function/动态 require；只读白名单键；custom_ref 不执行。
 *
 * @param {object} args
 * @param {object} args.rule   pricing_rules 行（至少含 formula_kind + params）
 * @param {object} [args.usage] 计量输入 { seconds?, frames?, units? }
 * @returns {object}
 *   - computed: boolean   可计算类=true，custom_ref=false
 *   - amount: number|null 计算结果（custom_ref 为 null）
 *   - formulaKind: string 回显命中的公式类
 *   - ref: string|null    仅 custom_ref 时返回引用字符串
 * @throws 未知 formula_kind / 非法 tiered 维度 / 缺 rule → 拒绝（禁静默）
 */
function calculate({ rule, usage = {} } = {}) {
  if (!rule) {
    throw new Error('pricing.calculate: rule 必填');
  }
  const kind = rule.formula_kind;
  if (kind === 'custom_ref') {
    // §87：custom_ref 仅返回引用，绝不执行外部 calculator（引用字符串原样回传，
    // 不做 eval/require/函数调用——哪怕引用内容形似代码也不执行）。
    const params = rule.params || {};
    const ref = params.ref == null ? '' : String(params.ref);
    return { computed: false, amount: null, formulaKind: 'custom_ref', ref };
  }
  if (!COMPUTABLE_KINDS.has(kind)) {
    // 未知公式类：白名单拒绝（禁静默、禁 fallback 到任意 JS）
    throw new Error(`pricing.calculate: 未知 formula_kind 被拒: ${String(kind)}`);
  }

  const params = rule.params || {};
  const seconds = num(usage.seconds);
  const frames = num(usage.frames);
  const units = num(usage.units);

  let amount = 0;
  switch (kind) {
    case 'fixed':
      amount = num(params.amount);
      break;

    case 'rate_per_second':
      amount = num(params.rate) * seconds;
      break;

    case 'rate_per_frame':
      amount = num(params.rate) * frames;
      break;

    case 'tiered': {
      // 累计阶梯（progressive brackets）：tiers 依序覆盖 (prevUpTo, upTo] 区间，
      // 末段 upTo=null 表示开放段（∞）。
      const dimension = String(params.dimension || 'seconds');
      if (!TIERED_DIMENSIONS.has(dimension)) {
        throw new Error(`pricing.calculate: tiered 非法维度被拒: ${dimension}`);
      }
      const q = dimension === 'seconds' ? seconds : dimension === 'frames' ? frames : units;
      const tiers = Array.isArray(params.tiers) ? params.tiers : [];
      let prevUpTo = 0;
      let acc = 0;
      for (const t of tiers) {
        const rawUpTo = t && t.upTo;
        const upTo = (rawUpTo == null) ? Infinity : Number(rawUpTo);
        const price = num(t && t.price);
        const bracket = Math.max(0, Math.min(q, upTo) - prevUpTo);
        acc += bracket * price;
        if (upTo === Infinity) break; // 开放段之后无更段
        prevUpTo = upTo;
      }
      amount = acc;
      break;
    }

    default:
      // 防御：COMPUTABLE_KINDS 与 switch 白名单必须一致，否则拒绝
      throw new Error(`pricing.calculate: 未实现 formula_kind: ${String(kind)}`);
  }

  return { computed: true, amount, formulaKind: kind, ref: null };
}

/**
 * 构造 Pricing Calculator。
 * @param {object} deps
 * @param {object} deps.pg  PG Pool/Client（需 .query(sql, params)）
 * @returns {{resolveRule, calculate}}
 */
function createPricingCalculator({ pg }) {
  /**
   * 解析某逻辑模型 × Operation 的当前生效定价规则。
   * 匹配条件：status='ACTIVE' 且 effective_from <= at 且
   * (effective_to IS NULL OR effective_to > at)；同窗口内按 rule_version DESC 取最新版。
   *
   * @param {object} q
   * @param {string} q.modelId        逻辑模型 id（= models.model_id）
   * @param {string} q.operationCode  Operation code
   * @param {number} [q.atMs]         解析时刻（epoch ms；缺省 = Date.now()）
   * @returns {Promise<{ok:true, rule:object|null} |
   *                   {ok:false, code, httpStatus, message, rule:null}>}
   */
  async function resolveRule({ modelId, operationCode, atMs } = {}) {
    if (!pg || typeof pg.query !== 'function') {
      return { ok: false, code: 'DB_UNAVAILABLE', httpStatus: 503, message: 'pricing: 无可用 pg 连接', rule: null };
    }
    if (!modelId || !operationCode) {
      return { ok: false, code: 'INVALID_ARGUMENT', httpStatus: 400, message: 'pricing: modelId 与 operationCode 必填', rule: null };
    }
    const at = new Date(atMs == null ? Date.now() : atMs);
    try {
      const r = await pg.query(
        `SELECT * FROM pricing_rules
          WHERE model_id = $1 AND operation_code = $2 AND status = 'ACTIVE'
            AND effective_from <= $3
            AND (effective_to IS NULL OR effective_to > $3)
          ORDER BY rule_version DESC, created_at DESC, rule_id DESC
          LIMIT 1`,
        [modelId, operationCode, at],
      );
      const row = (r.rows && r.rows[0]) || null;
      return { ok: true, rule: row };
    } catch (e) {
      console.warn('[pricing] resolveRule 失败:', e && e.message);
      return { ok: false, code: 'DB_ERROR', httpStatus: 500, message: 'pricing: resolveRule 查询失败', rule: null };
    }
  }

  return { resolveRule, calculate };
}

module.exports = { createPricingCalculator, calculate, FORMULA_KINDS, COMPUTABLE_KINDS, TIERED_DIMENSIONS };
