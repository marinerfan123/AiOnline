/**
 * 全站统一格式化工具
 *
 * 规则：积分/双池余额（rewardCredits / rechargeCredits / 流水 amount /
 * model creditCost 等）一律只显示小数点后 1 位，且不带千分位分隔符——
 * 与产品对「金额仍用 ¥ + toFixed(2)」严格区分，避免混淆。
 *
 * 示例：
 *   formatCredits(100000.0000)        => "100000.0"
 *   formatCredits(2010051.4500220)    => "2010051.5"
 *   formatCredits(0)                  => "0.0"
 *   formatCredits(null)               => "0.0"
 *   formatCredits(NaN)                => "0.0"
 *   formatCredits("123.45" as any)    => "123.5"  // 容忍字符串传入
 *
 * 为什么不加千分位：参考截图与现有文案均不带逗号（"100000.0000"），
 * 保持原观感；如未来要加，可改为 `Math.round(n).toLocaleString('zh-CN') + '.0'`。
 */

/** 把任意可数值化输入规整为有限 number；非数/空值兜底为 0。 */
function toSafeNumber(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 积分显示：四舍五入保留 1 位小数。
 * 输入空/非数 → "0.0"；输入 5 → "5.0"；输入 -1.45 → "-1.5"。
 */
export function formatCredits(v: unknown): string {
  return toSafeNumber(v).toFixed(1);
}

/**
 * 带符号的积分显示（用于后台流水：消费红/充值绿，+/- 号显示在前面）。
 * - 0 → "0.0"
 * - 12.34 → "+12.3"
 * - -7.89 → "-7.9"
 *
 * 注意：toFixed 会自动给负数带前导负号，不要再额外拼接符号。
 */
export function formatCreditsWithSign(v: unknown): string {
  return toSafeNumber(v).toFixed(1);
}

/**
 * 把 cell 里 `0` 的展示保留为 "0" 而非 "0.0"，其它情况保留 1 位小数。
 * 用于「累计赠送 +50 积分」之类幂等/笔数场景，不希望末位都带 ".0" 显得啰嗦。
 */
export function formatCreditsCompact(v: unknown): string {
  const n = toSafeNumber(v);
  return n === 0 ? '0' : n.toFixed(1);
}
