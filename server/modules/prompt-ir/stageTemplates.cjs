'use strict';
/**
 * G16 — stage 参数模板纯模块（stageTemplates；无 I/O、无 DB、无随机）。
 *
 * G16 验收项 object/camera/light（05 spec / doc 19 §6.3）的「参数模板」层：
 * 对导演台三类 stage 各冻结一组可复用的参数模板 + 每参数字段的默认值与
 * 约束（整数 / 闭区间），并提供纯函数 buildStageParams 完成「模板选型 +
 * overrides 校验 + 合并」。directorize 层（ShotDirective → previz stage 参数）
 * 后期经导出的 CAMERA_DEFAULTS / LIGHT_DEFAULTS 常量消费本模块默认值。
 *
 * ── 形状（STAGE_TYPES，全部深冻结）────────────────────────────────────────
 *   STAGE_TYPES = {
 *     camera: { templates: {          // 相机模板：载体方式（mount）各一
 *       tripod:  { params: { x,y,z: integer cm 默认 0（闭区间 [-1000,1000]），
 *                            mount: enum('tripod','handheld','moving') 默认 'tripod' } },
 *       handheld:{ params: 同构，mount 默认 'handheld' },
 *       moving:  { params: 同构，mount 默认 'moving' },
 *     } },
 *     light: { templates: {           // 灯光模板：三点布光 key/fill/rim
 *       three_point: { params: {
 *         key:  { intensity: integer [0,100] 默认 80, color: string 默认 'white' },
 *         fill: { intensity: integer [0,100] 默认 50, color: string 默认 'white' },
 *         rim:  { intensity: integer [0,100] 默认 70, color: string 默认 'white' },
 *       } },
 *     } },
 *     object: { templates: {          // 物件模板：本波次仅默认模板（props 默认 []）
 *       default: { params: { props: array 默认 [] } },
 *     } },
 *   }
 *
 *   每个叶子参数是一个「自描述描述子」（见下方 intParam/enumParam/...），
 *   默认值与约束（整数性 / 闭区间 / 枚举 / 非空）随结构一起冻结，不再另开
 *   一份平行 schema，避免双真源漂移。分组参数（key/fill/rim）为
 *   { type:'group', params } 描述子，值是普通对象。
 *
 * ── 语义决定（文档化，冻结）────────────────────────────────────────────────
 *  ① 单位与坐标系：camera 的 x/y/z 为相对拍摄主体/基准的整数厘米偏移
 *     （右+/上+/前+），闭区间 [-1000, 1000]；默认 0 = 交给后续 previz /
 *     上层语义取位（本波次不发明默认机位距离）。
 *  ② mount 是受控枚举（template 自身即 carrier 预设：tripod/handheld/moving），
 *     枚举集冻结为三者；模板默认值 = 模板名，但允许 overrides 显式改换
 *     （仍必须命中枚举）。后续若出现新载体（dolly/crane/…）走 additive 演进。
 *  ③ light intensity 为整数百分强度，闭区间 [0,100]；color 默认 'white'，
 *     合法 overrides 为非空字符串（词表 token 或 hex 均可，受控词表由上层冻结，
 *     本波次不限制——避免无依据地收窄）。
 *  ④ object.props 为数组（默认 []），overrides 整体替换该数组（不做元素级
 *     schema 校验——元素形状属上层实体契约，非本参数模板层管辖）。
 *  ⑤ buildStageParams 输出为每次新建的可变对象（不与 STAGE_TYPES 共享引用），
 *     不冻结输出——调用方可安全定制而不会污染模板常量；模块级常量全部深冻结，
 *     strict 模式下任何写入即抛错（纯性证明）。
 *
 * ── 校验（buildStageParams）───────────────────────────────────────────────
 *   全部失败走 codebase { ok:false, errors:[...] } 约定，errors 为字符串数组：
 *    - stageType / templateId 未知（列出已知集合）；
 *    - overrides 非普通对象；
 *    - overrides 键不在模板 params schema 内（含嵌套分组路径，逐条列出）；
 *    - 数值非整数 / 越出闭区间（含边界外 1 个单位）；
 *    - enum 值不在枚举集 / 字符串 trim 后为空 / 数组 override 非数组。
 *   逐条累加不短路；errors 非空即 { ok:false }，绝不部分合并返回。
 */

/** 相机 mount 受控枚举（模板载体方式；见语义②）。 */
const CAMERA_MOUNTS = Object.freeze(['tripod', 'handheld', 'moving']);

