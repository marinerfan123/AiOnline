// @vitest-environment jsdom
/**
 * M05-B2 — Production Core Nodes: registry, executionKind, typed ports,
 * validation, execution readiness, model normalization, stale contract.
 * Pure logic + node-local validation — no network, no localStorage, no real AI.
 */
import { describe, it, expect } from 'vitest';
import {
  NODE_DEFS,
  NODE_DEFS_LIST,
  getNodeDef,
  canConnect,
  canConnectToPort,
  librarySectionOf,
  getEffectiveParameterSchema,
} from '@/features/studio-v2/registry';
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

describe('M05-B2 production core node set', () => {
  const EXPECTED_IDS: StudioNodeKind[] = [
    // Blueprint V2.0 G03 base kinds (7: text/image/video/audio/script/storyboard/video-clip)
    'text', 'image', 'video', 'audio', 'script', 'storyboard', 'video-clip',
    // Legacy M05 identities preserved (additive — persisted canvases untouched)
    'prompt', 'character', 'reference',
    'image-generation', 'image-to-video', 'text-to-video',
    'output', 'frame',
  ];

  it('registers the Blueprint G03 base kinds + legacy M05 identities (15 total; stable ids, no UI-label identity)', () => {
    expect(NODE_DEFS_LIST.map((d) => d.id).sort()).toEqual([...EXPECTED_IDS].sort());
    for (const id of EXPECTED_IDS) {
      const def = NODE_DEFS[id as StudioNodeKind];
      expect(def, `missing def for ${id}`).toBeTruthy();
      expect(def.id).toBe(id);
      // UI label is display-only; identity is the registry id
      expect(def.title.length).toBeGreaterThan(0);
      expect(def.title).not.toBe(id);
    }
  });

  it('every def declares an executionKind (DAG compiler contract, never name-guessed)', () => {
    const allowed = ['SOURCE', 'TRANSFORM', 'GENERATION', 'ASSET', 'OUTPUT', 'STRUCTURAL'];
    for (const def of NODE_DEFS_LIST) {
      expect(allowed).toContain(def.executionKind);
      expect(def.isGeneration).toBe(def.executionKind === 'GENERATION');
      expect(def.modelField === null).toBe(!def.isGeneration);
    }
  });

  it('image-generation vs video-asset semantics are distinct business types', () => {
    const gen = getNodeDef('image-generation')!;
    const asset = getNodeDef('video')!;
    expect(gen.executionKind).toBe('GENERATION');
    expect(gen.capabilityRequirements).toEqual(['text_to_image']);
    expect(gen.parameterSchema.map((f) => f.key)).toContain('logicalModelId');
    expect(asset.executionKind).toBe('ASSET');
    expect(asset.capabilityRequirements).toEqual([]);
    expect(asset.parameterSchema.map((f) => f.key)).not.toContain('logicalModelId');
    expect(asset.parameterSchema.map((f) => f.key)).toContain('assetId');
    // video asset never exposes generation model parameters
    expect(JSON.stringify(asset)).not.toMatch(/logicalModelId/i);
  });

  it('i2v / t2v reuse the formal M02 capabilities and required inputs', () => {
    const i2v = getNodeDef('image-to-video')!;
    const t2v = getNodeDef('text-to-video')!;
    expect(i2v.capabilityRequirements).toEqual(['image_to_video']);
    expect(i2v.inputPorts.find((p) => p.id === 'image')?.required).toBe(true);
    expect(t2v.capabilityRequirements).toEqual(['text_to_video']);
    expect(t2v.inputPorts.find((p) => p.id === 'text')?.required).toBe(true);
    // both output VIDEO, both provider-neutral (no provider fields anywhere)
    expect(i2v.outputPorts.map((p) => p.type)).toEqual(['VIDEO']);
    expect(t2v.outputPorts.map((p) => p.type)).toEqual(['VIDEO']);
    for (const def of [i2v, t2v]) {
      expect(JSON.stringify(def)).not.toMatch(/apiKey|credential|provider_model_code|binding_id|base_url/i);
    }
  });

  it('frame is structural: no ports, non-executable, never enters DAG tasks', () => {
    const frame = getNodeDef('frame')!;
    expect(frame.executionKind).toBe('STRUCTURAL');
    expect(frame.inputPorts).toEqual([]);
    expect(frame.outputPorts).toEqual([]);
    expect(computeStoredStatus(node('frame', 'f'), frame, [])).toBe('IDLE');
    const r = computeReadiness(node('frame', 'f'), frame, []);
    expect(r.executionReady).toBe(false);
    expect(r.reasons.map((x) => x.code)).toContain('STRUCTURAL_NODE');
  });

  it('node library sections derive from the registry (no hardcoded second list)', () => {
    expect(librarySectionOf(getNodeDef('prompt')!)).toBe('INPUT');
    expect(librarySectionOf(getNodeDef('character')!)).toBe('CREATIVE');
    expect(librarySectionOf(getNodeDef('image-generation')!)).toBe('GENERATE');
    expect(librarySectionOf(getNodeDef('image-to-video')!)).toBe('GENERATE');
    expect(librarySectionOf(getNodeDef('text-to-video')!)).toBe('GENERATE');
    expect(librarySectionOf(getNodeDef('video')!)).toBe('MEDIA');
    expect(librarySectionOf(getNodeDef('output')!)).toBe('OUTPUT');
    expect(librarySectionOf(getNodeDef('frame')!)).toBe('STRUCTURE');
  });
});

