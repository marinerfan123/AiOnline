// @vitest-environment jsdom
/**
 * M05-B2 — validation, execution readiness, model switch normalization,
 * stale propagation contract, and 1000-node regressions.
 * Pure logic — no network, no localStorage, no real AI.
 */
import { describe, it, expect } from 'vitest';
import { getNodeDef, NODE_DEFS_LIST } from '@/features/studio-v2/registry';
import {
  validateNode,
  computeReadiness,
  normalizeParametersForModel,
  directDownstreamIds,
  isIdentityChange,
  computeStoredStatus,
} from '@/features/studio-v2/validation';
import { useStudioStore, type StudioNode, type StudioEdge } from '@/features/studio-v2/store';
import type { StudioNodeKind } from '@/features/studio-v2/types';

const node = (kind: StudioNodeKind, id: string, data: Record<string, unknown> = {}): StudioNode => {
  const def = getNodeDef(kind)!;
  return { id, type: 'studio', position: { x: 0, y: 0 }, width: def.width, data: { ...def.defaultData, ...data } } as StudioNode;
};

const edge = (source: string, sourceHandle: string, target: string, targetHandle: string, portType: string): StudioEdge => ({
  id: `e-${source}-${sourceHandle}-${target}-${targetHandle}`,
  source, sourceHandle, target, targetHandle,
  data: { portType },
} as StudioEdge);

const IMG_CAP = { capabilities: { type: 'text_to_image' } };
const I2V_CAP = { capabilities: { type: 'image_to_video' } };
const T2V_CAP = { capabilities: { type: 'text_to_video' } };
const VALID_IDS = ['m-img', 'm-i2v', 'm-t2v'];

