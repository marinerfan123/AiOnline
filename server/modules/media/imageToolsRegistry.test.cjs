'use strict';
/**
 * G09 — Image Tools Contract Registry: tests.
 * Coverage: contract metadata + load lint, isNative classification, unknown
 * kind / malformed request rejection, per-tool missing / wrong-type / valid
 * cases (every tool: ≥1 of each), closed-interval boundaries, region member
 * validation, annotate text cap, unit-naming lint policy.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TOOL_DEFS, KINDS, NATIVE_KINDS,
  getToolDef, isNative, validateToolRequest,
  lintToolDef, lintToolDefs,
} = require('./imageToolsRegistry.cjs');

const okR = (r) => assert.equal(r.ok, true, JSON.stringify(r));
const badR = (r) => {
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.errors) && r.errors.length > 0, 'expected non-empty errors array');
  return r.errors;
};
const errHas = (r, needle) => {
  const errors = badR(r);
  assert.ok(errors.some((e) => e.includes(needle)),
    `expected an error containing "${needle}", got: ${JSON.stringify(errors)}`);
};

/* ------------------------------------------------------------------ */
/* Contract metadata + load-time lint                                  */
/* ------------------------------------------------------------------ */

test('G09 registry: exactly the 9 image tool kinds, unique, complete defs', () => {
  const expected = ['enhance', 'outpaint', 'relight', 'inpaint', 'remove-bg',
    'upscale', 'grid', 'annotate', 'focus'];
  assert.deepEqual([...KINDS].sort(), [...expected].sort());
  assert.equal(new Set(KINDS).size, 9);
  for (const def of TOOL_DEFS) {
    assert.equal(typeof def.displayName, 'string');
    assert.ok(def.displayName.length > 0);
    assert.ok(Array.isArray(def.paramSchema.fields) && def.paramSchema.fields.length > 0);
    assert.ok(def.providerHint && typeof def.providerHint.requiresProvider === 'boolean');
    assert.ok(typeof def.providerHint.why === 'string' && def.providerHint.why.length > 0);
    assert.equal(def.executorStatus, 'NOT_IMPLEMENTED'); // honest: executors still missing
    assert.equal(def.paramSchema, getToolDef(def.kind).paramSchema);
  }
});

test('G09 registry: providerHint matches isNative for every tool', () => {
  for (const def of TOOL_DEFS) {
    assert.equal(def.providerHint.requiresProvider, !isNative(def.kind),
      `kind ${def.kind}: requiresProvider must equal !isNative`);
  }
});

test('G09 registry: all definitions pass the load-time contract lint', () => {
  assert.deepEqual(lintToolDefs(TOOL_DEFS), []);
});

/* ------------------------------------------------------------------ */
/* isNative classification                                             */
/* ------------------------------------------------------------------ */

test('G09 isNative: annotate / focus / grid are native (no provider)', () => {
  for (const k of ['annotate', 'focus', 'grid']) {
    assert.equal(isNative(k), true, `${k} must be native`);
    assert.equal(getToolDef(k).providerHint.requiresProvider, false);
  }
});

test('G09 isNative: model-backed tools are NOT native', () => {
  for (const k of ['enhance', 'outpaint', 'relight', 'inpaint', 'remove-bg', 'upscale']) {
    assert.equal(isNative(k), false, `${k} must not be native`);
    assert.equal(getToolDef(k).providerHint.requiresProvider, true);
  }
});

test('G09 isNative: unknown / missing kind is not native', () => {
  assert.equal(isNative('bogus'), false);
  assert.equal(isNative(''), false);
  assert.equal(isNative(undefined), false);
  assert.equal(isNative(null), false);
});

test('G09 isNative: NATIVE_KINDS export lists exactly the native three', () => {
  assert.deepEqual([...NATIVE_KINDS].sort(), ['annotate', 'focus', 'grid']);
});

/* ------------------------------------------------------------------ */
/* Unknown kind / malformed request                                    */
/* ------------------------------------------------------------------ */