describe('M05-B2 typed ports + connection gating', () => {
  it('legal matrix (port-level acceptedTypes + base table)', () => {
    // TEXT → Image Generation prompt
    expect(canConnect('TEXT', 'TEXT')).toBe(true);
    // CHARACTER → generation reference port (acceptedTypes includes CHARACTER)
    const gen = getNodeDef('image-generation')!;
    const refPort = gen.inputPorts.find((p) => p.id === 'reference')!;
    expect(refPort.acceptedTypes).toEqual(['REFERENCE', 'CHARACTER']);
    expect(canConnectToPort('CHARACTER', refPort)).toBe(true);
    expect(canConnectToPort('REFERENCE', refPort)).toBe(true);
    // REFERENCE → plain REFERENCE port (base table)
    expect(canConnect('REFERENCE', 'REFERENCE')).toBe(true);
    // VIDEO → Output video port
    const out = getNodeDef('output')!;
    expect(canConnectToPort('VIDEO', out.inputPorts.find((p) => p.id === 'video')!)).toBe(true);
  });

  it('illegal matrix: IMAGE/TEXT → Video Asset, VIDEO → Image Generation image, IMAGE → REFERENCE port', () => {
    const asset = getNodeDef('video')!;
    const videoIn = asset.inputPorts.find((p) => p.id === 'video')!;
    expect(canConnectToPort('IMAGE', videoIn)).toBe(false);
    expect(canConnectToPort('TEXT', videoIn)).toBe(false);
    const gen = getNodeDef('image-generation')!;
    const imageIn = gen.inputPorts.find((p) => p.id === 'image')!;
    expect(canConnectToPort('VIDEO', imageIn)).toBe(false);
    // REFERENCE port on a generation node does NOT accept raw IMAGE generically
    const refPort = gen.inputPorts.find((p) => p.id === 'reference')!;
    expect(canConnectToPort('IMAGE', refPort)).toBe(false);
  });

  it('onConnect creates no edge for illegal connections and sets feedback', () => {
    useStudioStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [] });
    const gen = node('image-generation', 'gen', { parameters: { ...getNodeDef('image-generation')!.defaultParameters, logicalModelId: 'm1', prompt: '' } });
    const asset = node('video', 'va');
    useStudioStore.setState({ nodes: [gen, asset] });
    // VIDEO (video-asset output) → image-generation reference port: illegal
    useStudioStore.getState().onConnect({ source: 'va', target: 'gen', sourceHandle: 'video', targetHandle: 'reference' });
    expect(useStudioStore.getState().edges.length).toBe(0);
    expect(useStudioStore.getState().invalidConnection).not.toBeNull();
  });
});