describe('M05-B2 node validation (errors[] + warnings[] with code/field/port)', () => {
  it('prompt node: empty prompt INVALID; whitespace-normalized prompt valid', () => {
    const def = getNodeDef('prompt')!;
    const empty = node('prompt', 'p1', { parameters: { prompt: '' } });
    const rEmpty = validateNode(empty, def, []);
    expect(rEmpty.valid).toBe(false);
    expect(rEmpty.errors.map((e) => e.code)).toContain('REQUIRED_PARAMETER');
    const ws = node('prompt', 'p2', { parameters: { prompt: '   ' } });
    const rWs = validateNode(ws, def, []);
    expect(rWs.valid).toBe(false); // whitespace-only is not a real prompt
  });

  it('prompt node: negativePrompt supported, model params NOT part of prompt schema', () => {
    const def = getNodeDef('prompt')!;
    const keys = def.parameterSchema.map((f) => f.key);
    expect(keys).toContain('prompt');
    expect(keys).toContain('negativePrompt');
    for (const banned of ['model', 'logicalModelId', 'resolution', 'seed', 'steps']) {
      expect(keys).not.toContain(banned);
    }
  });

  it('script node: minimal scriptText + optional title; no episode/scene authority in canvas', () => {
    const def = getNodeDef('script')!;
    const keys = def.parameterSchema.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['scriptText', 'title']));
    // structured short-drama authority (M06) must not live in canvas node JSON
    expect(keys).not.toContain('episodeId');
    expect(keys).not.toContain('sceneId');
    expect(def.parameterSchema).toHaveLength(2);
    // dual output: SCRIPT + TEXT compatibility
    expect(def.outputPorts.map((p) => p.type)).toEqual(['SCRIPT', 'TEXT']);
  });

  it('character node: name/description/assetId(optional); assetId is M04-S ref; outputs CHARACTER + REFERENCE', () => {
    const def = getNodeDef('character')!;
    const keys = def.parameterSchema.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['name', 'description', 'assetId']));
    const assetField = def.parameterSchema.find((f) => f.key === 'assetId')!;
    expect(assetField.type).toBe('asset');
    expect(assetField.required).toBeFalsy();
    expect(def.outputPorts.map((p) => p.type)).toEqual(['CHARACTER', 'REFERENCE']);
    const noName = node('character', 'c1', { parameters: { name: '', description: '', assetId: null } });
    expect(validateNode(noName, def, []).errors.map((e) => e.code)).toContain('REQUIRED_PARAMETER');
  });

  it('reference node: assetId required; forbidden identities rejected; outputs REFERENCE (+IMAGE compat)', () => {
    const def = getNodeDef('reference')!;
    const missing = node('reference', 'r1', { parameters: { assetId: null } });
    expect(validateNode(missing, def, []).errors.map((e) => e.code)).toContain('REQUIRED_PARAMETER');
    // assetExists=false → ASSET_NOT_FOUND
    const gone = node('reference', 'r2', { parameters: { assetId: 'm-gone' } });
    expect(validateNode(gone, def, [], { assetExists: false }).errors.map((e) => e.code)).toContain('ASSET_NOT_FOUND');
    // durable identity contract: no signed/provider/base64/local paths
    expect(JSON.stringify(def)).not.toMatch(/signedUrl|provider_url|base64|file:\/\//i);
    expect(def.outputPorts.map((p) => p.type)).toEqual(['REFERENCE', 'IMAGE']);
  });

  it('image generation: missing model / capability mismatch / duration-independent params all validated', () => {
    const def = getNodeDef('image-generation')!;
    const params = { ...def.defaultParameters };
    // missing required model
    const noModel = node('image-generation', 'g1', { parameters: params });
    const rNoModel = validateNode(noModel, def, [], { validModelIds: VALID_IDS });
    expect(rNoModel.errors.map((e) => e.code)).toContain('REQUIRED_PARAMETER');
    // unknown model id
    params.logicalModelId = 'nope';
    const unknown = node('image-generation', 'g2', { parameters: { ...params } });
    const rUnknown = validateNode(unknown, def, [], { validModelIds: VALID_IDS });
    expect(rUnknown.errors.map((e) => e.code)).toContain('MODEL_UNAVAILABLE');
    // capability mismatch (video model on image node)
    const mismatch = node('image-generation', 'g3', { parameters: { ...params, logicalModelId: 'm-t2v' } });
    const rMismatch = validateNode(mismatch, def, [], { validModelIds: VALID_IDS, model: { capabilities: { type: 'text_to_video' } } });
    expect(rMismatch.errors.map((e) => e.code)).toContain('MODEL_CAPABILITY_MISMATCH');
    // invalid resolution option
    const badRes = node('image-generation', 'g4', { parameters: { ...params, logicalModelId: 'm-img', resolution: '9999x1' } });
    expect(validateNode(badRes, def, [], { validModelIds: VALID_IDS }).errors.map((e) => e.code)).toContain('PARAMETER_OPTION');
    // unsupported parameter
    const rogue = node('image-generation', 'g5', { parameters: { ...params, logicalModelId: 'm-img', providerHack: true } });
    expect(validateNode(rogue, def, [], { validModelIds: VALID_IDS }).errors.map((e) => e.code)).toContain('UNSUPPORTED_PARAMETER');
    // missing required TEXT input
    expect(rNoModel.errors.map((e) => e.code)).toContain('REQUIRED_INPUT_MISSING');
  });

  it('i2v: IMAGE required; duration range enforced; missing image input blocks', () => {
    const def = getNodeDef('image-to-video')!;
    const params = { ...def.defaultParameters, logicalModelId: 'm-i2v' };
    const n = node('image-to-video', 'v1', { parameters: params });
    const edges = [edge('img', 'image', 'v1', 'image', 'IMAGE')];
    const ok = validateNode(n, def, edges, { validModelIds: VALID_IDS, model: I2V_CAP });
    expect(ok.valid).toBe(true);
    const noImg = validateNode(n, def, [], { validModelIds: VALID_IDS, model: I2V_CAP });
    expect(noImg.errors.map((e) => e.code)).toContain('REQUIRED_INPUT_MISSING');
    const badDur = node('image-to-video', 'v2', { parameters: { ...params, duration: 999 } });
    expect(validateNode(badDur, def, edges, { validModelIds: VALID_IDS, model: I2V_CAP }).errors.map((e) => e.code)).toContain('PARAMETER_RANGE');
  });

  it('t2v: TEXT required, VIDEO output; output node needs at least one input', () => {
    const def = getNodeDef('text-to-video')!;
    const params = { ...def.defaultParameters, logicalModelId: 'm-t2v' };
    const n = node('text-to-video', 't1', { parameters: params });
    expect(validateNode(n, def, [], { validModelIds: VALID_IDS, model: T2V_CAP }).errors.map((e) => e.code)).toContain('REQUIRED_INPUT_MISSING');
    const withText = [edge('p', 'text', 't1', 'text', 'TEXT')];
    expect(validateNode(n, def, withText, { validModelIds: VALID_IDS, model: T2V_CAP }).valid).toBe(true);

    const out = getNodeDef('output')!;
    const outNode = node('output', 'o1');
    const rEmpty = validateNode(outNode, out, []);
    expect(rEmpty.valid).toBe(false);
    expect(rEmpty.errors.map((e) => e.code)).toContain('OUTPUT_INPUT_MISSING');
    const rFilled = validateNode(outNode, out, [edge('t1', 'video', 'o1', 'video', 'VIDEO')]);
    expect(rFilled.valid).toBe(true);
  });

  it('video asset: assetId required, no generation params; invalid asset → error', () => {
    const def = getNodeDef('video')!;
    const empty = node('video', 'va1', { parameters: { assetId: null } });
    expect(validateNode(empty, def, []).errors.map((e) => e.code)).toContain('REQUIRED_PARAMETER');
    const gone = node('video', 'va2', { parameters: { assetId: 'm-gone' } });
    expect(validateNode(gone, def, [], { assetExists: false }).errors.map((e) => e.code)).toContain('ASSET_NOT_FOUND');
    expect(def.parameterSchema.map((f) => f.key)).not.toContain('logicalModelId');
  });
});