test('G09 validate: unknown kind is rejected', () => {
  errHas(validateToolRequest({ kind: 'bogus', params: {} }), 'unknown tool kind "bogus"');
  errHas(validateToolRequest({ kind: 'ENHANCE', params: {} }), 'unknown tool kind');
});

test('G09 validate: missing kind is rejected', () => {
  badR(validateToolRequest({ params: {} }));
  badR(validateToolRequest({}));
  badR(validateToolRequest(null));
  badR(validateToolRequest([]));
});

test('G09 validate: params must be a plain object (missing/array/primitive/null rejected)', () => {
  badR(validateToolRequest({ kind: 'enhance' })); // params absent
  errHas(validateToolRequest({ kind: 'enhance', params: undefined }), 'params is required');
  errHas(validateToolRequest({ kind: 'enhance', params: null }), 'params is required');
  errHas(validateToolRequest({ kind: 'enhance', params: [1, 2] }), 'plain object');
  errHas(validateToolRequest({ kind: 'enhance', params: 'x' }), 'plain object');
  errHas(validateToolRequest({ kind: 'enhance', params: 42 }), 'plain object');
});

test('G09 validate: unknown extra params are rejected (typo guard)', () => {
  errHas(validateToolRequest({ kind: 'outpaint', params: { extendPx: 10, blur: 1 } }),
    'unknown param "blur"');
  errHas(validateToolRequest({ kind: 'annotate', params: { text: 'ok', txt: 'typo' } }),
    'unknown param "txt"');
});

/* ------------------------------------------------------------------ */
/* Per-tool: missing / wrong-type / valid                              */
/* ------------------------------------------------------------------ */

const VALID = {
  enhance: { strength: 0.8, prompt: 'crisp details' },
  outpaint: { extendPx: 128, direction: 'right', prompt: 'street continues' },
  relight: { prompt: 'warm golden side light', lightDirection: 'side' },
  inpaint: { region: { x: 10, y: 10, w: 200, h: 150 }, prompt: '' }, // '' = erase
  'remove-bg': { background: 'white', featherPx: 8 },
  upscale: { scale: 2, mode: 'photo' },
  grid: { rows: 2, cols: 3 },
  annotate: { text: 'Scene 1', fontSizePx: 48, x: 0, y: 0, opacity: 0.9 },
  focus: { region: { x: 1, y: 1, w: 320, h: 240 }, strength: 50 },
};

const WRONG_TYPE = {
  enhance: { strength: '0.8' },
  outpaint: { extendPx: '128' },
  relight: { prompt: 123 },
  inpaint: { region: { x: 10, y: 10, w: 'a', h: 150 } },
  'remove-bg': { featherPx: '8' },
  upscale: { scale: '2' },
  grid: { rows: 2, cols: '3' },
  annotate: { text: 42 },
  focus: { region: 'whole image' },
};

// Kinds with no required params at all (contract allows {}) vs kinds that
// demand ≥1 required field.
const NO_REQUIRED = new Set(['enhance', 'remove-bg']);

for (const kind of KINDS) {
  test(`G09 per-tool [${kind}]: request with missing params object is rejected (缺参)`, () => {
    badR(validateToolRequest({ kind, params: undefined }));
    badR(validateToolRequest({ kind }));
  });

  test(`G09 per-tool [${kind}]: empty params {} behaves per contract (缺参/合法)`, () => {
    const r = validateToolRequest({ kind, params: {} });
    if (NO_REQUIRED.has(kind)) {
      assert.equal(r.ok, true, `{} must be a valid ${kind} request (no required params)`);
    } else {
      badR(r);
    }
  });

  test(`G09 per-tool [${kind}]: wrong param type is rejected (错型)`, () => {
    errHas(validateToolRequest({ kind, params: WRONG_TYPE[kind] }), 'must be');
  });

  test(`G09 per-tool [${kind}]: a valid request passes (合法)`, () => {
    okR(validateToolRequest({ kind, params: VALID[kind] }));
    assert.ok(getToolDef(kind), `def resolvable for ${kind}`);
  });
}