/** 整型参数描述子：默认值 + 闭区间 [min,max]（整数性由校验强制）。 */
function intParam(def, min, max, desc) {
  return Object.freeze({ type: 'integer', default: def, min, max, desc });
}
/** 枚举参数描述子。 */
function enumParam(def, values, desc) {
  return Object.freeze({ type: 'enum', default: def, values: Object.freeze([...values]), desc });
}
/** 非空字符串参数描述子。 */
function strParam(def, desc) {
  return Object.freeze({ type: 'string', default: def, desc });
}
/** 数组参数描述子（默认值冻结，元素级校验不属本层，见语义④）。 */
function arrParam(def, desc) {
  return Object.freeze({ type: 'array', default: Object.freeze([...def]), desc });
}
/** 分组参数描述子：值为普通对象，递归容纳子参数。 */
function groupParam(params) {
  const frozen = {};
  for (const [k, v] of Object.entries(params)) frozen[k] = v;
  return Object.freeze({ type: 'group', params: Object.freeze(frozen) });
}

/** 深冻结辅助（strict 模式下对冻结对象写入即抛 TypeError）。 */
function deepFreeze(v) {
  if (v == null || typeof v !== 'object' || Object.isFrozen(v)) return v;
  Object.freeze(v);
  for (const k of Object.keys(v)) deepFreeze(v[k]);
  return v;
}

/** 递归复制普通 JSON 值（数组/普通对象/标量），产出独立副本。 */
function cloneValue(v) {
  if (Array.isArray(v)) return v.map(cloneValue);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = cloneValue(x);
    return out;
  }
  return v;
}

/** 单一相机模板描述子（x/y/z + mount，见语义①②）。 */
function cameraTemplate(mountDefault) {
  return Object.freeze({
    params: Object.freeze({
      x: intParam(0, -1000, 1000, '相机相对基准的左右偏移（cm；整数闭区间 [-1000,1000]）'),
      y: intParam(0, -1000, 1000, '相机相对基准的上下偏移（cm；整数闭区间 [-1000,1000]）'),
      z: intParam(0, -1000, 1000, '相机相对基准的前后偏移（cm；整数闭区间 [-1000,1000]）'),
      mount: enumParam(mountDefault, CAMERA_MOUNTS, `载体方式（受控枚举 ${CAMERA_MOUNTS.join('/')}）`),
    }),
  });
}

/** 单盏灯描述子：intensity 整数百分强度闭区间 [0,100] + color 非空串默认白（语义③）。 */
function lightDesc(intensityDefault) {
  return Object.freeze({
    intensity: intParam(intensityDefault, 0, 100, '灯光强度（整数百分制，闭区间 [0,100]）'),
    color: strParam('white', '灯光颜色（默认白；非空字符串 token 或 hex）'),
  });
}

/** stage 参数模板注册表（深冻结；结构见文件头注释）。 */
const STAGE_TYPES = deepFreeze({
  camera: {
    templates: {
      tripod: cameraTemplate('tripod'),
      handheld: cameraTemplate('handheld'),
      moving: cameraTemplate('moving'),
    },
  },
  light: {
    templates: {
      three_point: {
        params: {
          key: groupParam(lightDesc(80)),
          fill: groupParam(lightDesc(50)),
          rim: groupParam(lightDesc(70)),
        },
      },
    },
  },
  object: {
    templates: {
      default: {
        params: {
          props: arrParam([], '场景物件引用数组（默认 []；override 整体替换，元素级 schema 不属本层）'),
        },
      },
    },
  },
});

/** 描述子默认值 → 值对象（递归；分组 → 普通对象，叶子 → 默认值副本）。 */
function defaultsToValues(paramsSchema) {
  const out = {};
  for (const [key, node] of Object.entries(paramsSchema)) {
    if (node.type === 'group') out[key] = defaultsToValues(node.params);
    else out[key] = cloneValue(node.default);
  }
  return out;
}

/**
 * 把 overrides 校验并合并进 values（原地改写 values，错误逐条收集）。
 * 只在 schema 键上行走：未知键 / 非法值均落 errors，绝不静默丢弃。
 */
function applyOverrides(values, paramsSchema, ov, path, errors) {
  if (ov === undefined || ov === null) return;
  if (typeof ov !== 'object' || Array.isArray(ov)) {
    errors.push(`overrides${path ? ` '${path}'` : ''} must be a plain object (got ${Array.isArray(ov) ? 'array' : typeof ov})`);
    return;
  }
  for (const key of Object.keys(ov)) {
    if (!Object.prototype.hasOwnProperty.call(paramsSchema, key)) {
      errors.push(`unknown override parameter '${path ? `${path}.` : ''}${key}' (not in template params schema)`);
      continue;
    }
    const node = paramsSchema[key];
    const full = path ? `${path}.${key}` : key;
    const val = ov[key];
    if (node.type === 'group') {
      applyOverrides(values[key], node.params, val, full, errors);
      continue;
    }
    if (!validateLeaf(node, val, full, errors)) continue;
    values[key] = cloneValue(val); // 副本入库：返回参数与调用方输入零共享引用
  }
}