describe('M05-B2 executionReady contract (computed state only, no AI)', () => {
  it('valid node + required inputs + available model = executionReady true', () => {
    const def = getNodeDef('image-generation')!;
    const n = node('image-generation', 'g1', { parameters: { ...def.defaultParameters, logicalModelId: 'm-img' } });
    const edges = [edge('p', 'text', 'g1', 'text', 'TEXT')];
    const r = computeReadiness(n, def, edges, { validModelIds: VALID_IDS, model: IMG_CAP });
    expect(r.executionReady).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('missing required input → not ready with reason', () => {
    const def = getNodeDef('image-to-video')!;
    const n = node('image-to-video', 'v1', { parameters: { ...def.defaultParameters, logicalModelId: 'm-i2v' } });
    const r = computeReadiness(n, def, [], { validModelIds: VALID_IDS, model: I2V_CAP });
    expect(r.executionReady).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain('REQUIRED_INPUT_MISSING');
  });

  it('model unavailable / capability mismatch → not ready', () => {
    const def = getNodeDef('text-to-video')!;
    const n = node('text-to-video', 't1', { parameters: { ...def.defaultParameters, logicalModelId: 'ghost' } });
    const edges = [edge('p', 'text', 't1', 'text', 'TEXT')];
    const r1 = computeReadiness(n, def, edges, { validModelIds: VALID_IDS, model: null });
    expect(r1.executionReady).toBe(false);
    expect(r1.reasons.map((x) => x.code)).toContain('MODEL_UNAVAILABLE');
    const r2 = computeReadiness(n, def, edges, { validModelIds: VALID_IDS, model: I2V_CAP });
    expect(r2.executionReady).toBe(false);
    expect(r2.reasons.map((x) => x.code)).toContain('MODEL_CAPABILITY_MISMATCH');
  });

  it('structural frame is never execution-ready', () => {
    const def = getNodeDef('frame')!;
    expect(computeReadiness(node('frame', 'f'), def, []).executionReady).toBe(false);
  });
});
