'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STAGE_TYPES,
  buildStageParams,
  CAMERA_DEFAULTS,
  LIGHT_DEFAULTS,
} = require('./stageTemplates.cjs');

// ── 结构 / 冻结（模块级常量深冻结，strict 下写入即抛）─────────────────────

test('G16 stageTemplates: STAGE_TYPES 键集 = camera/light/object，模板集冻结', () => {
  assert.deepEqual(Object.keys(STAGE_TYPES).sort(), ['camera', 'light', 'object']);
  assert.deepEqual(Object.keys(STAGE_TYPES.camera.templates).sort(), ['handheld', 'moving', 'tripod']);
  assert.deepEqual(Object.keys(STAGE_TYPES.light.templates), ['three_point']);
  assert.deepEqual(Object.keys(STAGE_TYPES.object.templates), ['default']);
});

test('G16 stageTemplates: STAGE_TYPES 深冻结（任意写抛 TypeError）', () => {
  assert.throws(() => { STAGE_TYPES.object.templates.newOne = { params: {} }; }, TypeError);
  assert.throws(() => { STAGE_TYPES.camera.templates.tripod.params.x.default = 99; }, TypeError);
  assert.throws(() => { STAGE_TYPES.camera.templates.tripod.params.mount.values.push('drone'); }, TypeError);
});

test('G16 stageTemplates: schema 不变量——整数默认值皆整数且在闭区间内，枚举默认值在枚举集内', () => {
  const walk = (params, path) => {
    for (const [k, node] of Object.entries(params)) {
      const p = path ? `${path}.${k}` : k;
      if (node.type === 'group') { walk(node.params, p); continue; }
      if (node.type === 'integer') {
        assert.ok(Number.isInteger(node.min) && Number.isInteger(node.max), `${p} min/max must be integers`);
        assert.ok(node.min <= node.max, `${p} closed interval [min,max] valid`);
        assert.ok(Number.isInteger(node.default), `${p} default must be integer`);
        assert.ok(node.default >= node.min && node.default <= node.max, `${p} default inside [min,max]`);
      } else if (node.type === 'enum') {
        assert.ok(node.values.includes(node.default), `${p} default in values`);
        assert.ok(node.values.length > 0, `${p} values non-empty`);
      } else if (node.type === 'string') {
        assert.ok(typeof node.default === 'string' && node.default.trim() !== '', `${p} default non-empty string`);
      } else if (node.type === 'array') {
        assert.ok(Array.isArray(node.default), `${p} default is array`);
      } else {
        assert.fail(`${p} unknown schema type '${node.type}'`);
      }
    }
  };
  for (const [stage, s] of Object.entries(STAGE_TYPES)) {
    for (const [tid, t] of Object.entries(s.templates)) walk(t.params, `${stage}.${tid}`);
  }
});

// ── 各型默认（buildStageParams 空 overrides）───────────────────────────────

test('G16 stageTemplates: camera 模板默认——x/y/z=0 整数、mount=模板名', () => {
  assert.deepEqual(buildStageParams({ stageType: 'camera', templateId: 'tripod' }).params,
    { x: 0, y: 0, z: 0, mount: 'tripod' });
  assert.deepEqual(buildStageParams({ stageType: 'camera', templateId: 'handheld' }).params,
    { x: 0, y: 0, z: 0, mount: 'handheld' });
  assert.deepEqual(buildStageParams({ stageType: 'camera', templateId: 'moving' }).params,
    { x: 0, y: 0, z: 0, mount: 'moving' });
});