/* ------------------------------------------------------------------ */
/* Required fields + closed-interval boundaries                        */
/* ------------------------------------------------------------------ */

test('G09 validate: missing required fields are reported per field', () => {
  errHas(validateToolRequest({ kind: 'outpaint', params: {} }), 'param "extendPx" is required');
  errHas(validateToolRequest({ kind: 'upscale', params: {} }), 'param "scale" is required');
  errHas(validateToolRequest({ kind: 'relight', params: {} }), 'param "prompt" is required');
  errHas(validateToolRequest({ kind: 'grid', params: { rows: 2 } }), 'param "cols" is required');
  errHas(validateToolRequest({ kind: 'inpaint', params: {} }), 'param "region" is required');
  errHas(validateToolRequest({ kind: 'annotate', params: {} }), 'param "text" is required');
  errHas(validateToolRequest({ kind: 'focus', params: {} }), 'param "region" is required');
});

test('G09 validate: outpaint extendPx integer + closed interval [1, 2048]', () => {
  okR(validateToolRequest({ kind: 'outpaint', params: { extendPx: 1 } }));
  okR(validateToolRequest({ kind: 'outpaint', params: { extendPx: 2048 } }));
  errHas(validateToolRequest({ kind: 'outpaint', params: { extendPx: 0 } }), 'extendPx');
  errHas(validateToolRequest({ kind: 'outpaint', params: { extendPx: 2049 } }), 'extendPx');
  errHas(validateToolRequest({ kind: 'outpaint', params: { extendPx: 12.5 } }), 'extendPx');
  errHas(validateToolRequest({ kind: 'outpaint', params: { extendPx: 'x' } }), 'extendPx');
});

test('G09 validate: upscale scale integer in closed interval [2, 4]', () => {
  okR(validateToolRequest({ kind: 'upscale', params: { scale: 2 } }));
  okR(validateToolRequest({ kind: 'upscale', params: { scale: 4 } }));
  errHas(validateToolRequest({ kind: 'upscale', params: { scale: 1 } }), 'scale');
  errHas(validateToolRequest({ kind: 'upscale', params: { scale: 5 } }), 'scale');
  errHas(validateToolRequest({ kind: 'upscale', params: { scale: 3.5 } }), 'scale');
});

test('G09 validate: grid rows/cols integers in closed interval [1, 10]', () => {
  okR(validateToolRequest({ kind: 'grid', params: { rows: 1, cols: 1 } }));
  okR(validateToolRequest({ kind: 'grid', params: { rows: 10, cols: 10 } }));
  errHas(validateToolRequest({ kind: 'grid', params: { rows: 0, cols: 3 } }), 'rows');
  errHas(validateToolRequest({ kind: 'grid', params: { rows: 11, cols: 3 } }), 'rows');
  errHas(validateToolRequest({ kind: 'grid', params: { rows: 2.5, cols: 3 } }), 'rows');
});

test('G09 validate: fractional strength fields respect closed [0, 1] ratio', () => {
  okR(validateToolRequest({ kind: 'enhance', params: { strength: 0 } }));
  okR(validateToolRequest({ kind: 'enhance', params: { strength: 1 } }));
  errHas(validateToolRequest({ kind: 'enhance', params: { strength: 1.01 } }), 'strength');
  errHas(validateToolRequest({ kind: 'enhance', params: { strength: -0.01 } }), 'strength');
  errHas(validateToolRequest({ kind: 'annotate', params: { text: 'x', opacity: 1.5 } }), 'opacity');
});