/** 单叶子描述子值校验；通过返回 true，失败收集一条 error 并返回 false。 */
function validateLeaf(node, val, full, errors) {
  if (node.type === 'integer') {
    if (!Number.isInteger(val)) {
      errors.push(`override '${full}' must be an integer in [${node.min}, ${node.max}] (got ${String(val)})`);
      return false;
    }
    if (val < node.min || val > node.max) {
      errors.push(`override '${full}' out of range: integer must be in the closed interval [${node.min}, ${node.max}] (got ${val})`);
      return false;
    }
    return true;
  }
  if (node.type === 'enum') {
    if (!node.values.includes(val)) {
      errors.push(`override '${full}' must be one of [${node.values.join(', ')}] (got ${String(val)})`);
      return false;
    }
    return true;
  }
  if (node.type === 'string') {
    if (typeof val !== 'string' || val.trim() === '') {
      errors.push(`override '${full}' must be a non-empty string (got ${String(val)})`);
      return false;
    }
    return true;
  }
  if (node.type === 'array') {
    if (!Array.isArray(val)) {
      errors.push(`override '${full}' must be an array (got ${typeof val})`);
      return false;
    }
    return true;
  }
  errors.push(`override '${full}' has unsupported schema type '${node.type}'`);
  return false;
}

/**
 * buildStageParams({ stageType, templateId, overrides }) → 合并后的参数字典。
 *   stageType:  'camera' | 'light' | 'object'（STAGE_TYPES 键集）
 *   templateId: 该 stage 的模板 id（如 camera:'tripod'，light:'three_point'，object:'default'）
 *   overrides:  可选普通对象；键必须是模板 params schema 内叶子/分组的键。
 *
 * 成功 → { ok:true, params }，params 为全新对象（默认值 + overrides 合并，
 * 键序 = schema 序，确定性输出）；任何失败 → { ok:false, errors:[...] }。
 * 纯函数：不读环境、不写全局、不改入参、不冻结输出（调用方可定制）。
 */
function buildStageParams(options) {
  if (options === undefined || options === null || typeof options !== 'object' || Array.isArray(options)) {
    return { ok: false, errors: ['options object { stageType, templateId, overrides? } required'] };
  }
  const { stageType, templateId, overrides } = options;
  const errors = [];

  if (typeof stageType !== 'string' || !Object.prototype.hasOwnProperty.call(STAGE_TYPES, stageType)) {
    errors.push(`unknown stageType ${JSON.stringify(stageType)} (known: ${Object.keys(STAGE_TYPES).join(', ')})`);
  }
  const templates = typeof stageType === 'string' && STAGE_TYPES[stageType] ? STAGE_TYPES[stageType].templates : null;
  if (templates !== null && (typeof templateId !== 'string' || !Object.prototype.hasOwnProperty.call(templates, templateId))) {
    errors.push(`unknown templateId ${JSON.stringify(templateId)} for stageType '${stageType}' (known: ${Object.keys(templates).join(', ')})`);
  }

  if (overrides !== undefined && (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides))) {
    errors.push(`overrides must be a plain object (got ${overrides === null ? 'null' : Array.isArray(overrides) ? 'array' : typeof overrides})`);
  }

  if (errors.length > 0) return { ok: false, errors };

  const paramsSchema = templates[templateId].params;
  const params = defaultsToValues(paramsSchema); // 全新默认值对象
  applyOverrides(params, paramsSchema, overrides, '', errors); // 校验 + 合并
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, params };
}

/** 从模板描述子提取默认值对象（供常量与测试共用）。 */
function templateDefaults(stageType, templateId) {
  return defaultsToValues(STAGE_TYPES[stageType].templates[templateId].params);
}

/**
 * CAMERA_DEFAULTS / LIGHT_DEFAULTS —— 供 directorize 层消费的默认 stage 参数。
 * 由 STAGE_TYPES 的规范模板默认值派生（camera 规范模板 = 'tripod'；light =
 * 'three_point'），单一真源：模板演进 → 常量随之派生，不另设第二份字面量。
 * 深冻结，directorize 可安全展开进 ShotDirective 的 previz stage 参数。
 */
const CAMERA_DEFAULTS = deepFreeze(templateDefaults('camera', 'tripod'));
const LIGHT_DEFAULTS = deepFreeze(templateDefaults('light', 'three_point'));

module.exports = {
  STAGE_TYPES,
  buildStageParams,
  CAMERA_DEFAULTS,
  LIGHT_DEFAULTS,
};