test('G16 stageTemplates: light three_point 默认——key/fill/rim intensity 整数 [0,100] + color 白', () => {
  const r = buildStageParams({ stageType: 'light', templateId: 'three_point' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.params, {
    key: { intensity: 80, color: 'white' },
    fill: { intensity: 50, color: 'white' },
    rim: { intensity: 70, color: 'white' },
  });
  for (const g of ['key', 'fill', 'rim']) {
    assert.ok(Number.isInteger(r.params[g].intensity));
    assert.ok(r.params[g].intensity >= 0 && r.params[g].intensity <= 100);
  }
});

test('G16 stageTemplates: object default 模板默认——props 为空数组', () => {
  const r = buildStageParams({ stageType: 'object', templateId: 'default' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.params, { props: [] });
});

test('G16 stageTemplates: CAMERA_DEFAULTS/LIGHT_DEFAULTS = 规范模板默认值，深冻结', () => {
  assert.deepEqual(CAMERA_DEFAULTS, buildStageParams({ stageType: 'camera', templateId: 'tripod' }).params);
  assert.deepEqual(LIGHT_DEFAULTS, buildStageParams({ stageType: 'light', templateId: 'three_point' }).params);
  assert.ok(Object.isFrozen(CAMERA_DEFAULTS) && Object.isFrozen(CAMERA_DEFAULTS) && Object.isFrozen(CAMERA_DEFAULTS.mount));
  assert.ok(Object.isFrozen(LIGHT_DEFAULTS) && Object.isFrozen(LIGHT_DEFAULTS.key) && Object.isFrozen(LIGHT_DEFAULTS.key.intensity));
});

// ── overrides 合并 ─────────────────────────────────────────────────────────

test('G16 stageTemplates: camera overrides 合并——部分覆盖 + 未覆盖保默认', () => {
  const r = buildStageParams({
    stageType: 'camera', templateId: 'tripod', overrides: { x: 120, y: -45, mount: 'handheld' },
  });
  assert.deepEqual(r.params, { x: 120, y: -45, z: 0, mount: 'handheld' });
  assert.equal(r.ok, true);
});

test('G16 stageTemplates: light 嵌套 overrides 合并——仅覆盖指定分组字段', () => {
  const r = buildStageParams({
    stageType: 'light', templateId: 'three_point',
    overrides: { key: { intensity: 100, color: 'warm' }, rim: { intensity: 20 } },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.params, {
    key: { intensity: 100, color: 'warm' },
    fill: { intensity: 50, color: 'white' }, // 未覆盖分组保默认
    rim: { intensity: 20, color: 'white' },  // 部分覆盖保留其余字段
  });
});

test('G16 stageTemplates: object overrides——props 整体替换', () => {
  const props = [{ ref: 'prop-chair', pos: { x: 0, y: 0, z: -60 } }, 'prop-cup'];
  const r = buildStageParams({ stageType: 'object', templateId: 'default', overrides: { props } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.params.props, props);
  assert.notEqual(r.params.props, props);            // 副本：零共享引用
  assert.notEqual(r.params.props[0], props[0]);
});

test('G16 stageTemplates: 闭区间边界值合法（x±1000、intensity 0/100）', () => {
  assert.equal(buildStageParams({ stageType: 'camera', templateId: 'tripod', overrides: { x: -1000, z: 1000 } }).ok, true);
  assert.equal(
    buildStageParams({ stageType: 'light', templateId: 'three_point', overrides: { key: { intensity: 0 }, fill: { intensity: 100 } } }).ok,
    true);
});

test('G16 stageTemplates: 输出独立可变、入参与模板常量不被改动（纯性）', () => {
  const overrides = { x: 200, mount: 'moving' };
  const snapshot = JSON.parse(JSON.stringify(overrides));
  const first = buildStageParams({ stageType: 'camera', templateId: 'tripod', overrides });
  first.params.x = 99999; // 写返回对象：不影响任何后续结果
  assert.deepEqual(overrides, snapshot); // 入参未被写
  const second = buildStageParams({ stageType: 'camera', templateId: 'tripod', overrides });
  assert.equal(second.params.x, 200);
  assert.equal(second.ok, true);
  // 模板常量未被污染
  assert.deepEqual(
    buildStageParams({ stageType: 'camera', templateId: 'tripod' }).params,
    CAMERA_DEFAULTS);
});

// ── 未知 / 越界 / 类型错误拒绝（{ok:false, errors}）────────────────────────

test('G16 stageTemplates: 未知 stageType / 缺 stageType → 拒，errors 列已知集合', () => {
  const r1 = buildStageParams({ stageType: 'audio', templateId: 'tripod' });
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.includes("unknown stageType \"audio\"") && e.includes('camera, light, object')));
  const r2 = buildStageParams({ templateId: 'tripod' });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.includes('unknown stageType')));
});

test('G16 stageTemplates: 未知 templateId → 拒，errors 列该 stage 已知模板', () => {
  const r1 = buildStageParams({ stageType: 'camera', templateId: 'dolly' });
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.includes('dolly') && e.includes('tripod, handheld, moving')));
  const r2 = buildStageParams({ stageType: 'light', templateId: 'two_point' });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.includes('two_point') && e.includes('three_point')));
  // stageType 未知时 templateId 无从校验（模板表不存在）——不重复报错
  const r3 = buildStageParams({ stageType: 'nope', templateId: 'nada' });
  assert.equal(r3.ok, false);
  assert.ok(r3.errors.some((e) => e.includes("unknown stageType \"nope\"")));
  assert.equal(r3.errors.length, 1);
});

