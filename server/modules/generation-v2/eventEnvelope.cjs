'use strict';
/**
 * eventEnvelope — §59 内部 Event Envelope（CloudEvents 风格）。
 *
 * 字段（CloudEvents 1.0 语义，不引入 CloudEvents 服务）：
 *   specversion / id / source / type / subject / time / dataschema / data
 * 核心必填：id / source / specversion / type；specversion 固定 '1.0'。
 *
 * 纯函数：不引服务、不碰 DB、不碰网络；事件可 JSON 序列化。
 */

const SPECVERSION = '1.0';

/** 核心必填字段（§59：id/source/specversion/type） */
const REQUIRED_FIELDS = Object.freeze(['id', 'source', 'specversion', 'type']);

/** 可选字段（§59：subject/time/dataschema/data） */
const OPTIONAL_FIELDS = Object.freeze(['subject', 'time', 'dataschema', 'data']);

const ALL_FIELDS = Object.freeze([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);

/**
 * 校验 envelope（纯函数，永不抛错）。
 * @param {object} envelope
 * @returns {{ok:boolean, errors:string[]}}
 */
function validate(envelope) {
  const errors = [];
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { ok: false, errors: ['envelope must be a plain object'] };
  }

  for (const k of ['id', 'source', 'type']) {
    const v = envelope[k];
    if (v === undefined || v === null || v === '') errors.push(`missing required field: ${k}`);
  }

  // specversion 单独校验：缺 → missing；有但非 '1.0' → 版本不符
  const sv = envelope.specversion;
  if (sv === undefined || sv === null || sv === '') {
    errors.push('missing required field: specversion');
  } else if (sv !== SPECVERSION) {
    errors.push(`specversion must be '${SPECVERSION}', got '${sv}'`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 构建 envelope（纯函数）：填充默认值，校验不过则抛 TypeError。
 * @param {object} args
 * @param {string} args.id            事件 id（必填，非空字符串）
 * @param {string} args.source        事件来源（必填，非空字符串，URI 引用）
 * @param {string} args.type          事件类型（必填，非空字符串）
 * @param {string} [args.subject]     主题
 * @param {string} [args.time]        时间（ISO 8601；缺省取调用时刻）
 * @param {string} [args.dataschema]  数据 schema URI
 * @param {*}      [args.data]        载荷（任意可序列化值）
 * @param {string} [args.specversion] 版本；缺省或 '1.0'
 * @returns {object} 完整 envelope（含全部 8 字段）
 */
function buildEnvelope({ id, source, type, subject, time, dataschema, data, specversion } = {}) {
  const envelope = {
    specversion: specversion === undefined ? SPECVERSION : specversion,
    id: id === undefined ? null : id,
    source: source === undefined ? null : source,
    type: type === undefined ? null : type,
    subject: subject ?? null,
    time: time ?? new Date().toISOString(),
    dataschema: dataschema ?? null,
    data: data ?? null,
  };
  const v = validate(envelope);
  if (!v.ok) throw new TypeError(`buildEnvelope: ${v.errors.join('; ')}`);
  return envelope;
}

/**
 * 解析 envelope（纯函数）：接受 JSON 字符串或对象；校验不过抛 TypeError，坏 JSON 抛 SyntaxError。
 * @param {string|object} input
 * @returns {object} 校验通过的 envelope
 */
function parseEnvelope(input) {
  let obj = input;
  if (typeof input === 'string') {
    obj = JSON.parse(input);
  }
  const v = validate(obj);
  if (!v.ok) throw new TypeError(`parseEnvelope: ${v.errors.join('; ')}`);
  return obj;
}

/**
 * 序列化 envelope 为 JSON 字符串（校验通过才序列化）。
 * @param {object} envelope
 * @returns {string}
 */
function serialize(envelope) {
  const v = validate(envelope);
  if (!v.ok) throw new TypeError(`serialize: ${v.errors.join('; ')}`);
  return JSON.stringify(envelope);
}

module.exports = {
  SPECVERSION,
  REQUIRED_FIELDS,
  OPTIONAL_FIELDS,
  ALL_FIELDS,
  buildEnvelope,
  parseEnvelope,
  validate,
  serialize,
};
