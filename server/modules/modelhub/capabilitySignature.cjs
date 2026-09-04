'use strict';
/**
 * capability_signature —— 按 §21 计算 capability 规范化签名（canonical JSON → SHA-256 hex）。
 *
 * §21：capability_signature = 规范化 JSON 后 SHA-256，含
 *   operation / required+supported semantics / duration·resolution·ratio·asset limits /
 *   provider api version / compiler revision。
 *   Provider 更新 → 签名变 → 触发重新 Certification。
 *
 * 规范化规则（canonical 序列化，保证同一能力无论调用方如何组装 JSON 都得到同一签名）：
 *   1. 对象键递归字典序排序（键序无关）。
 *   2. 确定类型：数字用 JSON 数字规范（1.0→1、1.50→1.5，不带多余精度）；NaN/Infinity 抛错；
 *      字符串按 JSON 转义；布尔/null 原样。undefined 值：对象键被省略、数组元素视为 null
 *      （与 JSON.stringify 语义一致，保证「缺省字段」稳定）。
 *   3. 数组顺序裁决：默认数组为有序语义（顺序保留，顺序不同 → 签名不同）；
 *      仅当数组所在字段名命中下方 UNORDERED_SET_FIELDS 白名单时，视为无序集合，
 *      对元素（按各自 canonical 串）排序后再序列化 —— 顺序无关。
 *   4. 键名白名单 + 类型过滤：仅白名单字段才做无序排序，其它数组绝不重排（防误伤有序序列）。
 */

const crypto = require('node:crypto');

/**
 * 无序集合语义的数组字段名白名单（按叶子键名匹配）。
 * 这些字段的数组元素先后顺序不改变能力语义，故排序后参与签名。
 * 来源：§21「required+supported semantics」为集合；limits.resolution/ratio 为允许值集合。
 * 未列入白名单的数组一律视为有序序列，保留原顺序（顺序敏感性）。
 */
const UNORDERED_SET_FIELDS = new Set([
  'required',   // semantics.required   —— 必需语义集合
  'supported',  // semantics.supported  —— 支持语义集合
  'resolution', // limits.resolution    —— 允许分辨率集合
  'ratio',      // limits.ratio         —— 允许宽高比集合
]);

/**
 * 把任意 JSON 值规范化为确定性的紧凑 JSON 字符串。
 * @param {*} value     待规范化的值（对象/数组/数字/字符串/布尔/null）
 * @param {string|null} fieldName 当前值在父对象中的键名（数组无序裁决依据）
 * @returns {string} 规范化后的紧凑 JSON 字符串（无空白）
 */
function canonicalize(value, fieldName = null) {
  if (value === undefined) return 'null';
  if (value === null) return 'null';

  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonicalize: 数字必须为有限值（NaN/Infinity 不可签名）');
    }
    return JSON.stringify(value); // 1.0→"1"、1.50→"1.5"，无多余精度
  }
  if (t === 'string' || t === 'boolean') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const parts = value.map((el) => canonicalize(el, fieldName));
    // 无序集合白名单内的数组 → 排序（元素按 canonical 串排序）；其余数组保留原顺序。
    if (typeof fieldName === 'string' && UNORDERED_SET_FIELDS.has(fieldName)) {
      parts.sort();
    }
    return '[' + parts.join(',') + ']';
  }

  if (t === 'object') {
    // 键递归排序 + 跳过 undefined 值（缺省字段稳定：undefined 与缺省等价）
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    const body = keys
      .map((k) => JSON.stringify(k) + ':' + canonicalize(value[k], k))
      .join(',');
    return '{' + body + '}';
  }

  throw new TypeError('canonicalize: 不支持的类型 ' + t);
}

/**
 * 计算 capability 签名（§21）。
 * @param {object} args
 * @param {string} args.operationCode    操作码（必填，非空字符串）
 * @param {object} [args.semantics]      语义对象，如 { required:[...], supported:[...] }
 * @param {object} [args.limits]         duration/resolution/ratio/asset limits
 * @param {string} [args.apiVersion]     Provider API 版本（冻结）
 * @param {string} [args.compilerRevision] Compiler 修订号
 * @returns {string} 64 位小写十六进制 SHA-256 签名
 */
function buildCapabilitySignature({ operationCode, semantics, limits, apiVersion, compilerRevision }) {
  if (typeof operationCode !== 'string' || operationCode.length === 0) {
    throw new TypeError('buildCapabilitySignature: operationCode 必须为非空字符串');
  }
  // 规范化载荷：字段名对齐 §21 词表（operation/semantics/limits/apiVersion/compilerRevision）
  const payload = {
    operation: operationCode,
    semantics: semantics === undefined ? null : semantics,
    limits: limits === undefined ? null : limits,
    apiVersion: apiVersion === undefined ? null : apiVersion,
    compilerRevision: compilerRevision === undefined ? null : compilerRevision,
  };
  const canonical = canonicalize(payload);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

module.exports = { buildCapabilitySignature, canonicalize, UNORDERED_SET_FIELDS };