test('G09 validate: integer px fields respect closed intervals (feather/fontSize)', () => {
  okR(validateToolRequest({ kind: 'remove-bg', params: { featherPx: 0 } }));
  okR(validateToolRequest({ kind: 'remove-bg', params: { featherPx: 64 } }));
  errHas(validateToolRequest({ kind: 'remove-bg', params: { featherPx: 65 } }), 'featherPx');
  errHas(validateToolRequest({ kind: 'remove-bg', params: { featherPx: -1 } }), 'featherPx');
  okR(validateToolRequest({ kind: 'annotate', params: { text: 'x', fontSizePx: 8 } }));
  okR(validateToolRequest({ kind: 'annotate', params: { text: 'x', fontSizePx: 200 } }));
  errHas(validateToolRequest({ kind: 'annotate', params: { text: 'x', fontSizePx: 201 } }), 'fontSizePx');
  errHas(validateToolRequest({ kind: 'annotate', params: { text: 'x', fontSizePx: 7 } }), 'fontSizePx');
});

test('G09 validate: enum params reject out-of-list values', () => {
  errHas(validateToolRequest({ kind: 'outpaint', params: { extendPx: 10, direction: 'diagonal' } }),
    'direction');
  errHas(validateToolRequest({ kind: 'remove-bg', params: { background: 'blue' } }), 'background');
  errHas(validateToolRequest({ kind: 'relight', params: { prompt: 'x', lightDirection: 'under' } }),
    'lightDirection');
  errHas(validateToolRequest({ kind: 'upscale', params: { scale: 2, mode: 'hdr' } }), 'mode');
});

/* ------------------------------------------------------------------ */
/* Region { x, y, w, h } — integers, each > 0                         */
/* ------------------------------------------------------------------ */

test('G09 validate: region accepts an all-integer positive rect', () => {
  okR(validateToolRequest({ kind: 'inpaint', params: { region: { x: 1, y: 1, w: 1, h: 1 } } }));
  okR(validateToolRequest({ kind: 'inpaint', params: { region: { x: 50, y: 60, w: 400, h: 300 } } }));
  okR(validateToolRequest({ kind: 'focus', params: { region: { x: 2, y: 3, w: 99, h: 88 } } }));
});

test('G09 validate: region members must be integers (错型)', () => {
  errHas(validateToolRequest({
    kind: 'inpaint', params: { region: { x: 1.5, y: 1, w: 10, h: 10 } },
  }), 'region.x');
  errHas(validateToolRequest({
    kind: 'focus', params: { region: { x: 1, y: 1, w: '10', h: 10 } },
  }), 'region.w');
  errHas(validateToolRequest({
    kind: 'inpaint', params: { region: { x: 1, y: 1, w: 10, h: null } },
  }), 'region.h');
});

test('G09 validate: region members must be > 0 (0 and negative rejected)', () => {
  errHas(validateToolRequest({
    kind: 'inpaint', params: { region: { x: 0, y: 1, w: 10, h: 10 } },
  }), 'region.x');
  errHas(validateToolRequest({
    kind: 'inpaint', params: { region: { x: 1, y: -2, w: 10, h: 10 } },
  }), 'region.y');
  errHas(validateToolRequest({
    kind: 'focus', params: { region: { x: 1, y: 1, w: 0, h: 10 } },
  }), 'region.w');
  errHas(validateToolRequest({
    kind: 'inpaint', params: { region: { x: 1, y: 1, w: 100001, h: 10 } },
  }), 'region.w');
});

test('G09 validate: region must be a plain object with all four members', () => {
  badR(validateToolRequest({ kind: 'inpaint', params: { region: null } }));
  badR(validateToolRequest({ kind: 'inpaint', params: { region: [1, 2, 3, 4] } }));
  errHas(validateToolRequest({ kind: 'inpaint', params: { region: {} } }), 'region.x');
  errHas(validateToolRequest({ kind: 'inpaint', params: { region: { x: 1, y: 1 } } }), 'region.w');
  errHas(validateToolRequest({
    kind: 'inpaint', params: { region: { x: 1, y: 1, w: 10, h: 10, z: 3 } },
  }), 'unknown member "z"');
});

