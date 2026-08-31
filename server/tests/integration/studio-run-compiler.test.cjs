'use strict';
/**
 * M05-D1 — Studio DAG compiler unit tests (pure function; no DB required).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { compileStudioGraph } = require('../../modules/project-foundation/studioRunGraph.cjs');

const promptNode = (id, prompt = 'hello world') => ({
  nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1,
  data: { nodeKind: 'prompt', nodeType: 'prompt', schemaVersion: 1, status: 'READY', parameters: { prompt }, prompt },
});
const imageGenNode = (id, model = 'logical-model-x') => ({
  nodeId: id, nodeType: 'image-generation', nodeSchemaVersion: 1,
  data: { nodeKind: 'image-generation', schemaVersion: 1, status: 'READY', parameters: { logicalModelId: model, aspectRatio: '1:1', resolution: '1024x1024' } },
});
const outputNode = (id) => ({
  nodeId: id, nodeType: 'output', nodeSchemaVersion: 1,
  data: { nodeKind: 'output', schemaVersion: 1, status: 'READY', parameters: { label: 'Out' } },
});
const frameNode = (id) => ({
  nodeId: id, nodeType: 'frame', nodeSchemaVersion: 1,
  data: { nodeKind: 'frame', schemaVersion: 1, status: 'IDLE', parameters: { frameLabel: 'F' } },
});
const edge = (id, s, t, sh = 'text', th = 'text') => ({
  edgeId: id, sourceNodeId: s, sourceHandle: sh, targetNodeId: t, targetHandle: th,
});

const base = { canvasId: 'canvas-1', canvasRevision: 10, canvasSchemaVersion: 1, runMode: 'ALL' };

test('compile: valid linear DAG Prompt -> ImageGen -> Output', () => {
  const r = compileStudioGraph({
    ...base,
    nodes: [promptNode('p1'), imageGenNode('img1'), outputNode('o1')],
    edges: [
      edge('e1', 'p1', 'img1', 'text', 'text'),
      edge('e2', 'img1', 'o1', 'image', 'image'),
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.graph.nodeCount, 3);
  assert.deepEqual(r.graph.topologicalOrder, ['p1', 'img1', 'o1']);
  const img = r.graph.nodes.find((n) => n.nodeId === 'img1');
  assert.deepEqual(img.dependencies, ['p1']);
  assert.deepEqual(img.dependents, ['o1']);
  assert.equal(img.executionKind, 'GENERATION');
});

test('compile: cycle detection returns DAG_CYCLE_DETECTED with safe node ids', () => {
  const r = compileStudioGraph({
    ...base,
    nodes: [promptNode('p1'), imageGenNode('img1')],
    edges: [
      edge('e1', 'p1', 'img1', 'text', 'text'),
      edge('e2', 'img1', 'p1', 'image', 'text'), // p1's text port accepts TEXT; img1 outputs IMAGE -> type check first?
    ],
  });
  // image->text is incompatible, so build a type-safe 2-cycle instead:
  const r2 = compileStudioGraph({
    ...base,
    nodes: [promptNode('p1'), promptNode('p2')],
    edges: [
      edge('e1', 'p1', 'p2', 'text', 'text'),
      edge('e2', 'p2', 'p1', 'text', 'text'),
    ],
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'DAG_CYCLE_DETECTED');
  assert.deepEqual(r2.error.nodeIds.sort(), ['p1', 'p2']);
  void r;
});

test('compile: dangling edge rejected', () => {
  const r = compileStudioGraph({
    ...base,
    nodes: [promptNode('p1')],
    edges: [edge('e1', 'p1', 'ghost', 'text', 'text')],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'DANGLING_EDGE');
});

test('compile: unknown node type rejected', () => {
  const r = compileStudioGraph({
    ...base,
    nodes: [{ nodeId: 'x1', nodeType: 'mystery-node', nodeSchemaVersion: 1, data: {} }],
    edges: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UNKNOWN_NODE_TYPE');
});

test('compile: schema version mismatch rejected', () => {
  const r = compileStudioGraph({
    ...base,
    nodes: [{ nodeId: 'x1', nodeType: 'prompt', nodeSchemaVersion: 99, data: {} }],
    edges: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'SCHEMA_VERSION_MISMATCH');
});

test('compile: duplicate edge id rejected', () => {
  const r = compileStudioGraph({
    ...base,
    nodes: [promptNode('p1'), promptNode('p2')],
    edges: [
      edge('e1', 'p1', 'p2', 'text', 'text'),
      edge('e1', 'p1', 'p2', 'text', 'text'),
    ],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'DUPLICATE_EDGE_ID');
});

test('compile: typed edge incompatibility rejected (IMAGE into TEXT port without acceptedTypes)', () => {
  const r = compileStudioGraph({
    ...base,
    nodes: [imageGenNode('img1'), outputNode('o1')],
    edges: [edge('e1', 'img1', 'o1', 'image', 'video')],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'EDGE_TYPE_INCOMPATIBLE');
});

test('compile: required input port missing rejected', () => {
  const r = compileStudioGraph({
    ...base,
    nodes: [imageGenNode('img1'), outputNode('o1')],
    edges: [edge('e1', 'img1', 'o1', 'image', 'image')],
  });
  // image-generation requires its 'text' input; not connected
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'REQUIRED_PORT_MISSING');
});

test('compile: output node without any input rejected', () => {
  const r = compileStudioGraph({
    ...base,
    nodes: [promptNode('p1'), outputNode('o1')],
    edges: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'OUTPUT_INPUT_MISSING');
});

test('compile: structural nodes excluded from execution graph, edges to them ignored', () => {
  const r = compileStudioGraph({
    ...base,
    nodes: [frameNode('f1'), promptNode('p1'), outputNode('o1')],
    edges: [
      edge('e1', 'p1', 'o1', 'text', 'text'),
      edge('e2', 'p1', 'f1', 'text', 'text'),
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.graph.structuralNodeCount, 1);
  assert.deepEqual(r.graph.structuralNodeIds, ['f1']);
  assert.ok(!r.graph.nodes.some((n) => n.nodeId === 'f1'));
  assert.deepEqual(r.graph.topologicalOrder, ['p1', 'o1']);
});

test('compile: fan-in dependencies + fan-out dependents', () => {
  const r = compileStudioGraph({
    ...base,
    nodes: [promptNode('p1'), promptNode('p2'), outputNode('join')],
    edges: [
      edge('e1', 'p1', 'join', 'text', 'text'),
      edge('e2', 'p2', 'join', 'text', 'text'),
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const join = r.graph.nodes.find((n) => n.nodeId === 'join');
  assert.deepEqual(join.dependencies, ['p1', 'p2']);
  const p1 = r.graph.nodes.find((n) => n.nodeId === 'p1');
  assert.deepEqual(p1.dependents, ['join']);
});

test('compile: SELECTED middle node = roots + upstream closure, downstream excluded (A->B->C->D, SELECTED C => A,B,C)', () => {
  const mk = (id) => ({ nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1, data: { nodeKind: 'prompt', schemaVersion: 1, parameters: { prompt: id }, prompt: id } });
  const r = compileStudioGraph({
    ...base, runMode: 'SELECTED', selectedNodeIds: ['C'],
    nodes: [mk('A'), mk('B'), mk('C'), mk('D')],
    edges: [
      edge('e1', 'A', 'B', 'text', 'text'),
      edge('e2', 'B', 'C', 'text', 'text'),
      edge('e3', 'C', 'D', 'text', 'text'),
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.graph.nodes.map((n) => n.nodeId).sort(), ['A', 'B', 'C']);
});

test('compile: FROM_NODE middle node = downstream closure + upstream support (A->B->C->D, FROM_NODE C => A,B,C,D)', () => {
  const mk = (id) => ({ nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1, data: { nodeKind: 'prompt', schemaVersion: 1, parameters: { prompt: id }, prompt: id } });
  const r = compileStudioGraph({
    ...base, runMode: 'FROM_NODE', selectedNodeIds: ['C'],
    nodes: [mk('A'), mk('B'), mk('C'), mk('D')],
    edges: [
      edge('e1', 'A', 'B', 'text', 'text'),
      edge('e2', 'B', 'C', 'text', 'text'),
      edge('e3', 'C', 'D', 'text', 'text'),
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.graph.nodes.map((n) => n.nodeId).sort(), ['A', 'B', 'C', 'D']);
  // C's dependents include D; D's dependencies include C — self-contained.
  const c = r.graph.nodes.find((n) => n.nodeId === 'C');
  const d = r.graph.nodes.find((n) => n.nodeId === 'D');
  assert.deepEqual(c.dependents, ['D']);
  assert.deepEqual(d.dependencies, ['C']);
});

test('compile: SELECTED != FROM_NODE on identical linear graph (distinct code paths)', () => {
  const mk = (id) => ({ nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1, data: { nodeKind: 'prompt', schemaVersion: 1, parameters: { prompt: id }, prompt: id } });
  const common = {
    ...base,
    nodes: [mk('A'), mk('B'), mk('C'), mk('D')],
    edges: [
      edge('e1', 'A', 'B', 'text', 'text'),
      edge('e2', 'B', 'C', 'text', 'text'),
      edge('e3', 'C', 'D', 'text', 'text'),
    ],
  };
  const sel = compileStudioGraph({ ...common, runMode: 'SELECTED', selectedNodeIds: ['C'] });
  const from = compileStudioGraph({ ...common, runMode: 'FROM_NODE', selectedNodeIds: ['C'] });
  assert.equal(sel.ok, true, JSON.stringify(sel.error));
  assert.equal(from.ok, true, JSON.stringify(from.error));
  const selIds = sel.graph.nodes.map((n) => n.nodeId).sort();
  const fromIds = from.graph.nodes.map((n) => n.nodeId).sort();
  assert.deepEqual(selIds, ['A', 'B', 'C']);
  assert.deepEqual(fromIds, ['A', 'B', 'C', 'D']);
  assert.notDeepEqual(selIds, fromIds, 'SELECTED and FROM_NODE must produce different node sets');
});

test('compile: SELECTED multiple targets = union of each target upstream closure', () => {
  const mk = (id) => ({ nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1, data: { nodeKind: 'prompt', schemaVersion: 1, parameters: { prompt: id }, prompt: id } });
  // A->B->C->D and E->F; SELECTED [C, F] => {A,B,C,E,F} (D excluded).
  const r = compileStudioGraph({
    ...base, runMode: 'SELECTED', selectedNodeIds: ['C', 'F'],
    nodes: [mk('A'), mk('B'), mk('C'), mk('D'), mk('E'), mk('F')],
    edges: [
      edge('e1', 'A', 'B', 'text', 'text'),
      edge('e2', 'B', 'C', 'text', 'text'),
      edge('e3', 'C', 'D', 'text', 'text'),
      edge('e4', 'E', 'F', 'text', 'text'),
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.graph.nodes.map((n) => n.nodeId).sort(), ['A', 'B', 'C', 'E', 'F']);
});

test('compile: FROM_NODE side input — downstream join pulls in side node Y but NOT Y downstream branches', () => {
  //      Y
  //      | \
  //      |  D2 (unrelated downstream of Y)
  // A->B->C->D
  //            ^
  //            | (Y side input into D)
  // FROM_NODE C => target {C,D} + upstream {A,B,Y} = {A,B,C,D,Y}; D2 excluded.
  const mk = (id) => ({ nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1, data: { nodeKind: 'prompt', schemaVersion: 1, parameters: { prompt: id }, prompt: id } });
  const r = compileStudioGraph({
    ...base, runMode: 'FROM_NODE', selectedNodeIds: ['C'],
    nodes: [mk('A'), mk('B'), mk('C'), mk('D'), mk('Y'), mk('D2')],
    edges: [
      edge('e1', 'A', 'B', 'text', 'text'),
      edge('e2', 'B', 'C', 'text', 'text'),
      edge('e3', 'C', 'D', 'text', 'text'),
      edge('e4', 'Y', 'D', 'text', 'text'),
      edge('e5', 'Y', 'D2', 'text', 'text'),
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.graph.nodes.map((n) => n.nodeId).sort(), ['A', 'B', 'C', 'D', 'Y']);
  const d = r.graph.nodes.find((n) => n.nodeId === 'D');
  assert.deepEqual(d.dependencies.sort(), ['C', 'Y']);
});

test('compile: diamond — SELECTED join pulls both mid branches; FROM_NODE source runs everything', () => {
  const mk = (id) => ({ nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1, data: { nodeKind: 'prompt', schemaVersion: 1, parameters: { prompt: id }, prompt: id } });
  const common = {
    ...base,
    nodes: [mk('S'), mk('M1'), mk('M2'), mk('J')],
    edges: [
      edge('e1', 'S', 'M1', 'text', 'text'),
      edge('e2', 'S', 'M2', 'text', 'text'),
      edge('e3', 'M1', 'J', 'text', 'text'),
      edge('e4', 'M2', 'J', 'text', 'text'),
    ],
  };
  const sel = compileStudioGraph({ ...common, runMode: 'SELECTED', selectedNodeIds: ['J'] });
  assert.equal(sel.ok, true, JSON.stringify(sel.error));
  assert.deepEqual(sel.graph.nodes.map((n) => n.nodeId).sort(), ['J', 'M1', 'M2', 'S']);
  const from = compileStudioGraph({ ...common, runMode: 'FROM_NODE', selectedNodeIds: ['S'] });
  assert.equal(from.ok, true, JSON.stringify(from.error));
  assert.deepEqual(from.graph.nodes.map((n) => n.nodeId).sort(), ['J', 'M1', 'M2', 'S']);
  // Fan-in: J waits for both mid nodes.
  const j = sel.graph.nodes.find((n) => n.nodeId === 'J');
  assert.deepEqual(j.dependencies, ['M1', 'M2']);
});

test('compile: fan-out — one source, two independent branches; SELECTED one branch excludes the other', () => {
  const mk = (id) => ({ nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1, data: { nodeKind: 'prompt', schemaVersion: 1, parameters: { prompt: id }, prompt: id } });
  const r = compileStudioGraph({
    ...base, runMode: 'SELECTED', selectedNodeIds: ['A'],
    nodes: [mk('P'), mk('A'), mk('B')],
    edges: [
      edge('e1', 'P', 'A', 'text', 'text'),
      edge('e2', 'P', 'B', 'text', 'text'),
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.graph.nodes.map((n) => n.nodeId).sort(), ['A', 'P']);
  // FROM_NODE P covers both branches.
  const r2 = compileStudioGraph({ ...base, runMode: 'FROM_NODE', selectedNodeIds: ['P'], nodes: [mk('P'), mk('A'), mk('B')], edges: [edge('e1', 'P', 'A', 'text', 'text'), edge('e2', 'P', 'B', 'text', 'text')] });
  assert.equal(r2.ok, true, JSON.stringify(r2.error));
  assert.deepEqual(r2.graph.nodes.map((n) => n.nodeId).sort(), ['A', 'B', 'P']);
});

test('compile: fan-in join with required input — image-gen joined by prompt + 2 references', () => {
  // P -> J(text required), R1 -> J(image), R2 -> J(image)
  const p = { nodeId: 'P', nodeType: 'prompt', nodeSchemaVersion: 1, data: { nodeKind: 'prompt', schemaVersion: 1, parameters: { prompt: 'p' }, prompt: 'p' } };
  const j = { nodeId: 'J', nodeType: 'image-generation', nodeSchemaVersion: 1, data: { nodeKind: 'image-generation', schemaVersion: 1, parameters: { logicalModelId: 'lm-1' } } };
  const ref = (id) => ({ nodeId: id, nodeType: 'reference', nodeSchemaVersion: 1, data: { nodeKind: 'reference', schemaVersion: 1, parameters: { assetId: `a-${id}` }, assetId: `a-${id}` } });
  const r = compileStudioGraph({
    ...base,
    nodes: [p, ref('R1'), ref('R2'), j],
    edges: [
      edge('e1', 'P', 'J', 'text', 'text'),
      edge('e2', 'R1', 'J', 'image', 'image'),
      edge('e3', 'R2', 'J', 'image', 'image'),
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const jn = r.graph.nodes.find((n) => n.nodeId === 'J');
  assert.deepEqual(jn.dependencies, ['P', 'R1', 'R2']);
});

test('compile: unrelated branch excluded — SELECTED target does not include siblings sharing a parent', () => {
  const mk = (id) => ({ nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1, data: { nodeKind: 'prompt', schemaVersion: 1, parameters: { prompt: id }, prompt: id } });
  // S -> X -> T  and  S -> U (U is an unrelated sibling branch of the selected path)
  const r = compileStudioGraph({
    ...base, runMode: 'SELECTED', selectedNodeIds: ['T'],
    nodes: [mk('S'), mk('X'), mk('T'), mk('U')],
    edges: [
      edge('e1', 'S', 'X', 'text', 'text'),
      edge('e2', 'X', 'T', 'text', 'text'),
      edge('e3', 'S', 'U', 'text', 'text'),
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.graph.nodes.map((n) => n.nodeId).sort(), ['S', 'T', 'X']);
});

test('compile: cycle rejected before scope compile in run-mode subgraph', () => {
  const mk = (id) => ({ nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1, data: { nodeKind: 'prompt', schemaVersion: 1, parameters: { prompt: id }, prompt: id } });
  // p1 <-> p2 cycle reachable from selected root p1; plus downstream p3.
  const r = compileStudioGraph({
    ...base, runMode: 'FROM_NODE', selectedNodeIds: ['p1'],
    nodes: [mk('p1'), mk('p2'), mk('p3')],
    edges: [
      edge('e1', 'p1', 'p2', 'text', 'text'),
      edge('e2', 'p2', 'p1', 'text', 'text'),
      edge('e3', 'p2', 'p3', 'text', 'text'),
    ],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'DAG_CYCLE_DETECTED');
});

test('compile: structural nodes break execution edges — frame severs the dependency chain', () => {
  // A -> F(frame, structural) -> C : the frame contributes no executable
  // dependency, so C never waits on A. ALL mode runs both as independent.
  const mk = (id) => ({ nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1, data: { nodeKind: 'prompt', schemaVersion: 1, parameters: { prompt: id }, prompt: id } });
  const f = { nodeId: 'F', nodeType: 'frame', nodeSchemaVersion: 1, data: { nodeKind: 'frame', schemaVersion: 1, parameters: { frameLabel: 'F' } } };
  const common = {
    ...base,
    nodes: [mk('A'), f, mk('C')],
    edges: [
      edge('e1', 'A', 'F', 'text', 'text'),
      edge('e2', 'F', 'C', 'text', 'text'),
    ],
  };
  const all = compileStudioGraph(common);
  assert.equal(all.ok, true, JSON.stringify(all.error));
  assert.deepEqual(all.graph.nodes.map((n) => n.nodeId).sort(), ['A', 'C']);
  const c = all.graph.nodes.find((n) => n.nodeId === 'C');
  assert.deepEqual(c.dependencies, [], 'frame severs the executable chain: C has no executable dependency on A');
  assert.deepEqual(all.graph.structuralNodeIds, ['F']);
  // SELECTED C: only C (upstream through the frame is not an executable path).
  const sel = compileStudioGraph({ ...common, runMode: 'SELECTED', selectedNodeIds: ['C'] });
  assert.equal(sel.ok, true, JSON.stringify(sel.error));
  assert.deepEqual(sel.graph.nodes.map((n) => n.nodeId), ['C']);
});

test('compile: SELECTED output node pulls its full upstream closure (valid)', () => {
  const r = compileStudioGraph({
    ...base, runMode: 'SELECTED', selectedNodeIds: ['o1'],
    nodes: [promptNode('p1'), outputNode('o1')],
    edges: [edge('e1', 'p1', 'o1', 'text', 'text')],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.graph.nodes.map((n) => n.nodeId).sort(), ['o1', 'p1']);
});

test('compile: SELECTED root with unconnected required input rejected', () => {
  const r = compileStudioGraph({
    ...base, runMode: 'SELECTED', selectedNodeIds: ['img1'],
    nodes: [imageGenNode('img1')],
    edges: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'REQUIRED_PORT_MISSING');
});

test('compile: SELECTED single source node yields a 1-node valid graph', () => {
  const r = compileStudioGraph({
    ...base, runMode: 'SELECTED', selectedNodeIds: ['p1'],
    nodes: [promptNode('p1'), outputNode('o1')],
    edges: [edge('e1', 'p1', 'o1', 'text', 'text')],
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.graph.nodes.map((n) => n.nodeId), ['p1']);
});

test('compile: unknown selected node rejected', () => {
  const r = compileStudioGraph({
    ...base, runMode: 'FROM_NODE', selectedNodeIds: ['ghost'],
    nodes: [promptNode('p1')], edges: [],
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UNKNOWN_NODE_ID');
});

test('compile: input JSON is durable-safe (no forbidden keys leak)', () => {
  const r = compileStudioGraph({
    ...base,
    nodes: [{
      nodeId: 'p1', nodeType: 'prompt', nodeSchemaVersion: 1,
      data: { parameters: { prompt: 'ok', apiKey: 'LEAK', token: 'LEAK', signedUrl: 'http://secret' }, prompt: 'ok' },
    }],
    edges: [],
  });
  assert.equal(r.ok, true);
  const input = r.graph.nodes[0].input;
  assert.equal(input.parameters.prompt, 'ok');
  assert.ok(!JSON.stringify(r.graph).includes('LEAK'));
  assert.ok(!JSON.stringify(r.graph).includes('http://secret'));
});

test('compile: 1000-node linear DAG compiles in O(V+E) time (benchmark)', () => {
  const N = 1000;
  const nodes = [];
  const edges = [];
  for (let i = 0; i < N; i++) {
    nodes.push(promptNode(`n${i}`));
    if (i > 0) edges.push(edge(`e${i}`, `n${i - 1}`, `n${i}`, 'text', 'text'));
  }
  const t0 = process.hrtime.bigint();
  const r = compileStudioGraph({ ...base, canvasRevision: 1, nodes, edges });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.graph.nodeCount, N);
  assert.equal(r.graph.topologicalOrder.length, N);
  console.log(`[benchmark] 1000-node linear compile: ${ms.toFixed(1)}ms`);
  assert.ok(ms < 5000, `compile too slow: ${ms}ms`);
});

test('compile: 1000-node wide diamond DAG compiles', () => {
  // 1 source -> 998 parallel branches -> 1 output join (fan-out + fan-in at scale)
  const nodes = [promptNode('src'), outputNode('join')];
  const edges = [edge('e0', 'src', 'join', 'text', 'text')];
  for (let i = 0; i < 998; i++) {
    const mid = `mid${i}`;
    nodes.push(promptNode(mid, `mid ${i}`));
    edges.push(edge(`es${i}`, 'src', mid, 'text', 'text'));
    edges.push(edge(`et${i}`, mid, 'join', 'text', 'text'));
  }
  const t0 = process.hrtime.bigint();
  const r = compileStudioGraph({ ...base, nodes, edges });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.graph.nodeCount, 1000);
  const join = r.graph.nodes.find((n) => n.nodeId === 'join');
  assert.equal(join.dependencies.length, 999);
  console.log(`[benchmark] 1000-node diamond compile: ${ms.toFixed(1)}ms`);
  assert.ok(ms < 10000, `compile too slow: ${ms}ms`);
});

test('compile: spec fan-in example — A->C->D plus X->C; FROM_NODE C = {A,X,C,D}, NOT A\'s unrelated branch Z', () => {
  const mk = (id) => ({ nodeId: id, nodeType: 'prompt', nodeSchemaVersion: 1, data: { nodeKind: 'prompt', schemaVersion: 1, parameters: { prompt: id }, prompt: id } });
  //      A -> Z (unrelated downstream branch of A)
  //      A \
  //        -> C -> D
  //      X /
  const common = {
    ...base,
    nodes: [mk('A'), mk('X'), mk('C'), mk('D'), mk('Z')],
    edges: [
      edge('e1', 'A', 'C', 'text', 'text'),
      edge('e2', 'X', 'C', 'text', 'text'),
      edge('e3', 'C', 'D', 'text', 'text'),
      edge('e4', 'A', 'Z', 'text', 'text'),
    ],
  };
  const r = compileStudioGraph({ ...common, runMode: 'FROM_NODE', selectedNodeIds: ['C'] });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.graph.nodes.map((n) => n.nodeId).sort(), ['A', 'C', 'D', 'X'], 'FROM_NODE C includes A, X, C, D and excludes Z');
  const c = r.graph.nodes.find((n) => n.nodeId === 'C');
  assert.deepEqual(c.dependencies.sort(), ['A', 'X'], 'fan-in: C waits for both A and X');
  // Same graph, SELECTED C = {A, C, X} — D (downstream) excluded; proves the
  // two modes are distinct on the fan-in shape too.
  const sel = compileStudioGraph({ ...common, runMode: 'SELECTED', selectedNodeIds: ['C'] });
  assert.equal(sel.ok, true, JSON.stringify(sel.error));
  assert.deepEqual(sel.graph.nodes.map((n) => n.nodeId).sort(), ['A', 'C', 'X']);
});

test('compile: graph too large rejected with limit', () => {
  process.env.STUDIO_RUN_MAX_NODES = '5';
  try {
    const nodes = [promptNode('a'), promptNode('b'), promptNode('c'), promptNode('d'), promptNode('e'), promptNode('f')];
    const r = compileStudioGraph({ ...base, nodes, edges: [] });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'GRAPH_TOO_LARGE');
  } finally {
    delete process.env.STUDIO_RUN_MAX_NODES;
  }
});
