'use strict';
/**
 * M02-C — Repository + Service tests for model revisions, grants, routing policies.
 * Uses a fake PG pool. Focus: validation before write, audit columns, grant semantics.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('./repositories/aiControlRepository.cjs');
const svc = require('./services/aiControlService.cjs');

function fakePgWithM02C() {
  const revisions = [];
  const grants = [];
  const policies = [];
  const decisions = [];
  let revisionCounter = 0;

  return {
    async query(sql, params = []) {
      const T = sql.toUpperCase();

      // Revisions
      if (T.includes('FROM AI_MODEL_REVISIONS WHERE MODEL_ID=$1 ORDER BY REVISION DESC')) {
        return { rows: revisions.filter((r) => r.model_id === params[0]) };
      }
      if (T.includes("FROM AI_MODEL_REVISIONS WHERE MODEL_ID=$1 AND STATUS='ACTIVE'")) {
        return { rows: revisions.filter((r) => r.model_id === params[0] && r.status === 'active') };
      }
      if (T.includes('SELECT COALESCE(MAX(REVISION)') && T.includes('AI_MODEL_REVISIONS')) {
        const modelRevs = revisions.filter((r) => r.model_id === params[0]);
        const max = modelRevs.length ? Math.max(...modelRevs.map((r) => r.revision)) : 0;
        return { rows: [{ max_rev: String(max) }] };
      }
      if (T.includes("STATUS='ACTIVE' LIMIT 1") && T.includes('AI_MODEL_REVISIONS')) {
        return { rows: revisions.filter((r) => r.model_id === params[0] && r.status === 'active').slice(0, 1) };
      }
      if (T.startsWith('INSERT INTO AI_MODEL_REVISIONS')) {
        const id = `mr-${++revisionCounter}`;
        const rev = {
          id,
          model_id: params[0],
          revision: Number(params[1]),
          content_hash: params[2],
          manifest: JSON.parse(params[3]),
          status: 'active',
          supersedes: params[4] || null,
          published_by: params[5] || null,
          published_at: new Date().toISOString(),
          retired_at: null,
        };
        revisions.push(rev);
        return { rows: [rev] };
      }
      if (T.includes('UPDATE AI_MODEL_REVISIONS')) {
        // Distinguish retire-by-id (WHERE id=$1) vs retire-by-model (WHERE model_id=$1 AND status)
        const hasIdWhere = sql.toUpperCase().includes("WHERE ID=$1");
        if (hasIdWhere) {
          const rev = revisions.find((r) => r.id === params[0] && r.status === 'active');
          if (rev) { rev.status = 'retired'; rev.retired_at = new Date().toISOString(); }
          return { rows: [rev] || [] };
        }
        // Retire-by-model: params[0] is model_id
        const modelId = params[0];
        for (const rev of revisions) {
          if (rev.model_id === modelId && rev.status === 'active') {
            rev.status = 'retired';
            rev.retired_at = new Date().toISOString();
          }
        }
        return { rows: revisions.filter((r) => r.model_id === modelId) };
      }

      // Grants
      if (T.includes('FROM AI_MODEL_CAPABILITY_GRANTS WHERE MODEL_ID=$1')) {
        return { rows: grants.filter((g) => g.model_id === params[0]) };
      }
      if (T.startsWith('INSERT INTO AI_MODEL_CAPABILITY_GRANTS')) {
        const grant = {
          id: `mcg-${grants.length}`,
          workspace_id: params[0],
          user_id: params[1],
          model_id: params[2],
          capability: params[3],
          status: 'granted',
          granted_by: params[4],
          expires_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        grants.push(grant);
        return { rows: [grant] };
      }
      if (T.startsWith('UPDATE AI_MODEL_CAPABILITY_GRANTS SET STATUS')) {
        const id = params[0];
        const g = grants.find((x) => x.id === id && x.status === 'granted');
        if (g) { g.status = 'revoked'; g.updated_at = new Date().toISOString(); }
        return { rows: [g] };
      }
      if (T.startsWith('DELETE FROM AI_MODEL_CAPABILITY_GRANTS')) {
        const idx = grants.findIndex((g) => g.id === params[0]);
        if (idx >= 0) return { rows: [grants.splice(idx, 1)[0]] };
        return { rows: [] };
      }

      // Routing Policies
      if (T.includes('FROM AI_ROUTING_POLICY WHERE MODEL_ID=$1')) {
        return { rows: policies.filter((p) => p.model_id === params[0]) };
      }
      if (T.startsWith('INSERT INTO AI_ROUTING_POLICY')) {
        const pol = {
          id: policies.length ? policies[policies.length - 1].id : 'mrp-0',
          model_id: params[0],
          capability: params[1],
          target_binding_id: params[2],
          percent: Number(params[3]),
          salt: params[4],
          status: 'active',
          revision: 1,
          updated_by: params[5],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (!policies.find((p) => p.id === pol.id)) policies.push(pol);
        return { rows: [pol] };
      }
      if (T.startsWith('UPDATE AI_ROUTING_POLICY SET')) {
        // Last param is policyId, second-to-last is actor
        const policyId = params[params.length - 1];
        const pol = policies.find((p) => p.id === policyId);
        if (pol) {
          pol.revision += 1;
          pol.updated_at = new Date().toISOString();
          // Find percent in set clause
          if (sql.toUpperCase().includes('PERCENT')) {
            pol.percent = Number(params[0]);
          }
        }
        return { rows: [pol] };
      }
      if (T.startsWith('SELECT * FROM AI_ROUTING_POLICY WHERE ID=$1')) {
        return { rows: policies.filter((p) => p.id === params[0]) };
      }

      // Routing Decisions (M02-C with revision binding)
      if (T.startsWith('INSERT INTO AI_ROUTING_DECISIONS') && T.includes('MODEL_REVISION_ID')) {
        const dec = {
          id: params[0],
          model_revision_id: params[14],
          routing_policy: params[13],
        };
        decisions.push(dec);
        return { rows: [dec] };
      }
      if (T.startsWith('INSERT INTO AI_ROUTING_DECISIONS')) {
        const dec = { id: params[0] };
        decisions.push(dec);
        return { rows: [dec] };
      }

      // Delegation to legacy queries
      if (T.includes('FROM PROVIDERS') && T.includes('ORDER BY')) return { rows: [] };
      if (T.includes('FROM API_KEYS WHERE PROVIDER_ID=ANY')) return { rows: [] };
      if (T.startsWith('SELECT * FROM MODELS WHERE MODEL_ID=$1')) return { rows: [] };
      if (T.startsWith('SELECT * FROM MODELS WHERE ENABLED')) return { rows: [] };
      if (T.includes('FROM PROVIDER_MODEL_BINDINGS')) return { rows: [] };
      return { rows: [] };
    },
    _revisions: revisions,
    _grants: grants,
    _policies: policies,
    _decisions: decisions,
  };
}

test('repo: publishRevision validates and creates row', async () => {
  const pg = fakePgWithM02C();
  const rev = await repo.publishRevision(pg, 'm1', { type: 'text', capabilities: { text: true }, capability_version: 1 }, 'admin-1');
  assert.ok(rev.id.startsWith('mr-'));
  assert.equal(rev.model_id, 'm1');
  assert.equal(rev.revision, 1);
  assert.equal(rev.status, 'active');
  assert.equal(rev.published_by, 'admin-1');
  assert.equal(rev.content_hash.length, 64);
});

test('repo: publishRevision increments revision number', async () => {
  const pg = fakePgWithM02C();
  await repo.publishRevision(pg, 'm1', { type: 'text', capabilities: { text: true }, capability_version: 1 }, 'a');
  const rev2 = await repo.publishRevision(pg, 'm1', { type: 'video', capabilities: { text_to_video: true }, capability_version: 2 }, 'a');
  assert.equal(rev2.revision, 2);
});

test('repo: publishRevision retires previous active', async () => {
  const pg = fakePgWithM02C();
  await repo.publishRevision(pg, 'm1', { type: 'text', capabilities: { text: true }, capability_version: 1 }, 'a');
  await repo.publishRevision(pg, 'm1', { type: 'video', capabilities: { text_to_video: true }, capability_version: 2 }, 'a');
  const all = await repo.listModelRevisions(pg, 'm1');
  const active = all.filter((r) => r.status === 'active');
  assert.equal(active.length, 1, 'only one active revision');
  assert.equal(active[0].revision, 2);
});

test('repo: publishRevision rejects invalid manifest', async () => {
  const pg = fakePgWithM02C();
  await assert.rejects(
    () => repo.publishRevision(pg, 'm1', 'not-an-object', 'a'),
    /revision 校验失败/
  );
});

test('repo: getActiveRevision returns active or null', async () => {
  const pg = fakePgWithM02C();
  assert.equal(await repo.getActiveRevision(pg, 'nonexistent'), null);
  await repo.publishRevision(pg, 'm1', { type: 'text', capabilities: { text: true }, capability_version: 1 }, 'a');
  const active = await repo.getActiveRevision(pg, 'm1');
  assert.ok(active);
  assert.equal(active.status, 'active');
});

test('repo: retireRevision retires active revision', async () => {
  const pg = fakePgWithM02C();
  const rev = await repo.publishRevision(pg, 'm1', { type: 'text', capabilities: { text: true }, capability_version: 1 }, 'a');
  assert.ok(rev);
  const retired = await repo.retireRevision(pg, rev.id);
  assert.ok(retired);
  assert.equal(retired.status, 'retired');
  assert.ok(retired.retired_at);
});

test('repo: createGrant validates and inserts', async () => {
  const pg = fakePgWithM02C();
  const grant = await repo.createGrant(pg, { model_id: 'm1', user_id: 'u1', capability: 'text' }, 'admin');
  assert.ok(grant && grant.id.startsWith('mcg-'));
  assert.equal(grant.model_id, 'm1');
  assert.equal(grant.user_id, 'u1');
  assert.equal(grant.status, 'granted');
});

test('repo: createGrant rejects missing model_id', async () => {
  const pg = fakePgWithM02C();
  await assert.rejects(
    () => repo.createGrant(pg, { user_id: 'u1' }, 'admin'),
    /grant 校验失败/
  );
});

test('repo: revokeGrant updates status', async () => {
  const pg = fakePgWithM02C();
  const grant = await repo.createGrant(pg, { model_id: 'm1', user_id: 'u1' }, 'admin');
  assert.ok(grant);
  const revoked = await repo.revokeGrant(pg, grant.id);
  assert.ok(revoked);
  assert.equal(revoked.status, 'revoked');
});

test('repo: deleteGrant removes row', async () => {
  const pg = fakePgWithM02C();
  const grant = await repo.createGrant(pg, { model_id: 'm1', user_id: 'u1' }, 'admin');
  assert.ok(grant);
  const deleted = await repo.deleteGrant(pg, grant.id);
  assert.ok(deleted);
  const remaining = await repo.listGrantsForModel(pg, 'm1');
  assert.equal(remaining.length, 0);
});

test('repo: createRoutingPolicy validates and inserts', async () => {
  const pg = fakePgWithM02C();
  const pol = await repo.createRoutingPolicy(pg, {
    model_id: 'm1', target_binding_id: 'b1', percent: 50, capability: 'text',
  }, 'admin');
  assert.ok(pol);
  assert.ok(pol.id.startsWith('mrp-'));
  assert.equal(pol.percent, 50);
  assert.equal(pol.status, 'active');
});

test('repo: createRoutingPolicy rejects invalid percent', async () => {
  const pg = fakePgWithM02C();
  await assert.rejects(
    () => repo.createRoutingPolicy(pg, { model_id: 'm1', target_binding_id: 'b1', percent: 150 }, 'admin'),
    /routing policy 校验失败/
  );
});

test('repo: updateRoutingPolicy updates fields', async () => {
  const pg = fakePgWithM02C();
  const pol = await repo.createRoutingPolicy(pg, {
    model_id: 'm1', target_binding_id: 'b1', percent: 10,
  }, 'admin');
  assert.ok(pol, 'policy should be created');
  const updated = await repo.updateRoutingPolicy(pg, pol.id, { percent: 90 }, 'admin');
  assert.ok(updated, 'update should return updated policy');
  if (updated) {
    assert.equal(updated.percent, 90, `got ${updated.percent}`);
    assert.equal(updated.revision, 2);
  }
});

test('service: checkModelEntitlement is OPEN by default', async () => {
  const pg = fakePgWithM02C();
  const hasAccess = await svc.checkModelEntitlement(pg, 'm1', { userId: 'u1' });
  assert.equal(hasAccess, true, 'no grants = OPEN');
});

test('service: checkModelEntitlement respects grants', async () => {
  const pg = fakePgWithM02C();
  await repo.createGrant(pg, { model_id: 'm1', user_id: 'u1' }, 'admin');
  const grants = await repo.listGrantsForModel(pg, 'm1');
  assert.equal(grants.length, 1, 'grant should exist');
  const hasAccess = await svc.checkModelEntitlement(pg, 'm1', { userId: 'u1' });
  assert.equal(hasAccess, true);
  const denied = await svc.checkModelEntitlement(pg, 'm1', { userId: 'u2' });
  assert.equal(denied, false);
});

test('service: recordRoutingWithRevision binds policy and revision', async () => {
  const pg = fakePgWithM02C();
  const dec = await svc.recordRoutingWithRevision(pg, {
    routing_decision_id: 'rd-test',
    model_id: 'm1',
    capability: 'text',
    selected: { bindingId: 'b1', providerId: 'p1' },
    reason: 'selected',
    fallback_candidates: [],
    rejected: [],
  }, { modelRevisionId: 'mr-1', routingPolicyId: 'mrp-1' });
  assert.equal(dec.id, 'rd-test');
  assert.equal(dec.model_revision_id, 'mr-1');
  assert.equal(dec.routing_policy, 'mrp-1');
});

test('service: resolveRouting returns binding from policy', async () => {
  const pg = fakePgWithM02C();
  await repo.createRoutingPolicy(pg, {
    model_id: 'm1', target_binding_id: 'b-canary', percent: 100,
  }, 'admin');
  const result = await svc.resolveRouting(pg, 'm1', 'text', 'b-main', 42);
  assert.equal(result.selected, 'b-canary');
  assert.ok(result.policyId);
});

test('service: resolveRouting falls back to requested binding when no policy', async () => {
  const pg = fakePgWithM02C();
  const result = await svc.resolveRouting(pg, 'm1', 'text', 'b-main', 42);
  assert.equal(result.selected, 'b-main');
  assert.equal(result.policyId, null);
});