/* ------------------------------------------------------------------ */
/* annotate text: required, non-empty, ≤ 500                          */
/* ------------------------------------------------------------------ */

test('G09 validate: annotate text is required and must be non-empty', () => {
  errHas(validateToolRequest({ kind: 'annotate', params: { text: '' } }),
    'non-empty');
  errHas(validateToolRequest({ kind: 'annotate', params: { text: '   ' } }),
    'non-empty');
  errHas(validateToolRequest({ kind: 'relight', params: { prompt: '' } }),
    'non-empty');
});

test('G09 validate: annotate text capped at 500 chars (500 ok / 501 rejected)', () => {
  okR(validateToolRequest({ kind: 'annotate', params: { text: 'x'.repeat(500) } }));
  errHas(validateToolRequest({ kind: 'annotate', params: { text: 'x'.repeat(501) } }),
    '500 chars');
});

/* ------------------------------------------------------------------ */
/* Unit-naming lint policy (integer-ms / seconds)                      */
/* ------------------------------------------------------------------ */

test('G09 lint: integer-ms field must carry the Ms suffix + integer type', () => {
  const good = lintToolDef({
    kind: 't', paramSchema: { fields: [{ key: 'fadeInMs', displayName: 'f', type: 'integer', unit: 'ms', required: false, min: 0 }] },
  });
  assert.deepEqual(good, []);
  const bare = lintToolDef({
    kind: 't', paramSchema: { fields: [{ key: 'fadeIn', displayName: 'f', type: 'integer', unit: 'ms' }] },
  });
  assert.ok(bare.some((v) => v.includes("'Ms'")), JSON.stringify(bare));
  const float = lintToolDef({
    kind: 't', paramSchema: { fields: [{ key: 'durationMs', displayName: 'f', type: 'number', unit: 'ms' }] },
  });
  assert.ok(float.some((v) => v.includes("type 'integer'")), JSON.stringify(float));
});

test('G09 lint: Ms/Sec suffix without matching unit / inverted intervals rejected', () => {
  const noUnit = lintToolDef({
    kind: 't', paramSchema: { fields: [{ key: 'lingerMs', displayName: 'f', type: 'integer', unit: 'px' }] },
  });
  assert.ok(noUnit.some((v) => v.includes('unit must be')), JSON.stringify(noUnit));
  const sec = lintToolDef({
    kind: 't', paramSchema: { fields: [{ key: 'waitSec', displayName: 'f', type: 'integer', unit: 'sec', min: 1 }] },
  });
  assert.deepEqual(sec, []);
  const inverted = lintToolDef({
    kind: 't', paramSchema: { fields: [{ key: 'n', displayName: 'f', type: 'integer', min: 10, max: 1 }] },
  });
  assert.ok(inverted.some((v) => v.includes('inverted')), JSON.stringify(inverted));
});

test('G09 lint: unknown type / unit / enum without values are flagged', () => {
  const t = lintToolDef({
    kind: 't', paramSchema: { fields: [{ key: 'a', displayName: 'f', type: 'frobnicate' }] },
  });
  assert.ok(t.some((v) => v.includes('unknown type')), JSON.stringify(t));
  const u = lintToolDef({
    kind: 't', paramSchema: { fields: [{ key: 'b', displayName: 'f', type: 'integer', unit: 'meters' }] },
  });
  assert.ok(u.some((v) => v.includes('unknown unit')), JSON.stringify(u));
  const e = lintToolDef({
    kind: 't', paramSchema: { fields: [{ key: 'c', displayName: 'f', type: 'enum' }] },
  });
  assert.ok(e.some((v) => v.includes('enum list')), JSON.stringify(e));
});

test('G09 lint: registry schemas declare an explicit unit on every numeric field', () => {
  for (const def of TOOL_DEFS) {
    for (const f of def.paramSchema.fields) {
      if (['integer', 'number'].includes(f.type)) {
        assert.ok(f.unit, `field "${f.key}" of ${def.kind} must declare an explicit unit`);
      }
    }
  }
});
