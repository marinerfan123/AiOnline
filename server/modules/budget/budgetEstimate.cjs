'use strict';
/**
 * budgetEstimate.cjs — 预算前置估算（纯函数，无 I/O）。
 *
 * V2.0 must#2「预算前置 / superset budget-aware」的纯估算核心：给定一批 shot
 * （视频按秒计价、图像按件计价）与按 modelId 注入的价格表，算出总「单位」(units)，
 * 并判定是否需要二次确认（超过阈值，或存在无价任务）。
 *
 * 单位语义（与 server/modules/generation-v2/intake.cjs normalizeMoney 对齐）：
 *   1 credit = unitsPerCredit units（默认 10000），即金额以 4 位小数为精度
 *   （对应 NUMERIC(14,4) 列，如 generation_batches_v2.unit_price /
 *   generation_credit_holds_v2.amount）。估算先按 credit 计算并 round 到 4dp，
 *   再 ×unitsPerCredit 得整数 units。
 *
 * 价格真源（本模块只做纯计算，价格表由调用方注入 unitPrices；此处注明真源列）：
 *   用户侧单逻辑模型价 = models 表价格列 `credit_cost NUMERIC(18,4)`
 *   （db/migrations/0001_baseline_legacy_schema.sql:35），其上由
 *   `model_pricing.credit_price NUMERIC(18,4)`（0008:155，回填自 models.credit_cost）
 *   与 `model_price_history.credit_cost NUMERIC(18,4)`（0008:147）组成双读链覆盖：
 *   accounting.getModelPrice（server/accounting.cjs:49）= model_pricing →
 *   model_price_history → models.credit_cost → 0（见 modelhub/pricing.test.cjs）。
 *   unitPrices 的形状即由该真源派生：
 *     - { perImageCredits, perSecondCredits }  → 图按件、视频按秒
 *     - 数字（每任务价）                        → 该模型每次任务平摊 credit
 */

const KINDS = new Set(['video', 'image']);

/** Round a credit amount to 4 decimal places (N(14,4) semantics). */
function round4(x) {
  return Math.round(x * 10000) / 10000;
}

/**
 * credit → integer units。先 toFixed(4) 对齐 N(14,4) 精度，再放大，
 * 避免 `x * 10000` 的浮点尾差（1.2345 → 12345，精确整数）。
 */
function creditsToUnits(credits, unitsPerCredit = 10000) {
  const upc = Number(unitsPerCredit) || 10000;
  const c = Number(credits) || 0;
  const [whole, frac] = c.toFixed(4).split('.');
  return Math.round(Number(whole) * upc + (Number(frac) / 10000) * upc);
}

/** integer units → credit 十进制字符串（N(14,4)，如 12345 → '1.2345'）。 */
function unitsToCredits(units, unitsPerCredit = 10000) {
  const upc = Math.round(Number(unitsPerCredit) || 10000);
  const n = Math.round(Number(units) || 0);
  const digits = String(upc).length - 1; // 10000 → 4
  const whole = Math.floor(n / upc);
  const frac = String(n % upc).padStart(digits, '0');
  return `${whole}.${frac}`;
}

/**
 * 估算一批 shot 的预算单位。
 *
 * @param {object} args
 * @param {Array<{shotId?: string, kind: 'video'|'image', model: string,
 *                seconds?: number, count?: number}>} args.shots
 * @param {object} args.unitPrices modelId → { perImageCredits?, perSecondCredits? } 或 数字(每任务价)
 * @param {number} [args.unitsPerCredit=10000] 1 credit = 多少 units（N(14,4) → 10000）
 * @param {number} [args.thresholdUnits=100000] 总 units 超过此阈值则需确认
 * @returns {{ totalUnits:number, perKind:{video:number,image:number},
 *             needsConfirmation:boolean, hasUnpriced:boolean,
 *             thresholdUnits:number,
 *             breakdown:Array<{shotId?:string,kind:string,model:string,
 *                              units:number|null,unpriced?:boolean}> }}
 */
function estimateRun({ shots, unitPrices, unitsPerCredit = 10000, thresholdUnits = 100000 } = {}) {
  if (!Array.isArray(shots)) {
    throw new TypeError('estimateRun: shots must be an array');
  }
  const upc = Number(unitsPerCredit) || 10000;
  const t = Number(thresholdUnits);
  const threshold = Number.isFinite(t) ? t : 100000;
  const prices = (unitPrices && typeof unitPrices === 'object') ? unitPrices : {};

  const perKind = { video: 0, image: 0 };
  const breakdown = [];
  let totalUnits = 0;
  let hasUnpriced = false;

  shots.forEach((shot, index) => {
    const s = shot || {};
    if (!KINDS.has(s.kind)) {
      throw new TypeError(
        `estimateRun: shots[${index}].kind must be 'video' | 'image' (got ${JSON.stringify(s.kind)})`,
      );
    }
    const model = s.model != null ? String(s.model) : '';
    const entry = prices[model];

    let credits = null; // null = 无价（UNPRICED）
    if (s.kind === 'video') {
      const sec = s.seconds;
      if (!Number.isInteger(sec) || sec <= 0) {
        throw new TypeError(
          `estimateRun: shots[${index}].seconds must be a positive integer (video)`,
        );
      }
      if (typeof entry === 'number') {
        credits = entry; // 每任务价：整条任务平摊
      } else if (entry && typeof entry === 'object' && typeof entry.perSecondCredits === 'number') {
        credits = sec * entry.perSecondCredits;
      }
    } else { // image
      const count = s.count == null ? 1 : s.count;
      if (!Number.isInteger(count) || count <= 0) {
        throw new TypeError(
          `estimateRun: shots[${index}].count must be a positive integer (image)`,
        );
      }
      if (typeof entry === 'number') {
        credits = entry; // 每任务价：整条任务平摊
      } else if (entry && typeof entry === 'object' && typeof entry.perImageCredits === 'number') {
        credits = count * entry.perImageCredits;
      }
    }

    const item = { kind: s.kind, model };
    if (s.shotId != null) item.shotId = s.shotId;

    if (credits == null) {
      item.units = null;
      item.unpriced = true;
      hasUnpriced = true;
    } else {
      const units = creditsToUnits(credits, upc);
      item.units = units;
      totalUnits += units;
      perKind[s.kind] += units;
    }
    breakdown.push(item);
  });

  return {
    totalUnits,
    perKind,
    needsConfirmation: hasUnpriced || totalUnits > threshold,
    thresholdUnits: threshold,
    hasUnpriced,
    breakdown,
  };
}

module.exports = { estimateRun, creditsToUnits, unitsToCredits, round4 };
