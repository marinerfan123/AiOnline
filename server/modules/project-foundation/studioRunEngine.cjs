'use strict';
/**
 * M05-D1 — Durable Studio Run engine (PostgreSQL is the scheduling authority).
 *
 * Hard rules enforced here:
 *  - NO durable process memory: no Map/Set/in-memory queue as execution
 *    authority. Every lease, counter, and status lives in PostgreSQL.
 *  - Short transactions only: lease -> commit, execute OUTSIDE a
 *    transaction, complete/fail -> commit (STEP 39/40; M05-E relies on it).
 *  - Immutable revision binding: execution reads the compiled snapshot at
 *    Run creation; live Canvas rows are never re-read (STEP 4).
 *  - Multi-worker safe: FOR UPDATE SKIP LOCKED leasing, unique lease tokens,
 *    atomic counter decrement, expired-lease reaper (STEP 19-26).
 *  - M05-D1 never calls real AI / Generation V2 / billing.
 */
const crypto = require('crypto');
const { compileStudioGraph } = require('./studioRunGraph.cjs');
const { createStudioExecutorRegistry } = require('./studioRunExecutors.cjs');

const RUN_STATUSES = ['QUEUED', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'];
const TERMINAL_RUN = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const ACTIVE_NODE = new Set(['LEASED', 'RUNNING', 'WAITING']);
const TERMINAL_NODE = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED']);

const LIMITS = Object.freeze({
  maxAttempts: Number(process.env.STUDIO_RUN_MAX_ATTEMPTS || 3),
  leaseSeconds: Number(process.env.STUDIO_RUN_LEASE_SECONDS || 120),
  leasePollLimit: Number(process.env.STUDIO_RUN_LEASE_LIMIT || 20),
  reaperBatch: Number(process.env.STUDIO_RUN_REAPER_BATCH || 200),
  backoffMs: [2000, 5000, 12000, 30000, 60000],
  maxBackoffMs: 300000,
  maxResultBytes: Number(process.env.STUDIO_RUN_MAX_RESULT_BYTES || 1024 * 1024),
  maxErrorLength: 500,
});

function toIso(v) { return v ? new Date(v).toISOString() : null; }
function cleanText(v, max) { if (v === undefined || v === null) return null; const s = String(v); return s.length > max ? s.slice(0, max) : s; }

function sanitizeError(err) {
  const code = cleanText(err && err.code, 64) || 'EXECUTION_ERROR';
  let message = cleanText(err && err.message, LIMITS.maxErrorLength) || 'execution failed';
  // Strip anything that smells like a credential/URL authority before persisting (STEP 48).
  message = message
    .replace(/(Bearer\s+)[A-Za-z0-9\-_\.=\/+]{8,}/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key|apikey|token|secret|password|authorization)\s*[:=]\s*["']?[^\s"',;{}]+/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL_REDACTED]');
  return { code, message };
}

/** Deterministic bounded retry delay (test-configurable via retryBackoffMs). */
function retryDelayMs(attempt, backoffMs, nowMs) {
  const arr = backoffMs && backoffMs.length ? backoffMs : LIMITS.backoffMs;
  const base = arr[Math.min(Math.max(attempt - 1, 0), arr.length - 1)];
  return Math.min(base, LIMITS.maxBackoffMs);
}

function leaseToken() { return crypto.randomBytes(24).toString('hex'); }

function bulkInsertRunNodes(client, rows) {
  if (!rows || !rows.length) return Promise.resolve({ rowCount: 0 });
  const payload = rows.map((r) => ({
    node_id: r.studio_node_id, node_type: r.node_type, execution_kind: r.execution_kind,
    status: r.status, dep_count: r.dependency_count, rem_count: r.remaining_dependency_count,
    attempt: r.attempt, max_attempts: r.max_attempts, input_json: r.input_json,
  }));
  return client.query(
    `INSERT INTO studio_run_nodes (run_id, studio_node_id, node_type, execution_kind, status, dependency_count, remaining_dependency_count, attempt, max_attempts, input_json, created_at, updated_at)
     SELECT $1, r.node_id, r.node_type, r.execution_kind, r.status, r.dep_count, r.rem_count, r.attempt, r.max_attempts, r.input_json, NOW(), NOW()
     FROM jsonb_to_recordset($2::jsonb) AS r (node_id text, node_type text, execution_kind text, status text, dep_count int, rem_count int, attempt int, max_attempts int, input_json jsonb)`,
    [rows[0].run_id, JSON.stringify(payload)]
  );
}

function bulkInsertRunEdges(client, rows) {
  if (!rows || !rows.length) return Promise.resolve({ rowCount: 0 });
  const payload = rows.map((r) => ({ source: r.source_node_id, target: r.target_node_id }));
  return client.query(
    `INSERT INTO studio_run_node_edges (run_id, source_node_id, target_node_id)
     SELECT $1, r.source, r.target FROM jsonb_to_recordset($2::jsonb) AS r (source text, target text)`,
    [rows[0].run_id, JSON.stringify(payload)]
  );
}

/**
 * Extract the priced cost (credits) a caller attached to a completed node's
 * result. The engine does NOT price: the executor / M05-E generation bridge
 * must put the actual billed amount on the result — in CREDITS, the same unit
 * as project_budgets.budget/spent and L5 creditPrice (accounting.getModelPrice).
 * Returns a finite number > 0, else null (unpriced → no spend is recorded).
 */
function pricedNodeCost(result) {
  if (!result || typeof result !== 'object') return null;
  const c = Number(result.cost);
  return Number.isFinite(c) && c > 0 ? c : null;
}

function createStudioRunEngine(deps) {
  const { pg, workerId } = deps;
  // G21: optional run_events relay (createRunEventRelay from runEventRelay.cjs).
  // When present, every durable engine event is ALSO appended to the run_events
  // log; the relay owns seq allocation (lastSequence+1) and (run_id, seq)
  // idempotency. Absent / not callable → engine behaviour is byte-for-byte the
  // pre-relay path (no relay calls at all).
  const relay = deps.relay && typeof deps.relay.relayRunEvent === 'function' ? deps.relay : null;
  const registry = createStudioExecutorRegistry({ executors: deps.executors || null });
  const leaseSeconds = Math.max(1, Number(deps.leaseSeconds) || LIMITS.leaseSeconds);
  const pollLimit = Math.max(1, Math.min(100, Number(deps.leasePollLimit) || LIMITS.leasePollLimit));
  const defaultRetryBackoffMs = Array.isArray(deps.retryBackoffMs) ? deps.retryBackoffMs : null;
  const nowFn = deps.now || (() => Date.now());
  const emitLog = deps.onLog || null;
  const log = (tag, payload) => { try { if (emitLog) emitLog(tag, payload); } catch (_) {} };

  // V2.0 must#2 — optional budget-spend persistence backstop (see recordNodeSpend).
  // Null by default → the engine records NOTHING (zero behaviour change). The
  // production caller (server.js / studio-worker.cjs) must inject the real
  // budgetSpentStore to enable it:
  //   budgetSpentStore: require('./budgetSpentStore.cjs')
  // (alongside the existing pg / workerId / relay deps).
  const budgetSpentStore = deps.budgetSpentStore || null;

  /**
   * V2.0 must#2 — post-completion budget spend persistence (the "true ledger").
   *
   * Gate vs. spend (two different layers, never interchangeable):
   *   - GATE (studioRunApi.runBudgetGate)  = pre-flight ESTIMATE check at create
   *     time (estimate → remaining). Conservative, and fail-OPEN on budget-read
   *     errors — an added guardrail, NOT settlement. It cannot close the
   *     estimate→create race nor the multi-node concurrent-completion window.
   *   - SPEND (this function)              = post-completion PERSISTENT truth.
   *     budgetSpentStore.recordSpend is the guarded UPDATE (idempotent by key)
   *     — the real concurrency backstop. It fires ONLY after a node is durably
   *     SUCCEEDED and its result carries a priced cost, so the ledger never
   *     charges a failed/rolled-back/cancelled node.
   *
   * Idempotency key = the node's own PK (runNodeId = studio_run_nodes.id),
   * globally unique, so a completion retry / duplicate delivery can never
   * double-deduct (the store also replays the same key as a no-op).
   *
   * Best-effort ONLY: any throw (store down, pg down) is logged and swallowed —
   * a spend failure can never fail or roll back an already-committed run.
   */
  async function recordNodeSpend(runNodeId, projectId, result) {
    if (!budgetSpentStore || typeof budgetSpentStore.recordSpend !== 'function') return;
    const amount = pricedNodeCost(result);
    if (amount == null) return; // unpriced → nothing to record
    try {
      const r = await budgetSpentStore.recordSpend(pg, {
        projectId,
        amount,
        idempotencyKey: String(runNodeId),
      });
      if (!r || r.ok !== true) {
        log('run.node.spend_not_recorded', { runNodeId, projectId, code: r && r.error && r.error.code });
      }
    } catch (e) {
      log('run.node.spend_failed', { runNodeId, projectId, error: e && e.message ? e.message : String(e) });
    }
  }

  /**
   * Durable domain event (sanitized payload only) + structured log + optional
   * run_events relay bridge (G21).
   *
   * This is the engine's ONLY event-emission funnel — every `studio.run*` /
   * `studio.run_node*` event passes through here (the engine has no
   * EventEmitter and no SSE; it persists durable events, and callers/SSE read
   * them back). Every call site sits strictly AFTER the run row exists in
   * studio_runs (lease/complete/fail/reap/cancel/aggregate all operate on an
   * already-created run), so a relayed runId always satisfies the run_events
   * FK to studio_runs.
   *
   * Relay bridge is best-effort ONLY and can never disturb run execution:
   *   - relay events are QUEUED inside the tx and flushed only AFTER COMMIT on
   *     the relay's own pool connection (autocommit) — the relay's run_events
   *     INSERT FK-checks studio_runs FOR KEY SHARE, so it must never run while
   *     the engine tx still holds its uncommitted studio_runs row
   *     (self-deadlock, drill 2026-09-04); a ROLLBACK drops the queue,
   *     mirroring studio_run_events' own rollback semantics;
   *   - failures are logged ('event.relay_failed') and never thrown.
   *   - the relay allocates seq itself (lastSequence+1); (run_id, seq) PK
   *     absorbs duplicate delivery (idempotent no-op).
   */
  async function emitEvent(client, runId, runNodeId, eventType, payload) {
    try {
      await client.query(
        'INSERT INTO studio_run_events (run_id, run_node_id, event_type, payload) VALUES ($1, $2, $3, $4)',
        [runId, runNodeId || null, eventType, JSON.stringify(payload || {})]
      );
    } catch (e) { log('event.insert_failed', { runId, eventType, error: e.message }); }

    if (relay) {
      const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      // Bridge shape documented in runEventRelay.cjs: fold the positional
      // runNodeId into the payload as run_node_id (payload wins if it already
      // carried one — every engine site passes the same value) so replayed
      // events carry node identity like studio_run_events does. `type` is the
      // engine eventType verbatim; the relay treats it as opaque.
      // QUEUED, not sent: the relay writes run_events on its own autocommit
      // connection and that INSERT FK-checks studio_runs (FOR KEY SHARE);
      // sending it inside this transaction would deadlock against our own
      // uncommitted studio_runs row (drill 2026-09-04). Flushed only after
      // COMMIT (flushRelayQueue) and dropped on ROLLBACK.
      const evt = {
        runId,
        type: eventType,
        payload: runNodeId ? { run_node_id: runNodeId, ...body } : body,
      };
      if (!client._relayQueue) client._relayQueue = [];
      client._relayQueue.push(evt);
    }
  }

  /**
   * Flush events queued during a just-committed transaction to the relay.
   * MUST run only AFTER COMMIT (never before — see emitEvent): the relay
   * writes run_events on its own autocommit connection and a run_events
   * INSERT FK-checks studio_runs FOR KEY SHARE; while the engine tx is still
   * open it holds that studio_runs row and the relay insert would deadlock
   * (drill 2026-09-04). Best-effort: sequential, warn-only on failure
   * ('event.relay_failed', never thrown), and the queue is cleared
   * unconditionally so a reused pooled client can never re-send stale events.
   */
  async function flushRelayQueue(client) {
    const q = client._relayQueue;
    client._relayQueue = null;
    if (!q || !q.length || !relay) return;
    for (const evt of q) {
      try {
        const result = await relay.relayRunEvent(evt);
        if (!result || result.ok !== true) {
          log('event.relay_failed', { runId: evt.runId, eventType: evt.type, error: (result && result.errors) || 'relayRunEvent returned a non-ok result' });
        }
      } catch (e) {
        log('event.relay_failed', { runId: evt.runId, eventType: evt.type, error: e && e.message ? e.message : String(e) });
      }
    }
  }

  // ── SECTION:create-run ─────────────────────────────────────────────────
  //
  // REVISION TRUST BOUNDARY (commercial invariant):
  // A Studio Run is NEVER created from a caller-provided canvasRevision +
  // mutable live graph. `createRunFromCanvas` is the ONLY public production
  // entry for run creation and it owns one coherent transaction:
  //
  //   BEGIN
  //   SELECT authoritative canvas row FOR UPDATE   (serializes against M05-C
  //     mutations: every durable canvas mutation CAS-updates this same row —
  //     UPDATE ... WHERE revision = base takes the exclusive row lock — and
  //     mutates nodes/edges in the SAME transaction, proven in M05-C)
  //   verify requestedRevision === canvas.revision (else CANVAS_REVISION_STALE)
  //   load exact nodes + edges of the locked revision
  //   compile immutable graph (pure, in-memory)
  //   INSERT studio_runs (+ bulk nodes/edges, ON CONFLICT idempotency)
  //   COMMIT
  //
  // No partial Run. No unlocked reads. An internal caller cannot persist an
  // arbitrary revision/graph: _persistCompiledRun is private and only
  // reachable with a canvas row that was read under this lock.
  //
  // @param {object} params
  //   { project: {id, workspace_id}, canvasId, requestedCanvasRevision,
  //     runMode, selectedNodeIds, idempotencyKey, requestedBy }
  // @returns {Promise<{ok:true, runId, status, idempotent, nodeCount, edgeCount, graph, canvasRevision}
  //   | throws typed errors {code: CANVAS_NOT_FOUND|CANVAS_REVISION_STALE|<compile code>|...}>}
  async function createRunFromCanvas(params) {
    const {
      project, canvasId, requestedCanvasRevision,
      runMode = 'ALL', selectedNodeIds, idempotencyKey, requestedBy,
    } = params || {};
    const key = String(idempotencyKey || '').trim();
    if (!project || !project.id) throw Object.assign(new Error('INVALID_RUN_INPUT'), { code: 'INVALID_RUN_INPUT' });
    if (!canvasId) throw Object.assign(new Error('INVALID_CANVAS_ID'), { code: 'INVALID_CANVAS_ID' });
    if (!Number.isInteger(requestedCanvasRevision) || requestedCanvasRevision < 1) {
      throw Object.assign(new Error('INVALID_CANVAS_REVISION'), { code: 'INVALID_CANVAS_REVISION' });
    }
    if (!key) throw Object.assign(new Error('INVALID_IDEMPOTENCY_KEY'), { code: 'INVALID_IDEMPOTENCY_KEY' });
    if (key.length > 128) throw Object.assign(new Error('INVALID_IDEMPOTENCY_KEY'), { code: 'INVALID_IDEMPOTENCY_KEY' });
    if (!['ALL', 'SELECTED', 'FROM_NODE'].includes(runMode)) throw Object.assign(new Error('INVALID_RUN_MODE'), { code: 'INVALID_RUN_MODE' });
    if (runMode !== 'ALL') {
      const ids = (Array.isArray(selectedNodeIds) ? selectedNodeIds : []).map((s) => String(s).trim()).filter(Boolean);
      if (!ids.length) throw Object.assign(new Error('INVALID_SELECTION'), { code: 'INVALID_SELECTION' });
      params.selectedNodeIds = ids;
    }

    const client = await pg.connect();
    try {
      await client.query('BEGIN');
      // 1) Lock the authoritative canvas row (same row every M05-C durable
      //    mutation CAS-updates in its own transaction — proven invariant).
      const cr = await client.query(
        `SELECT * FROM studio_canvases WHERE id = $1 FOR UPDATE`,
        [canvasId]
      );
      const canvas = cr.rows[0];
      if (!canvas || canvas.archived_at != null || String(canvas.project_id) !== String(project.id)) {
        await client.query('ROLLBACK');
        throw Object.assign(new Error('CANVAS_NOT_FOUND'), { code: 'CANVAS_NOT_FOUND', canvasId });
      }
      // 2) Revision gate: requested must equal the authoritative locked revision.
      if (Number(canvas.revision) !== requestedCanvasRevision) {
        await client.query('ROLLBACK');
        const current = Number(canvas.revision);
        throw Object.assign(
          new Error('CANVAS_REVISION_STALE'),
          { code: 'CANVAS_REVISION_STALE', currentRevision: current, requestedRevision: requestedCanvasRevision, canvasId }
        );
      }
      // 3) Exact durable graph of THIS revision (read under the row lock).
      const [nr, er] = await Promise.all([
        client.query('SELECT * FROM studio_canvas_nodes WHERE canvas_id=$1', [canvas.id]),
        client.query('SELECT * FROM studio_canvas_edges WHERE canvas_id=$1', [canvas.id]),
      ]);
      const nodes = nr.rows.map((r) => ({
        nodeId: r.node_id, nodeType: r.node_type, nodeSchemaVersion: r.node_schema_version,
        data: r.data_json || {},
      }));
      const edges = er.rows.map((r) => ({
        edgeId: r.edge_id, sourceNodeId: r.source_node_id, sourceHandle: r.source_handle,
        targetNodeId: r.target_node_id, targetHandle: r.target_handle, edgeType: r.edge_type,
      }));
      // 4) Compile + persist atomically (private path; canvas row verified above).
      const result = await _persistCompiledRun(client, {
        project, canvas, nodes, edges,
        runMode, selectedNodeIds, idempotencyKey: key, requestedBy,
      });
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally { client.release(); }
  }

  /**
   * PRIVATE: compile + persist one coherent Run snapshot from an already
   * verified canvas row (read under FOR UPDATE by createRunFromCanvas).
   * Never exported: it cannot be driven with an arbitrary revision/graph.
   */
  async function _persistCompiledRun(client, { project, canvas, nodes, edges, runMode, selectedNodeIds, idempotencyKey, requestedBy }) {
    const canvasId = canvas.id;
    const key = idempotencyKey;

    // Idempotent retry: same canvas + same key -> return the existing run
    // (read under the canvas lock, so a rival create is already committed or
    // waiting on our lock — no check-then-insert race).
    const prior = await client.query(
      'SELECT id, status, compiled_graph_json FROM studio_runs WHERE canvas_id=$1 AND idempotency_key=$2',
      [canvasId, key]
    );
    if (prior.rows.length) {
      const row = prior.rows[0];
      return { ok: true, runId: row.id, status: row.status, idempotent: true, canvasRevision: Number(canvas.revision), graph: row.compiled_graph_json };
    }

    const compiled = compileStudioGraph({
      canvasId, canvasRevision: Number(canvas.revision), canvasSchemaVersion: Number(canvas.schema_version),
      runMode, selectedNodeIds, nodes, edges, maxAttempts: LIMITS.maxAttempts,
    });
    if (!compiled.ok) {
      const err = compiled.error;
      log('run.compile_failed', { canvasId, canvasRevision: Number(canvas.revision), code: err.code, nodeIds: err.nodeIds });
      throw Object.assign(new Error(err.code), { code: err.code, structured: err });
    }
    const graph = compiled.graph;

    // Initial status per node: zero-executable-dependencies -> READY else BLOCKED.
    const nodeRows = [];
    for (const n of graph.nodes) {
      nodeRows.push({
        run_id: null, // set below
        studio_node_id: n.nodeId,
        node_type: n.nodeType,
        execution_kind: n.executionKind,
        status: n.dependencies.length === 0 ? 'READY' : 'BLOCKED',
        dependency_count: n.dependencies.length,
        remaining_dependency_count: n.dependencies.length,
        attempt: 0,
        max_attempts: n.maxAttempts,
        input_json: n.input,
      });
    }
    const edgeRows = [];
    for (const n of graph.nodes) {
      for (const dep of n.dependencies) edgeRows.push({ run_id: null, source_node_id: dep, target_node_id: n.nodeId });
    }

    const anyBridgePending = graph.nodes.some((n) => n.executionKind === 'GENERATION');
    const runId = `run-${crypto.randomUUID()}`;
    const counts = { READY: 0, BLOCKED: 0 };
    for (const r of nodeRows) counts[r.status] += 1;
    // Run with only bridge-pending generation nodes can never finish in D1 -> BLOCKED (documented D1 policy).
    let initialStatus = 'QUEUED';
    if (anyBridgePending && graph.nodes.every((n) => n.executionKind === 'GENERATION')) initialStatus = 'BLOCKED';
    if (!nodeRows.length) initialStatus = 'COMPLETED'; // empty executable graph: terminal, nothing to do

    const compiledJson = JSON.stringify(graph);
    // Single-statement idempotent upsert. xmax = 0 in RETURNING identifies a
    // FRESH insert (xmax = 0 for a newly inserted row; a row touched by
    // ON CONFLICT DO UPDATE has xmax = the rival's xid) — this is the only
    // correct way to detect it: a DO UPDATE RETURNING yields the EXISTING
    // row's id, so comparing against our generated runId would wrongly treat
    // a rival's run as ours and bulk-insert duplicate node rows (23503).
    const nr = await client.query(
      `INSERT INTO studio_runs (id, workspace_id, project_id, canvas_id, canvas_revision, canvas_schema_version, status, run_mode, compiled_graph_json, requested_by, idempotency_key, node_status_counts, nodes_total, executor_unavailable, created_at, updated_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW(),$15)
       ON CONFLICT (canvas_id, idempotency_key) DO UPDATE
         SET updated_at = studio_runs.updated_at
       RETURNING id, status, compiled_graph_json, (xmax = 0) AS is_fresh`,
      [runId, project.workspace_id, project.id, canvasId, Number(canvas.revision), Number(canvas.schema_version), initialStatus, runMode,
       compiledJson, requestedBy, key, JSON.stringify(counts), nodeRows.length, anyBridgePending, initialStatus === 'COMPLETED' ? new Date() : null]
    );
    const runRow = nr.rows[0];
    const createdFresh = runRow.is_fresh === true;
    // Concurrency: a rival insert with the same idempotency key may win the
    // conflict (DO UPDATE fires, is_fresh=false); the bulk node/edge inserts
    // MUST be skipped — the existing run already carries its own graph
    // (unique (run_id,studio_node_id)).
    if (createdFresh) {
      for (const r of nodeRows) r.run_id = runRow.id;
      if (nodeRows.length) await bulkInsertRunNodes(client, nodeRows);
      if (edgeRows.length) {
        for (const r of edgeRows) r.run_id = runRow.id;
        await bulkInsertRunEdges(client, edgeRows);
      }
    }

    log('run.created', { runId: runRow.id, canvasId, canvasRevision: Number(canvas.revision), nodeCount: nodeRows.length, edgeCount: edgeRows.length, status: runRow.status, idempotent: !createdFresh, workerId });
    return {
      ok: true, runId: runRow.id, status: runRow.status, idempotent: !createdFresh,
      canvasRevision: Number(canvas.revision),
      nodeCount: nodeRows.length, edgeCount: edgeRows.length, graph: runRow.compiled_graph_json,
    };
  }
  // ── END SECTION:create-run ─────────────────────────────────────────────

  // ── SECTION:scheduling ─────────────────────────────────────────────────

  /** Load the full run-node state for one run (small: one run at a time). */
  async function loadRunNodes(runId) {
    const r = await pg.query('SELECT * FROM studio_run_nodes WHERE run_id=$1', [runId]);
    return r.rows;
  }

  /**
   * Durable lease acquisition (STEP 19): one short transaction,
   * FOR UPDATE SKIP LOCKED, bounded LIMIT, indexed eligibility path.
   * Only non-cancelled QUEUED/RUNNING/WAITING runs are eligible.
   * The first leased node flips the run QUEUED->RUNNING (STEP 27).
   *
   * @returns {Promise<Array>} the leased node rows (0..limit)
   */
  async function leaseReadyNodes(opts = {}) {
    const limit = Math.max(1, Math.min(pollLimit, Number(opts.limit) || pollLimit));
    const client = await pg.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `WITH picked AS (
           SELECT n.id
             FROM studio_run_nodes n
             JOIN studio_runs r ON r.id = n.run_id
            WHERE n.status = 'READY'
              AND (n.next_retry_at IS NULL OR n.next_retry_at <= NOW())
              AND r.status IN ('QUEUED','RUNNING','WAITING')
              AND r.cancel_requested_at IS NULL
            ORDER BY n.created_at ASC, n.id ASC
            FOR UPDATE OF n SKIP LOCKED
            LIMIT $1
         )
         UPDATE studio_run_nodes n
           SET status = 'RUNNING',
               lease_owner = $2,
               lease_token = gen_random_uuid()::text,
               lease_expires_at = NOW() + ($3 * INTERVAL '1 second'),
                heartbeat_at = NOW(),
                started_at = COALESCE(n.started_at, NOW()),
                attempt = n.attempt + 1,
                updated_at = NOW()
          FROM picked
          WHERE n.id = picked.id
          RETURNING n.*`,
        [limit, workerId, leaseSeconds]
      );
      if (r.rows.length) {
        const runIds = Array.from(new Set(r.rows.map((x) => x.run_id)));
        await client.query(
          `UPDATE studio_runs SET status = 'RUNNING', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
            WHERE id = ANY($1::text[]) AND status = 'QUEUED'`,
          [runIds]
        );
        for (const row of r.rows) {
          await emitEvent(client, row.run_id, row.id, 'studio.run_node.started', { run_node_id: row.id, studio_node_id: row.studio_node_id, attempt: row.attempt });
        }
      }
      await client.query('COMMIT');
      await flushRelayQueue(client);
      return r.rows;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally { client._relayQueue = null; client.release(); }
  }

  /** Convenience wrapper: lease exactly one READY node (or null). */
  async function leaseReadyNode(opts = {}) {
    const rows = await leaseReadyNodes({ ...opts, limit: 1 });
    return rows.length ? rows[0] : null;
  }

  /**
   * Heartbeat (STEP 21): extends lease_expires_at only for the exact
   * (id, lease_owner, lease_token) in an active leased state. Stale/wrong
   * tokens are safe no-ops.
   * @returns {Promise<boolean>} true if extended
   */
  async function heartbeatLease(runNodeId, { owner, token, extendSeconds } = {}) {
    const ext = Math.max(5, Math.min(900, Number(extendSeconds) || leaseSeconds));
    const r = await pg.query(
      `UPDATE studio_run_nodes
          SET lease_expires_at = NOW() + ($2 * INTERVAL '1 second'), heartbeat_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND lease_owner = $3 AND lease_token = $4
          AND status IN ('RUNNING','LEASED','WAITING')
          AND lease_expires_at > NOW()
        RETURNING id`,
      [runNodeId, ext, owner || null, token || null]
    );
    return r.rows.length > 0;
  }

  /**
   * Expired-lease reaper (STEP 22) — restart-safe recovery, no manual repair.
   * Expired leased/running nodes:
   *   - attempts remain  -> READY with bounded backoff (next_retry_at)
   *   - attempts used up -> FAILED + downstream blocked + run aggregated
   * A stale worker's later completion with the old token is rejected by
   * token+status fencing in completeRunNode/failRunNode.
   *
   * @returns {Promise<{reaped:number, failed:number}>}
   */
  async function reapExpiredNodes(opts = {}) {
    const limit = Math.max(1, Math.min(500, Number(opts.limit) || LIMITS.reaperBatch));
    const client = await pg.connect();
    let reaped = 0; let failed = 0; let cancelled = 0;
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `WITH expired AS (
           SELECT n.id, n.run_id, n.studio_node_id, n.attempt, n.max_attempts,
                  (run.cancel_requested_at IS NOT NULL) AS cancel_requested
             FROM studio_run_nodes n
             JOIN studio_runs run ON run.id = n.run_id
            WHERE n.status IN ('RUNNING','LEASED','WAITING')
              AND n.lease_expires_at IS NOT NULL
              AND n.lease_expires_at <= NOW()
              AND run.status IN ('QUEUED','RUNNING','WAITING')
            ORDER BY n.lease_expires_at ASC
            FOR UPDATE OF n SKIP LOCKED
            LIMIT $1
         )
         UPDATE studio_run_nodes n
            SET status = CASE
                  WHEN e.cancel_requested THEN 'CANCELLED'
                  WHEN e.attempt >= e.max_attempts THEN 'FAILED'
                  ELSE 'READY' END,
                next_retry_at = CASE
                  WHEN e.cancel_requested OR e.attempt >= e.max_attempts THEN NULL
                  ELSE NOW() + ($2 * INTERVAL '1 millisecond') END,
                error_code = CASE
                  WHEN e.cancel_requested THEN 'RUN_CANCELLED'
                  WHEN e.attempt >= e.max_attempts THEN 'LEASE_EXPIRED'
                  ELSE n.error_code END,
                error_message = CASE
                  WHEN e.cancel_requested THEN 'run cancellation requested'
                  WHEN e.attempt >= e.max_attempts THEN 'worker lease expired and retries exhausted'
                  ELSE n.error_message END,
                lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                completed_at = CASE
                  WHEN e.cancel_requested OR e.attempt >= e.max_attempts THEN NOW()
                  ELSE n.completed_at END,
                updated_at = NOW()
          FROM expired e
          WHERE n.id = e.id
          RETURNING n.*, e.max_attempts AS reap_max_attempts, e.cancel_requested AS reap_cancel_requested`,
        [limit, Math.max(0, retryDelayMs(1, opts.retryBackoffMs || defaultRetryBackoffMs))]
      );
      const reapedIds = [];
      for (const row of r.rows) {
        reapedIds.push(row.id);
        if (row.status === 'CANCELLED') {
          // A cancelled run's expired in-flight node must NOT go back to READY:
          // the lease path refuses cancel_requested_at runs and this reaper only
          // touches RUNNING/LEASED/WAITING, so a READY node here would strand the
          // run nonterminal forever. Cancel it so the run can reach CANCELLED.
          cancelled += 1;
          await emitEvent(client, row.run_id, row.id, 'studio.run_node.cancelled', { run_node_id: row.id, code: 'RUN_CANCELLED' });
          await aggregateRun(client, row.run_id, { runNodeId: row.id, workerId });
        } else if (row.status === 'FAILED') {
          failed += 1;
          await blockDependents(client, row.run_id, row.studio_node_id, 'UPSTREAM_FAILED');
          await emitEvent(client, row.run_id, row.id, 'studio.run_node.failed', { run_node_id: row.id, code: 'LEASE_EXPIRED', final: true });
          await aggregateRun(client, row.run_id, { runNodeId: row.id, workerId });
        } else {
          reaped += 1;
          await emitEvent(client, row.run_id, row.id, 'studio.run_node.ready', { run_node_id: row.id, retry: true });
        }
      }
      if (reapedIds.length) {
        await client.query(
          `UPDATE studio_runs SET status = CASE WHEN status = 'QUEUED' THEN 'RUNNING' ELSE status END,
                started_at = COALESCE(started_at, NOW()), updated_at = NOW() WHERE id = ANY($1::text[])`,
          [Array.from(new Set(r.rows.map((x) => x.run_id)))]
        );
      }
      await client.query('COMMIT');
      await flushRelayQueue(client);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally { client._relayQueue = null; client.release(); }
    log('reaper.tick', { reaped, failed, cancelled, workerId });
    return { reaped, failed, cancelled };
  }
  // ── END SECTION:scheduling ─────────────────────────────────────────────

  // ── SECTION:worker ─────────────────────────────────────────────────────

  /**
   * Set-based failure propagation (STEP 36): transitive downstream of a
   * permanently failed node -> CANCELLED (dependency-failed equivalent) in
   * ONE recursive UPDATE. No per-child round trips; a run whose downstream
   * was cut off cannot go READY.
   */
  async function blockDependents(client, runId, failedNodeId, code) {
    await client.query(
      `WITH RECURSIVE downstream AS (
         SELECT target_node_id AS studio_node_id
           FROM studio_run_node_edges
          WHERE run_id = $1 AND source_node_id = $2
         UNION
         SELECT e.target_node_id
           FROM studio_run_node_edges e JOIN downstream d ON d.studio_node_id = e.source_node_id
          WHERE e.run_id = $1
       )
       UPDATE studio_run_nodes n
          SET status = 'CANCELLED', error_code = 'DEPENDENCY_FAILED',
              error_message = 'upstream node permanently failed',
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
              next_retry_at = NULL, updated_at = NOW()
         FROM downstream d
        WHERE n.run_id = $1 AND n.studio_node_id = d.studio_node_id
          AND n.status IN ('READY','BLOCKED')`,
      [runId, failedNodeId]
    );
  }

  /**
   * Run state aggregation (STEP 26) — deterministic, from durable counts only.
   * Must run inside an open transaction with the run row locked (FOR UPDATE).
   */
  async function aggregateRun(client, runId, meta = {}) {
    const lockR = await client.query('SELECT id FROM studio_runs WHERE id=$1 FOR UPDATE', [runId]);
    if (!lockR.rows.length) return null;
    const cr = await client.query(
      'SELECT status, COUNT(*)::int AS c FROM studio_run_nodes WHERE run_id=$1 GROUP BY status',
      [runId]
    );
    const counts = {};
    for (const row of cr.rows) counts[row.status] = row.c;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const succeeded = counts.SUCCEEDED || 0;
    const skipped = counts.SKIPPED || 0;
    const failed = counts.FAILED || 0;
    const cancelled = counts.CANCELLED || 0;
    const active = (counts.READY || 0) + (counts.BLOCKED || 0) + (counts.LEASED || 0) + (counts.RUNNING || 0) + (counts.WAITING || 0);
    const cancelR = await client.query('SELECT status, cancel_requested_at, failure_code, executor_unavailable FROM studio_runs WHERE id=$1', [runId]);
    const runRow = cancelR.rows[0];
    let next = runRow.status;
    let terminal = false;
    let failCode = null;
    let failMsg = null;
    const allTerminal = active === 0;

    if (runRow.cancel_requested_at) {
      // D1 cancel foundation: no new leasing (lease path checks the flag);
      // terminal CANCELLED only once every node is terminal (active workers
      // finish or are reaped; cooperative cancellation is M05-D2).
      if (allTerminal) { next = 'CANCELLED'; terminal = true; }
    } else if (allTerminal && failed > 0) {
      next = 'FAILED'; terminal = true; failCode = runRow.failure_code || 'NODE_FAILED'; failMsg = 'one or more required nodes failed';
    } else if (allTerminal && succeeded + skipped === total) {
      next = 'COMPLETED'; terminal = true;
    } else if (allTerminal) {
      // Safety net: terminal state with unsatisfied work (should not happen
      // after failure propagation, but never leave an endless nonterminal run).
      next = 'FAILED'; terminal = true; failCode = runRow.failure_code || 'RUN_INCOMPLETE'; failMsg = 'run reached terminal state with unsatisfied dependencies';
    } else if (runRow.executor_unavailable && succeeded === 0 && cancelled === 0 && (counts.BLOCKED || 0) > 0 && active === (counts.BLOCKED || 0)) {
      next = 'BLOCKED'; // D1 policy: bridge-pending-only graph parks deterministically
    }

    if (next !== runRow.status) {
      await client.query(
        `UPDATE studio_runs
            SET status = $2, node_status_counts = $3, nodes_total = $4,
                completed_at = CASE WHEN $5::boolean THEN NOW() ELSE completed_at END,
                failure_code = COALESCE($6, failure_code), failure_message = COALESCE($7, failure_message),
                updated_at = NOW()
          WHERE id = $1`,
        [runId, next, JSON.stringify(counts), total, terminal, failCode, failMsg]
      );
      const evt = next === 'COMPLETED' ? 'studio.run.completed'
        : next === 'FAILED' ? 'studio.run.failed'
        : next === 'CANCELLED' ? 'studio.run.cancelled'
        : 'studio.run.status';
      await emitEvent(client, runId, meta.runNodeId || null, evt, { status: next, counts });
      log('run.status', { runId, from: runRow.status, to: next, counts, workerId: meta.workerId });
    } else {
      // keep durable counts fresh even when status unchanged
      await client.query('UPDATE studio_runs SET node_status_counts=$2, nodes_total=$3, updated_at=NOW() WHERE id=$1', [runId, JSON.stringify(counts), total]);
    }
    return { runId, status: next, counts, total };
  }

  /**
   * Node completion (STEP 24). One short transaction:
   *   1. fence: (id, lease_owner, lease_token, status=RUNNING, lease unexpired)
   *   2. idempotency: node already SUCCEEDED -> safe no-op return
   *   3. store sanitized result, mark SUCCEEDED, release lease
   *   4. atomic fan-out: decrement direct dependents; 0 -> READY (SET-BASED)
   *   5. aggregate run state (same tx, run row locked)
   *
   * @returns {Promise<{ok:boolean, staleToken?:boolean, idempotent?:boolean, unlocked?:string[]}>}
   */
  async function completeRunNode(runNodeId, { owner, token, result }) {
    const client = await pg.connect();
    let released = false;
    const releaseOnce = () => { if (!released) { released = true; client.release(); } };
    try {
      await client.query('BEGIN');
      const fr = await client.query(
        `SELECT n.*, r.project_id AS run_project_id
           FROM studio_run_nodes n
           JOIN studio_runs r ON r.id = n.run_id
          WHERE n.id = $1
          FOR UPDATE OF n`,
        [runNodeId]
      );
      const node = fr.rows[0];
      if (!node) { await client.query('ROLLBACK'); return { ok: false, notFound: true }; }
      if (node.status === 'SUCCEEDED' || node.status === 'FAILED' || node.status === 'CANCELLED' || node.status === 'SKIPPED') {
        await client.query('COMMIT');
        return { ok: true, idempotent: true, runId: node.run_id, nodeStatus: node.status };
      }
      if (node.status !== 'RUNNING' || node.lease_owner !== owner || node.lease_token !== token) {
        await client.query('COMMIT');
        log('run.node.stale_completion', { runNodeId, owner, expected: node.lease_owner, runId: node.run_id });
        return { ok: false, staleToken: true, nodeStatus: node.status };
      }
      // lease must still be live (expired lease = reaper owns recovery)
      const exp = node.lease_expires_at ? new Date(node.lease_expires_at) : null;
      if (exp && exp.getTime() <= Date.now()) {
        await client.query('COMMIT');
        return { ok: false, staleToken: true, nodeStatus: 'lease_expired' };
      }
      let resultJson = result;
      try {
        const s = JSON.stringify(resultJson);
        if (Buffer.byteLength(s) > LIMITS.maxResultBytes) resultJson = { truncated: true };
      } catch (_) { resultJson = { invalidResult: true }; }

      await client.query(
        `UPDATE studio_run_nodes
            SET status = 'SUCCEEDED', result_json = $2,
                lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                completed_at = NOW(), error_code = NULL, error_message = NULL, updated_at = NOW()
          WHERE id = $1`,
        [runNodeId, JSON.stringify(resultJson)]
      );
      // Atomic set-based fan-out decrement (STEP 18/34/35): ONE UPDATE does
      // both the decrement AND the 1->0 READY transition, so the transition
      // happens exactly once in SQL and never goes negative (rem > 0 guard).
      // (Not a "UPDATE-in-CTE + outer UPDATE" form: PostgreSQL CTEs are
      // optimization fences — the outer statement would not see the CTE's
      // updated values and the flip would silently never fire.)
      const un = await client.query(
        `UPDATE studio_run_nodes n
            SET remaining_dependency_count = n.remaining_dependency_count - 1,
                status = CASE WHEN n.remaining_dependency_count - 1 = 0 THEN 'READY' ELSE n.status END,
                next_retry_at = CASE WHEN n.remaining_dependency_count - 1 = 0 THEN NULL ELSE n.next_retry_at END,
                updated_at = NOW()
           FROM studio_run_node_edges e
          WHERE e.run_id = $1 AND e.source_node_id = $2
            AND n.run_id = $1 AND n.studio_node_id = e.target_node_id
            AND n.status = 'BLOCKED'
            AND n.remaining_dependency_count > 0
          RETURNING n.id AS run_node_id, n.studio_node_id, n.remaining_dependency_count`,
        [node.run_id, node.studio_node_id]
      );
      await emitEvent(client, node.run_id, runNodeId, 'studio.run_node.succeeded', { run_node_id: runNodeId, studio_node_id: node.studio_node_id, attempt: node.attempt });
      // Only the rows that actually hit 0 flipped to READY (the UPDATE's CASE
      // guarantees post-update rem=0 <=> status became READY).
      const unlockedRows = un.rows.filter((r) => r.remaining_dependency_count === 0);
      for (const u of unlockedRows) {
        await emitEvent(client, node.run_id, u.run_node_id, 'studio.run_node.ready', { run_node_id: u.run_node_id, studio_node_id: u.studio_node_id });
      }
      await aggregateRun(client, node.run_id, { runNodeId: runNodeId, workerId: owner });
      await client.query('COMMIT');
      await flushRelayQueue(client);
      // Release BEFORE the spend: budgetSpentStore.recordSpend opens its OWN pool
      // connection (pg.connect), so holding ours — even idle — could deadlock a
      // maxed-out pool. The spend is best-effort and runs after the run is
      // durably committed; it can never throw or roll back the run.
      releaseOnce();
      await recordNodeSpend(runNodeId, node.run_project_id, result);
      log('run.node.succeeded', { runId: node.run_id, studioNodeId: node.studio_node_id, attempt: node.attempt, unlocked: unlockedRows.map((r) => r.studio_node_id), workerId: owner });
      return { ok: true, runId: node.run_id, unlocked: unlockedRows.map((r) => r.studio_node_id) };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally { client._relayQueue = null; releaseOnce(); }
  }

  /**
   * Node failure (STEP 25). One short transaction with the same fencing as
   * completion. Transient + attempts remain -> retry_wait (READY + bounded
   * backoff next_retry_at). Otherwise FAILED + transitive downstream block +
   * run aggregation (run may end FAILED/BLOCKED deterministically).
   *
   * @returns {Promise<{ok:boolean, staleToken?:boolean, nodeStatus?:string, retried?:boolean, failed?:boolean}>}
   */
  async function failRunNode(runNodeId, { owner, token, error, retryBackoffMs } = {}) {
    const { code, message } = sanitizeError(error || new Error('unknown failure'));
    const client = await pg.connect();
    try {
      await client.query('BEGIN');
      const fr = await client.query(
        `SELECT n.*, r.cancel_requested_at AS run_cancel_requested_at
           FROM studio_run_nodes n
           JOIN studio_runs r ON r.id = n.run_id
          WHERE n.id = $1
          FOR UPDATE OF n`,
        [runNodeId]
      );
      const node = fr.rows[0];
      if (!node) { await client.query('ROLLBACK'); return { ok: false, notFound: true }; }
      if (TERMINAL_NODE.has(node.status)) {
        await client.query('COMMIT');
        return { ok: true, idempotent: true, nodeStatus: node.status };
      }
      if (node.status !== 'RUNNING' || node.lease_owner !== owner || node.lease_token !== token) {
        await client.query('COMMIT');
        log('run.node.stale_failure', { runNodeId, owner, expected: node.lease_owner, runId: node.run_id });
        return { ok: false, staleToken: true, nodeStatus: node.status };
      }
      const exp = node.lease_expires_at ? new Date(node.lease_expires_at) : null;
      if (exp && exp.getTime() <= Date.now()) {
        await client.query('COMMIT');
        return { ok: false, staleToken: true, nodeStatus: 'lease_expired' };
      }
      // Cancellation requested while this node was in flight: do NOT retry to
      // READY — a READY node under a cancel_requested_at run can never be
      // re-leased (lease path checks the flag) and this node is no longer
      // RUNNING, so the reaper won't recover it either. It would strand the
      // run nonterminal forever. Cancel it instead and let aggregateRun drive
      // the run to terminal CANCELLED.
      if (node.run_cancel_requested_at != null) {
        await client.query(
          `UPDATE studio_run_nodes
              SET status = 'CANCELLED', error_code = 'RUN_CANCELLED', error_message = 'run cancellation requested',
                  lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                  completed_at = NOW(), updated_at = NOW()
            WHERE id = $1`,
          [runNodeId]
        );
        await emitEvent(client, node.run_id, runNodeId, 'studio.run_node.cancelled', { run_node_id: runNodeId, code: 'RUN_CANCELLED' });
        const agg = await aggregateRun(client, node.run_id, { runNodeId: runNodeId, workerId: owner });
        await client.query('COMMIT');
        await flushRelayQueue(client);
        log('run.node.cancelled', { runId: node.run_id, studioNodeId: node.studio_node_id, runStatus: agg && agg.status, workerId: owner });
        return { ok: true, cancelled: true, nodeStatus: 'CANCELLED', runStatus: agg && agg.status, runId: node.run_id };
      }
      const retryable = error && error.retryable !== false && code !== 'PERMANENT';
      const attemptsLeft = node.attempt < node.max_attempts;
      if (retryable && attemptsLeft) {
        const delayMs = retryDelayMs(node.attempt, retryBackoffMs || defaultRetryBackoffMs);
        await client.query(
          `UPDATE studio_run_nodes
              SET status = 'READY', next_retry_at = NOW() + ($2 * INTERVAL '1 millisecond'),
                  error_code = $3, error_message = $4,
                  lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
            WHERE id = $1`,
          [runNodeId, delayMs, code, message]
        );
        await emitEvent(client, node.run_id, runNodeId, 'studio.run_node.retry', { run_node_id: runNodeId, attempt: node.attempt, code, delayMs });
        await aggregateRun(client, node.run_id, { runNodeId: runNodeId, workerId: owner });
        await client.query('COMMIT');
        await flushRelayQueue(client);
        log('run.node.retry', { runId: node.run_id, studioNodeId: node.studio_node_id, attempt: node.attempt, delayMs, workerId: owner });
        return { ok: true, retried: true, nodeStatus: 'READY', delayMs, runId: node.run_id };
      }
      // Permanent failure
      await client.query(
        `UPDATE studio_run_nodes
            SET status = 'FAILED', error_code = $2, error_message = $3,
                lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
                completed_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [runNodeId, code, message]
      );
      await blockDependents(client, node.run_id, node.studio_node_id, 'DEPENDENCY_FAILED');
      await emitEvent(client, node.run_id, runNodeId, 'studio.run_node.failed', { run_node_id: runNodeId, code, final: true });
      const agg = await aggregateRun(client, node.run_id, { runNodeId: runNodeId, workerId: owner });
      await client.query('COMMIT');
      await flushRelayQueue(client);
      log('run.node.failed', { runId: node.run_id, studioNodeId: node.studio_node_id, code, runStatus: agg && agg.status, workerId: owner });
      return { ok: true, failed: true, nodeStatus: 'FAILED', runStatus: agg && agg.status, runId: node.run_id };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally { client._relayQueue = null; client.release(); }
  }
  // ── SECTION:worker ─────────────────────────────────────────────────────

  /**
   * Cooperative run cancellation (STEP 41, D1 foundation):
   *  - durable cancel_requested_at on the run
   *  - READY/BLOCKED nodes -> CANCELLED immediately (set-based)
   *  - LEASED/RUNNING/WAITING: workers keep their lease (cooperative cancel
   *    is M05-D2/M05-E); the lease still expires and the reaper recovers.
   *  - new nodes never lease again (lease path checks the flag).
   * @returns {Promise<{ok:boolean, status?:string, cancelledNodes?:number}>}
   */
  async function requestRunCancellation(runId) {
    const client = await pg.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `UPDATE studio_runs
            SET cancel_requested_at = COALESCE(cancel_requested_at, NOW()), updated_at = NOW()
          WHERE id = $1 AND status IN ('QUEUED','RUNNING','WAITING','BLOCKED')
          RETURNING id, status`,
        [runId]
      );
      if (!r.rows.length) { await client.query('ROLLBACK'); return { ok: false, notFound: true }; }
      const cr = await client.query(
        `UPDATE studio_run_nodes
            SET status = 'CANCELLED', error_code = 'RUN_CANCELLED', error_message = 'run cancellation requested',
                lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, next_retry_at = NULL, updated_at = NOW()
          WHERE run_id = $1 AND status IN ('READY','BLOCKED')
          RETURNING id`,
        [runId]
      );
      await emitEvent(client, runId, null, 'studio.run.cancel_requested', { status: r.rows[0].status });
      await aggregateRun(client, runId, { workerId });
      await client.query('COMMIT');
      await flushRelayQueue(client);
      log('run.cancel_requested', { runId, cancelledNodes: cr.rowCount, workerId });
      return { ok: true, status: r.rows[0].status, cancelledNodes: cr.rowCount };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally { client._relayQueue = null; client.release(); }
  }

  /**
   * Worker tick (STEP 28): lease -> execute OUTSIDE any transaction ->
   * complete/fail. The process is never the business authority: it can die
   * at any point and the reaper recovers via lease expiry.
   * Returns the number of nodes processed this tick.
   */
  async function workerTick(opts = {}) {
    let processed = 0;
    const concurrency = Math.max(1, Math.min(16, Number(opts.concurrency) || 1));
    const batch = Math.max(1, Math.min(pollLimit, Number(opts.batch) || pollLimit));
    const leased = [];
    for (let i = 0; i < batch; i++) {
      const node = await leaseReadyNode({ limit: 1 });
      if (!node) break;
      leased.push(node);
    }
    if (!leased.length) return 0;
    const executors = Math.min(concurrency, leased.length);
    const queue = [...leased];
    const runners = Array.from({ length: executors }, async () => {
      while (queue.length) {
        const node = queue.shift();
        const started = Date.now();
        let ctx;
        try {
          ctx = await buildExecContext(node);
        } catch (e) {
          try { await failRunNode(node.id, { owner: node.lease_owner, token: node.lease_token, error: e, retryBackoffMs: opts.retryBackoffMs }); } catch (_) {}
          continue;
        }
        const res = await registry.resolveExecutor(
          { nodeId: node.studio_node_id, nodeType: node.node_type },
          ctx
        );
        if (!res.ok) {
          // EXECUTOR_NOT_AVAILABLE (M05-E bridge boundary) or unknown type:
          // no fake result, no fabricated media — the node parks durably.
          const park = await parkNodeForBridge(node, res.code);
          log('run.node.parked', { runId: node.run_id, studioNodeId: node.studio_node_id, code: res.code, park, workerId });
          continue;
        }
        try {
          const out = await res.executor.execute(ctx);
          const result = out && out.result !== undefined ? out.result : (out === undefined ? {} : out);
          await completeRunNode(node.id, { owner: node.lease_owner, token: node.lease_token, result });
          processed += 1;
        } catch (e) {
          await failRunNode(node.id, { owner: node.lease_owner, token: node.lease_token, error: e, retryBackoffMs: opts.retryBackoffMs });
          processed += 1;
        }
        const dur = Date.now() - started;
        log('run.node.tick_done', { runId: node.run_id, studioNodeId: node.studio_node_id, attempt: node.attempt, durationMs: dur, workerId });
      }
    });
    await Promise.all(runners);
    return processed;
  }

  /**
   * Park a node whose executor is unavailable (M05-E bridge boundary).
   * Deterministic: node -> WAITING, lease released, no retry loop.
   * The run stays nonterminal (WAITING) until M05-E supplies a bridge.
   */
  async function parkNodeForBridge(node, code) {
    const r = await pg.query(
      `UPDATE studio_run_nodes
          SET status = 'WAITING', error_code = $2, error_message = 'waiting for external generation bridge (M05-E)',
              lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, next_retry_at = NULL, updated_at = NOW()
        WHERE id = $1 AND lease_owner = $3 AND lease_token = $4
        RETURNING id`,
      [node.id, code || 'EXECUTOR_NOT_AVAILABLE', node.lease_owner, node.lease_token]
    );
    if (r.rows.length) {
      const client = await pg.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE studio_runs SET status = CASE WHEN status IN (\'QUEUED\',\'BLOCKED\') THEN \'WAITING\' ELSE status END, updated_at = NOW() WHERE id=$1', [node.run_id]);
        await emitEvent(client, node.run_id, node.id, 'studio.run_node.waiting', { run_node_id: node.id, code: code || 'EXECUTOR_NOT_AVAILABLE' });
        await aggregateRun(client, node.run_id, { runNodeId: node.id, workerId });
        await client.query('COMMIT');
        await flushRelayQueue(client);
      } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; } finally { client._relayQueue = null; client.release(); }
    }
    return r.rows.length > 0;
  }

  /** Build the deterministic execution context from durable rows only. */
  async function buildExecContext(node) {
    const input = node.input_json || {};
    // NOTE: studio_run_nodes has NO `dependencies` column — the dependency
    // relation lives in studio_run_node_edges. Guard with Array.isArray (an
    // empty array is truthy, so the old `(node.dependencies || []) && …`
    // evaluated `undefined.length` and threw for EVERY node, bricking workerTick).
    const depIds = Array.isArray(node.dependencies) && node.dependencies.length
      ? node.dependencies
      : await (async () => {
        const r = await pg.query(
          'SELECT source_node_id FROM studio_run_node_edges WHERE run_id=$1 AND target_node_id=$2',
          [node.run_id, node.studio_node_id]
        );
        return r.rows.map((x) => x.source_node_id);
      })();
    const ur = await pg.query(
      `SELECT studio_node_id, result_json FROM studio_run_nodes WHERE run_id=$1 AND studio_node_id = ANY($2::text[]) AND status = 'SUCCEEDED'`,
      [node.run_id, depIds]
    );
    const upstreamResults = {};
    for (const row of ur.rows) upstreamResults[row.studio_node_id] = row;
    return {
      runId: node.run_id,
      nodeId: node.studio_node_id,
      nodeType: node.node_type,
      attempt: node.attempt,
      input: { parameters: input.parameters || {}, ...(input.assetId ? { assetId: input.assetId } : {}), ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}) },
      dependencies: depIds,
      upstreamResults,
    };
  }

  /** Read-only run snapshot (STEP 42): metadata + counts + nodes (safe). */
  async function getRunSnapshot(runId) {
    const rr = await pg.query('SELECT * FROM studio_runs WHERE id=$1', [runId]);
    if (!rr.rows.length) return null;
    const run = rr.rows[0];
    const nr = await pg.query(
      `SELECT id, studio_node_id, node_type, execution_kind, status, dependency_count,
              remaining_dependency_count, attempt, max_attempts, error_code, error_message,
              started_at, completed_at, result_json
         FROM studio_run_nodes WHERE run_id=$1
        ORDER BY studio_node_id ASC LIMIT 5000`,
      [runId]
    );
    return { run, nodes: nr.rows };
  }
  // ── END SECTION:worker ─────────────────────────────────────────────────

  return {
    LIMITS, registry, workerId,
    // populated by section includes (see module.exports below)
    createRunFromCanvas, loadRunNodes, leaseReadyNodes, leaseReadyNode, heartbeatLease, completeRunNode,
    failRunNode, reapExpiredNodes, requestRunCancellation, getRunSnapshot,
    workerTick, aggregateRun,
  };
}

module.exports = { createStudioRunEngine, sanitizeError, retryDelayMs, leaseToken, RUN_STATUSES, TERMINAL_RUN, ACTIVE_NODE, TERMINAL_NODE, LIMITS };