test('G16 stageTemplates: overrides 非普通对象（null/数组/字符串/数字）→ 拒', () => {
  for (const bad of [null, [], 'x', 5]) {
    const r = buildStageParams({ stageType: 'camera', templateId: 'tripod', overrides: bad });
    assert.equal(r.ok, false, `overrides=${JSON.stringify(bad)}`);
    assert.ok(r.errors.length > 0 && typeof r.errors[0] === 'string');
  }
});

test('G16 stageTemplates: overrides 未知键（顶层与嵌套路径）→ 拒并点名', () => {
  const r1 = buildStageParams({ stageType: 'camera', templateId: 'tripod', overrides: { mounT: 'tripod', pitch: 5 } });
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.includes("'mounT'")));
  assert.ok(r1.errors.some((e) => e.includes("'pitch'")));
  const r2 = buildStageParams({
    stageType: 'light', templateId: 'three_point', overrides: { key: { intensit: 60 }, fill: { power: 10 } },
  });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.includes("'key.intensit'")));
  assert.ok(r2.errors.some((e) => e.includes("'fill.power'")));
  // 分组值非普通对象同样拒
  const r3 = buildStageParams({ stageType: 'light', templateId: 'three_point', overrides: { key: 80 } });
  assert.equal(r3.ok, false);
});

test('G16 stageTemplates: 整数越界拒——越出闭区间 1 个单位即拒', () => {
  const bad = [
    { stageType: 'camera', templateId: 'tripod', overrides: { x: 1001 } },
    { stageType: 'camera', templateId: 'tripod', overrides: { x: -1001 } },
    { stageType: 'camera', templateId: 'moving', overrides: { z: 5000 } },
    { stageType: 'light', templateId: 'three_point', overrides: { key: { intensity: 101 } } },
    { stageType: 'light', templateId: 'three_point', overrides: { rim: { intensity: -1 } } },
  ];
  for (const opts of bad) {
    const r = buildStageParams(opts);
    assert.equal(r.ok, false, JSON.stringify(opts));
    assert.ok(r.errors.some((e) => e.includes('closed interval')), JSON.stringify(opts));
  }
});

test('G16 stageTemplates: 非整数数值拒（小数/字符串/NaN；整数值 80.0 合法）', () => {
  const bad = [
    { stageType: 'camera', templateId: 'tripod', overrides: { x: 12.5 } },
    { stageType: 'camera', templateId: 'tripod', overrides: { y: '40' } },
    { stageType: 'camera', templateId: 'tripod', overrides: { z: NaN } },
    { stageType: 'light', templateId: 'three_point', overrides: { key: { intensity: 80.5 } } },
    { stageType: 'light', templateId: 'three_point', overrides: { fill: { intensity: '50' } } },
  ];
  for (const opts of bad) {
    const r = buildStageParams(opts);
    assert.equal(r.ok, false, JSON.stringify(opts));
    assert.ok(r.errors.some((e) => e.includes('must be an integer')), JSON.stringify(opts));
  }
  const ok = buildStageParams({ stageType: 'light', templateId: 'three_point', overrides: { key: { intensity: 80.0 } } });
  assert.equal(ok.ok, true);
  assert.equal(ok.params.key.intensity, 80);
});

test('G16 stageTemplates: enum/字符串越界拒——mount 非枚举、color 空串/非串', () => {
  const r1 = buildStageParams({ stageType: 'camera', templateId: 'tripod', overrides: { mount: 'drone' } });
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.includes('mount') && e.includes('tripod, handheld, moving')));
  const r2 = buildStageParams({ stageType: 'light', templateId: 'three_point', overrides: { key: { color: '   ' } } });
  assert.equal(r2.ok, false);
  const r3 = buildStageParams({ stageType: 'light', templateId: 'three_point', overrides: { fill: { color: '' } } });
  assert.equal(r3.ok, false);
  const r4 = buildStageParams({ stageType: 'object', templateId: 'default', overrides: { props: 'chair' } });
  assert.equal(r4.ok, false);
});

test('G16 stageTemplates: 多错误逐条累加不短路、错误全为字符串', () => {
  const r = buildStageParams({
    stageType: 'light', templateId: 'three_point',
    overrides: { unknown1: 1, key: { intensity: 200, unknown2: true } },
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("'unknown1'")));
  assert.ok(r.errors.some((e) => e.includes('key.intensity') && e.includes('closed interval')));
  assert.ok(r.errors.some((e) => e.includes("'key.unknown2'")));
  assert.ok(r.errors.length === 3 && r.errors.every((e) => typeof e === 'string'));
});
