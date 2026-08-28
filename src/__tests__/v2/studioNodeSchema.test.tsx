// @vitest-environment jsdom
/** M05-B1 — Production node schema + parameter inspector contract. */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NODE_DEFS_LIST, getNodeDef, getEffectiveParameterSchema } from '@/features/studio-v2/registry';
import { validateNode, validateParameterValue } from '@/features/studio-v2/validation';
import { ParameterInspector } from '@/features/studio-v2/ParameterInspector';
import { useStudioStore, type StudioNode } from '@/features/studio-v2/store';
import { v2ai } from '@/shared/api/contract/ai-control-client';
import type { StudioNodeKind } from '@/features/studio-v2/types';

vi.mock('@/shared/api/contract/ai-control-client', async () => {
  const actual = await vi.importActual<any>('@/shared/api/contract/ai-control-client');
  return { ...actual, v2ai: { ...actual.v2ai, listModels: vi.fn() } };
});

function qc(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const node = (kind: StudioNodeKind, id = 'n1', data: Record<string, unknown> = {}): StudioNode => {
  const def = getNodeDef(kind)!;
  return { id, type: 'studio', position: { x: 0, y: 0 }, width: def.width, data: { ...def.defaultData, ...data } } as StudioNode;
};

function reset(nodes: StudioNode[] = []) {
  useStudioStore.setState({ nodes, edges: [], viewport: { x: 0, y: 0, zoom: 1 }, undoStack: [], redoStack: [], clipboard: null, invalidConnection: null, dragSnapshot: null, editSnapshot: null });
}

beforeEach(() => { vi.clearAllMocks(); reset(); });
afterEach(cleanup);

describe('NodeDefinition V2 registry contract', () => {
  it('every node has versioned production schema contracts', () => {
    for (const def of NODE_DEFS_LIST) {
      expect(def.version).toBe(1);
      expect(def.parameterSchema).toEqual(expect.any(Array));
      expect(def.defaultParameters).toEqual(expect.any(Object));
      expect(def.capabilityRequirements).toEqual(expect.any(Array));
      expect(def.executorContract).toBeTruthy();
      expect(def.resultContract).toBeTruthy();
      expect(def.migrationHandler).toBeTruthy();
      expect(def.costEstimatorContract).toBeTruthy();
      expect(def.validator).toEqual(expect.any(Function));
      expect(def.inspector).toMatchObject({ renderer: 'schema' });
      expect(def.defaultData.schemaVersion).toBe(def.version);
      expect(def.defaultData.parameters).toEqual(def.defaultParameters);
    }
  });

  it('image node is schema/capability driven without provider credential fields', () => {
    const image = getNodeDef('image')!;
    expect(image.capabilityRequirements).toContain('text_to_image');
    expect(image.parameterSchema.map((f) => f.key)).toEqual(expect.arrayContaining(['logicalModelId', 'aspectRatio', 'resolution', 'seed']));
    expect(JSON.stringify(image)).not.toMatch(/apiKey|credential|provider_model_code|binding_id/i);
  });

  it('video remains a video asset node, not a fake generation node', () => {
    const video = getNodeDef('video')!;
    expect(video.capabilityRequirements).toEqual([]);
    expect(video.description).toMatch(/素材|Asset/i);
    expect(video.parameterSchema.map((f) => f.key)).toContain('assetId');
    expect(video.parameterSchema.map((f) => f.key)).not.toContain('logicalModelId');
  });
});

describe('Parameter validation and effective schema', () => {
  it('validates required/range/unsupported fields with structured errors', () => {
    const def = getNodeDef('image')!;
    const invalid = { logicalModelId: '', aspectRatio: '1:1', resolution: '1024x1024', seed: 999999999999, rogue: true };
    const result = validateNode(node('image', 'img1', { parameters: invalid }), def);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(expect.arrayContaining(['REQUIRED_PARAMETER', 'PARAMETER_RANGE', 'UNSUPPORTED_PARAMETER']));
    expect(result.errors.every((e) => e.field || e.port || e.code)).toBe(true);
  });

  it('validates individual schema values', () => {
    const seed = getNodeDef('image')!.parameterSchema.find((f) => f.key === 'seed')!;
    expect(validateParameterValue(seed, 123).valid).toBe(true);
    expect(validateParameterValue(seed, -2).errors[0].code).toBe('PARAMETER_RANGE');
  });

  it('merges logical model constraints without mutating base schema', () => {
    const base = getNodeDef('image')!;
    const effective = getEffectiveParameterSchema(base, { parameter_schema: { fields: { seed: { disabled: true }, steps: { type: 'integer', label: 'Steps', min: 1, max: 50 } } } });
    expect(effective.find((f) => f.key === 'seed')?.disabledWhen).toBeTruthy();
    expect(effective.find((f) => f.key === 'steps')?.key).toBe('steps');
    expect(base.parameterSchema.find((f) => f.key === 'steps')).toBeUndefined();
  });
});

describe('Schema-driven ParameterInspector', () => {
  it('renders prompt textarea from schema and updates parameters immutably', () => {
    const n = node('prompt', 'p1');
    reset([n]);
    render(qc(<ParameterInspector node={n} def={getNodeDef('prompt')!} projectId="proj-1" />));
    const textarea = screen.getByLabelText('Prompt Text') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'cinematic prompt' } });
    expect(useStudioStore.getState().nodes[0].data.parameters.prompt).toBe('cinematic prompt');
    expect(useStudioStore.getState().nodes[0].data.prompt).toBe('cinematic prompt');
  });

  it('loads logical models from M02 user-safe catalog and filters by capability', async () => {
    vi.mocked(v2ai.listModels).mockResolvedValueOnce([
      { model_id: 'img-safe', display_name: 'Image Safe', type: 'image', enabled: true, capabilities: { type: 'text_to_image' }, bindings: [] },
      { model_id: 'vid-safe', display_name: 'Video Safe', type: 'video', enabled: true, capabilities: { type: 'text_to_video' }, bindings: [] },
    ] as any);
    const n = node('image', 'img1');
    reset([n]);
    render(qc(<ParameterInspector node={n} def={getNodeDef('image')!} projectId="proj-1" />));
    const model = await screen.findByLabelText('Logical Model');
    expect(model.textContent).toContain('Image Safe');
    expect(model.textContent).not.toContain('Video Safe');
    fireEvent.change(model, { target: { value: 'img-safe' } });
    expect(useStudioStore.getState().nodes[0].data.parameters.logicalModelId).toBe('img-safe');
  });

  it('shows model loading empty and error states with retry', async () => {
    vi.mocked(v2ai.listModels).mockRejectedValueOnce(new Error('boom'));
    const n = node('image', 'img1');
    render(qc(<ParameterInspector node={n} def={getNodeDef('image')!} projectId="proj-1" />));
    expect(await screen.findByText('模型加载失败')).toBeTruthy();
    expect(screen.getByRole('button', { name: /重试/ })).toBeTruthy();

    cleanup();
    vi.mocked(v2ai.listModels).mockResolvedValueOnce([] as any);
    render(qc(<ParameterInspector node={n} def={getNodeDef('image')!} projectId="proj-1" />));
    expect(await screen.findByText('没有可用 Logical Model')).toBeTruthy();
  });
});
