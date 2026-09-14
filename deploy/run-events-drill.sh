#!/usr/bin/env bash
# =============================================================================
# G21 — run_events event-chain drill (deploy/run-events-drill.sh)
#
# Verifies the deployed Studio Run engine's durable event chain end-to-end:
#   seed  : a fresh user/workspace/project/canvas + one QUEUED studio_runs row
#           + one READY prompt studio_run_nodes row (tables from migrations
#           0014 studio_canvas_persistence.sql / 0015 studio_run_engine.sql;
#           event log + counter tables from 0043 run_events.sql /
#           0049 run_event_counters.sql)
#   tick  : one engine tick inside the app container (node) — build the engine
#           with the run_events relay injected (workerId=drill-1), then
#           leaseReadyNode() + completeRunNode(result)  (or failRunNode when
#           DRILL_MODE=fail) — i.e. the engine's emit funnel that relays every
#           studio.run* / studio.run_node* event into run_events
#   assert: run_events for the run has >= 2 rows AND seq contiguous with no
#           holes (COUNT = MAX-MIN+1, MIN = 1)
#   exit  : PASS (0) / FAIL (1); prints row count + per-seq event types
#
# Engine emit points (studioRunEngine.cjs emitEvent funnel + relay, verified
# 2026-09-04 against the source):
#   leaseReadyNode -> 'studio.run_node.started'      (run QUEUED->RUNNING flip
#                       happens in the same tx, no event of its own)
#   completeRunNode-> 'studio.run_node.succeeded' + via aggregateRun a run-level
#                       'studio.run.completed' when the last node finishes
#   failRunNode    -> 'studio.run_node.failed' (permanent) + 'studio.run.failed'
#   => happy path emits 3 relayed rows (node started / node done / run done)
#   relay          -> runEventRelay.cjs relayRunEvent -> runEventStore
#                     appendNextRunEvent (atomic per-run counter -> contiguous
#                     1-based seq in run_events). Engine relay wiring:
#                     createStudioRunEngine({ pg, workerId, relay:
#                       createRunEventRelay({ pg }) })  — relay gets its OWN
#                     pooled connection (autocommit) while the engine event runs
#                     inside the engine's open transaction.
#
# KNOWN INTEGRATION TRAP (found by this drill's local self-test, real PG):
#   migration 0043 adds run_events.run_id -> studio_runs(id) FK. Because the
#   relay inserts on a SEPARATE connection while the engine tx still holds the
#   run row modified-but-uncommitted (lease flip / aggregateRun status change),
#   the relay's FK RI check blocks on the engine tx's xid -> the engine awaits
#   the relay -> deadlock. Symptom: tick hangs; two backends on the drill DB —
#   one idle-in-transaction, one waiting on a transactionid lock. If the drill
#   FAILs this way the deployment has engine(relay)+0043 FK both live and the
#   relay bridge needs an emit-after-commit / FK-relaxation fix (outside this
#   script's scope). The tick runs a watchdog that dumps pg_stat_activity
#   (lock-wait evidence) and exits instead of hanging; assertions still run.
#
# Execution layout (test machine = dedicated commercial-test host):
#   - Postgres runs in container $PG_CT  (default moling-test-postgres);
#     admin/psql ops go through `docker exec` (unix-socket auth as $PG_USER,
#     no password — same pattern as deploy/restore-drill.sh).
#   - The node tick runs in container $NODE_CT (default moling-test-api-01),
#     which carries the deployed repo at /app:
#         engine modules  /app/server/modules/project-foundation/{studioRunEngine,runEventRelay}.cjs
#         migrations      /app/server/db/migrations
#         pg driver       /app/node_modules/pg
#     Scripts are docker cp'd to /tmp in the container (hardened remote-ops
#     pattern) and executed with `node /tmp/<script>.cjs`.
#   - Env needed INSIDE $NODE_CT (compose/underscore form, same as the API):
#         PG_HOST (or PGHOST) / PG_PORT / PG_USER / PG_PASSWORD / PG_DATABASE
#     Unset values are passed through from $NODE_CT's own env (docker exec
#     printenv) with fallbacks: host 'postgres' / 5432 / user moling_test.
#     PG_DATABASE is always set by the drill.
#   - Default: a scratch DB (moling_run_events_drill_<pid>_<rand>) is created,
#     fully migrated (deployed chain applied through the container's own
#     migration files, one query per file — parity with migrate.cjs / test
#     bootstrap), then dropped on exit. DRILL_DB=<name> reuses an existing DB;
#     add DRILL_SKIP_MIGRATE=1 to skip creation+migration (DB pre-migrated).
#   - Cleanup on every exit path: seeded run rows deleted (run_events /
#     studio_run_events / studio_run_nodes via cascade or explicit delete),
#     canvas / project / workspace / user rows removed, scratch DB dropped.
#
# Usage:
#   deploy/run-events-drill.sh                 # defaults: docker, complete
#   MODE=local ... deploy/run-events-drill.sh  # no docker; direct psql+node
# Env knobs (all optional):
#   MODE=docker|local   DRILL_MODE=complete|fail   WORKER_ID=drill-1
#   PG_CT  NODE_CT  DOCKER_PREFIX(default 'sudo -n docker')
#   PG_HOST PG_PORT PG_USER PG_PASSWORD PG_ADMIN_DB
#   DRILL_DB  DRILL_SKIP_MIGRATE=1
#   TICK_WATCHDOG_MS (default 90000; tick self-abort + lock dump)
# =============================================================================
set -euo pipefail

MODE="${MODE:-docker}"
DRILL_MODE="${DRILL_MODE:-complete}"   # complete | fail
WORKER_ID="${WORKER_ID:-drill-1}"
DOCKER_PREFIX="${DOCKER_PREFIX:-sudo -n docker}"
TICK_WATCHDOG_MS="${TICK_WATCHDOG_MS:-90000}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TMPD="${TMPDIR:-/tmp}"
MIGRATE_JS="$TMPD/drill-migrate-$$.cjs"
TICK_JS="$TMPD/drill-tick-$$.cjs"

# --- node-side paths (deployed repo inside container vs host repo in local) --
if [ "$MODE" = "local" ]; then
  PG_CT=""; NODE_CT=""
  MODULE_BASE_DEF="$REPO_ROOT/server/modules/project-foundation"
  MIGRATIONS_DIR_DEF="$REPO_ROOT/server/db/migrations"
  PG_HOST_DEF="127.0.0.1"; PG_PORT_DEF="5432"; PG_USER_DEF="postgres"; PG_ADMIN_DB_DEF="postgres"
else
  PG_CT="${PG_CT:-moling-test-postgres}"
  NODE_CT="${NODE_CT:-moling-test-api-01}"
  MODULE_BASE_DEF="/app/server/modules/project-foundation"
  MIGRATIONS_DIR_DEF="/app/server/db/migrations"
  PG_HOST_DEF="postgres"; PG_PORT_DEF="5432"; PG_USER_DEF="moling_test"; PG_ADMIN_DB_DEF="moling_test"
fi
MODULE_BASE="${MODULE_BASE:-$MODULE_BASE_DEF}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$MIGRATIONS_DIR_DEF}"

# --- resolve PG connection for the node-side runner (pass-through preferred) --
ct_env() { # docker mode: read a var exported inside NODE_CT (empty if absent)
  [ "$MODE" = "docker" ] || { echo ""; return 0; }
  $DOCKER_PREFIX exec "$NODE_CT" printenv "$1" 2>/dev/null || true
}
if [ "$MODE" = "docker" ]; then
  PG_HOST="${PG_HOST:-$(ct_env PG_HOST)}"; PG_HOST="${PG_HOST:-$(ct_env PGHOST)}"
  PG_PORT="${PG_PORT:-$(ct_env PG_PORT)}"; PG_PORT="${PG_PORT:-$(ct_env PGPORT)}"
  PG_USER="${PG_USER:-$(ct_env PG_USER)}"; PG_USER="${PG_USER:-$(ct_env PGUSER)}"
  PG_PASSWORD="${PG_PASSWORD:-$(ct_env PG_PASSWORD)}"; PG_PASSWORD="${PG_PASSWORD:-$(ct_env PGPASSWORD)}"
fi
PG_HOST="${PG_HOST:-$PG_HOST_DEF}"
PG_PORT="${PG_PORT:-$PG_PORT_DEF}"
PG_USER="${PG_USER:-$PG_USER_DEF}"
PG_PASSWORD="${PG_PASSWORD:-}"
PG_ADMIN_DB="${PG_ADMIN_DB:-$PG_ADMIN_DB_DEF}"

# --- unique ids / names ------------------------------------------------------
gen_id() { cat /proc/sys/kernel/random/uuid 2>/dev/null || printf '%s-%s-%s' "$$" "$(date +%s)" "$RANDOM"; }
DRILL_DB="${DRILL_DB:-moling_run_events_drill_$(date +%s)_$$_$RANDOM}"
case "$DRILL_DB" in *[!A-Za-z0-9_]*) echo "DRILL_DB '$DRILL_DB': only [A-Za-z0-9_] allowed" >&2; exit 2;; esac
USER_EMAIL="drill-$(gen_id | tr -d '-')@run-events-drill.local"
USER_ID="u-$(gen_id)"
RUN_ID="run-$(gen_id)"

DROP_DB=0        # 1 once the drill owns a scratch DB to drop
RUN_INSERTED=0   # 1 once the seed rows exist (cleanup target)

# --- runners ----------------------------------------------------------------
pg_run() { # pg_run <db> <sql>   (quiet, tuples only)
  local db="$1" sql="$2"
  if [ "$MODE" = "docker" ]; then
    $DOCKER_PREFIX exec -i "$PG_CT" psql -U "$PG_USER" -d "$db" -v ON_ERROR_STOP=1 -t -A -c "$sql"
  else
    PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$db" \
      -v ON_ERROR_STOP=1 -t -A -c "$sql"
  fi
}
pg_stdin() { # pg_stdin <db>  < heredoc SQL  (multi-statement)
  local db="$1"
  if [ "$MODE" = "docker" ]; then
    $DOCKER_PREFIX exec -i "$PG_CT" psql -U "$PG_USER" -d "$db" -v ON_ERROR_STOP=1
  else
    PGPASSWORD="$PG_PASSWORD" psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$db" -v ON_ERROR_STOP=1
  fi
}
# run_node <host-js-file> <container-file-name> [ENV=VAL ...]  (stdout passthrough)
run_node() {
  local hostfile="$1" ctrfile="$2"; shift 2
  local envs=()
  for kv in "$@"; do envs+=("$kv"); done
  local dbg="PGHOST=$PG_HOST PGPORT=$PG_PORT PGUSER=$PG_USER PGDATABASE=$DRILL_DB"
  [ -n "$PG_PASSWORD" ] && dbg="$dbg PGPASSWORD=<set>"
  if [ "$MODE" = "docker" ]; then
    $DOCKER_PREFIX cp "$hostfile" "$NODE_CT:$ctrfile"
    echo "[drill] node run (docker $NODE_CT:$ctrfile, $dbg)"
    local args=(-e "PGHOST=$PG_HOST" -e "PGPORT=$PG_PORT" -e "PGUSER=$PG_USER" -e "PGDATABASE=$DRILL_DB")
    [ -n "$PG_PASSWORD" ] && args+=(-e "PGPASSWORD=$PG_PASSWORD")
    $DOCKER_PREFIX exec -i "${args[@]}" "$NODE_CT" env NODE_PATH=/app/node_modules "${envs[@]}" node "$ctrfile"
    $DOCKER_PREFIX exec "$NODE_CT" rm -f "$ctrfile" >/dev/null 2>&1 || true
  else
    echo "[drill] node run (local, $dbg)"
    env NODE_PATH="$REPO_ROOT/node_modules" PGHOST="$PG_HOST" PGPORT="$PG_PORT" PGUSER="$PG_USER" \
        PGPASSWORD="$PG_PASSWORD" PGDATABASE="$DRILL_DB" "${envs[@]}" node "$hostfile"
  fi
}

# --- cleanup (every exit path) ----------------------------------------------
cleanup() {
  set +e
  rm -f "$MIGRATE_JS" "$TICK_JS"
  if [ "$MODE" = "docker" ]; then
    $DOCKER_PREFIX exec "$NODE_CT" rm -f /tmp/drill-migrate.cjs /tmp/drill-tick.cjs >/dev/null 2>&1
  fi
  if [ "$RUN_INSERTED" = "1" ]; then
    pg_run "$DRILL_DB" "DELETE FROM run_events        WHERE run_id = '$RUN_ID';" >/dev/null 2>&1
    pg_run "$DRILL_DB" "DELETE FROM studio_run_events WHERE run_id = '$RUN_ID';" >/dev/null 2>&1
    pg_run "$DRILL_DB" "DELETE FROM studio_runs       WHERE id      = '$RUN_ID';" >/dev/null 2>&1
    pg_stdin "$DRILL_DB" >/dev/null 2>&1 <<SQL
DELETE FROM studio_canvases
 WHERE project_id IN (SELECT id FROM projects
                       WHERE workspace_id IN (SELECT id FROM workspaces
                                               WHERE owner_id = (SELECT id FROM users WHERE email = '$USER_EMAIL')));
DELETE FROM projects
 WHERE workspace_id IN (SELECT id FROM workspaces
                         WHERE owner_id = (SELECT id FROM users WHERE email = '$USER_EMAIL'));
DELETE FROM workspace_members
 WHERE workspace_id IN (SELECT id FROM workspaces
                         WHERE owner_id = (SELECT id FROM users WHERE email = '$USER_EMAIL'));
DELETE FROM workspaces WHERE owner_id = (SELECT id FROM users WHERE email = '$USER_EMAIL');
DELETE FROM users      WHERE email = '$USER_EMAIL';
SQL
    RUN_INSERTED=0
  fi
  if [ "$DROP_DB" = "1" ]; then
    pg_run "$PG_ADMIN_DB" "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DRILL_DB' AND pid<>pg_backend_pid();" >/dev/null 2>&1
    pg_run "$PG_ADMIN_DB" "DROP DATABASE IF EXISTS \"$DRILL_DB\";" >/dev/null 2>&1
    DROP_DB=0
  fi
  set -e
}
trap cleanup EXIT

# --- preflight ---------------------------------------------------------------
echo "[drill] mode=$MODE drill_mode=$DRILL_MODE db=$DRILL_DB worker=$WORKER_ID"
echo "[drill] module_base=$MODULE_BASE"
if [ "$MODE" = "docker" ]; then
  echo "[drill] pg_ct=$PG_CT node_ct=$NODE_CT"
  $DOCKER_PREFIX exec "$PG_CT" true || { echo "FAIL: cannot exec into postgres container '$PG_CT'" >&2; exit 2; }
  $DOCKER_PREFIX exec "$NODE_CT" sh -c "test -f $MODULE_BASE/studioRunEngine.cjs && test -f $MODULE_BASE/runEventRelay.cjs" || {
    echo "FAIL: engine modules not found in '$NODE_CT' at $MODULE_BASE/ (studioRunEngine.cjs / runEventRelay.cjs)" >&2; exit 2; }
  $DOCKER_PREFIX exec "$NODE_CT" sh -c "test -d $MIGRATIONS_DIR" || {
    echo "FAIL: migrations dir not found in '$NODE_CT' at $MIGRATIONS_DIR" >&2; exit 2; }
else
  command -v psql >/dev/null || { echo "FAIL: psql not found (local mode)" >&2; exit 2; }
  command -v node >/dev/null || { echo "FAIL: node not found (local mode)" >&2; exit 2; }
  [ -f "$MODULE_BASE/studioRunEngine.cjs" ] || { echo "FAIL: $MODULE_BASE/studioRunEngine.cjs missing" >&2; exit 2; }
  [ -f "$MODULE_BASE/runEventRelay.cjs" ]  || { echo "FAIL: $MODULE_BASE/runEventRelay.cjs missing" >&2; exit 2; }
  [ -d "$MIGRATIONS_DIR" ] || { echo "FAIL: migrations dir missing: $MIGRATIONS_DIR" >&2; exit 2; }
fi
echo "[drill] pg host=$PG_HOST port=$PG_PORT user=$PG_USER admin_db=$PG_ADMIN_DB"

# --- node helper scripts (written once; watchdog = no-hang guarantee) --------
cat > "$MIGRATE_JS" <<'NODE'
'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
(async () => {
  const dir = process.env.MIGRATIONS_DIR;
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const pool = new Pool({
    host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER, password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE, max: 4,
  });
  for (const f of files) {
    await pool.query(fs.readFileSync(path.join(dir, f), 'utf8')); // one tx per file (parity with migrate.cjs)
  }
  console.log('MIGRATED_FILES=' + files.length);
  await pool.end();
})().catch((e) => { console.error('MIGRATE_ERROR=' + ((e && e.message) || e)); process.exit(1); });
NODE
cat > "$TICK_JS" <<'NODE'
'use strict';
const { Pool } = require('pg');
const BASE = process.env.MODULE_BASE;
const { createStudioRunEngine } = require(BASE + '/studioRunEngine.cjs');
const { createRunEventRelay } = require(BASE + '/runEventRelay.cjs');
const WATCHDOG_MS = Number(process.env.TICK_WATCHDOG_MS || 90000);
const poolCfg = {
  host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER, password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE, max: 4,
};
const watchdog = setTimeout(async () => {
  console.error('TICK_WATCHDOG=hung_beyond_' + WATCHDOG_MS + 'ms; dumping pg_stat_activity for db ' + poolCfg.database);
  try {
    const p2 = new Pool(poolCfg);
    const a = await p2.query(
      `SELECT pid, state, wait_event_type, wait_event, left(query, 90) AS q
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid() ORDER BY pid`, [poolCfg.database]);
    console.error('ACTIVITY=' + JSON.stringify(a.rows));
    console.error('DIAGNOSIS=engine tx idle-in-transaction + a second connection waiting on ' +
      'transactionid => run_events relay (0043 FK) blocked by the engine uncommitted run-row ' +
      'update in the same tick (relay-emit-inside-open-tx deadlock).');
    await p2.end();
  } catch (e) { console.error('LOCKS_ERR=' + ((e && e.message) || e)); }
  process.exit(124);
}, WATCHDOG_MS);
(async () => {
  const pg = new Pool(poolCfg);
  const engine = createStudioRunEngine({
    pg,
    workerId: process.env.DRILL_WORKER_ID || 'drill-1',
    relay: createRunEventRelay({ pg }),   // seq-allocating run_events writer
    leaseSeconds: 60,
  });
  const node = await engine.leaseReadyNode({ limit: 1 });
  if (!node) { console.error('TICK_RESULT=NO_READY_NODE'); process.exit(2); }
  const mode = process.env.DRILL_MODE || 'complete';
  let outcome;
  if (mode === 'fail') {
    outcome = await engine.failRunNode(node.id, {
      owner: node.lease_owner, token: node.lease_token,
      error: { code: 'PERMANENT', message: 'run-events drill forced failure', retryable: false },
    });
  } else {
    outcome = await engine.completeRunNode(node.id, {
      owner: node.lease_owner, token: node.lease_token,
      result: { ok: true, drill: 'run-events', at: new Date().toISOString() },
    });
  }
  clearTimeout(watchdog);
  console.log('TICK_RESULT=' + JSON.stringify({ runId: node.run_id, nodeId: node.id, mode, outcome }));
  await pg.end();
  if (!outcome || outcome.ok !== true) { console.error('TICK_NOT_OK'); process.exit(3); }
})().catch((e) => { console.error('TICK_ERROR=' + ((e && e.stack) || e)); process.exit(1); });
NODE

# --- 1. scratch DB + full migration chain ------------------------------------
if [ -n "${DRILL_SKIP_MIGRATE:-}" ]; then
  echo "[drill] DRILL_SKIP_MIGRATE=1: reusing pre-migrated DB '$DRILL_DB'"
  pg_run "$DRILL_DB" "SELECT 1" >/dev/null || { echo "FAIL: cannot SELECT in '$DRILL_DB'" >&2; exit 2; }
else
  pg_run "$PG_ADMIN_DB" "SELECT 1" >/dev/null || { echo "FAIL: cannot reach admin DB '$PG_ADMIN_DB'" >&2; exit 2; }
  pg_run "$PG_ADMIN_DB" "DROP DATABASE IF EXISTS \"$DRILL_DB\";" >/dev/null
  pg_run "$PG_ADMIN_DB" "CREATE DATABASE \"$DRILL_DB\";" >/dev/null || { echo "FAIL: CREATE DATABASE $DRILL_DB" >&2; exit 2; }
  DROP_DB=1
  echo "[drill] migrating fresh DB from $MIGRATIONS_DIR ..."
  run_node "$MIGRATE_JS" /tmp/drill-migrate.cjs "MIGRATIONS_DIR=$MIGRATIONS_DIR"
fi

# --- 2. seed: user / workspace / project / canvas / QUEUED run / READY node ---
pg_stdin "$DRILL_DB" >/dev/null <<SQL
INSERT INTO users (id, email, display_name, password_hash, reward_credits, recharge_credits, role, status)
VALUES ('$USER_ID', '$USER_EMAIL', 'Drill', 'x', 0, 100, 'user', 'active');
INSERT INTO workspaces (id, name, owner_id) VALUES ('ws-drill-$(gen_id)', 'Run Events Drill', '$USER_ID');
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT id, '$USER_ID', 'owner' FROM workspaces WHERE owner_id = '$USER_ID';
INSERT INTO projects (id, workspace_id, owner_id, name, project_type, status)
SELECT 'proj-drill-$(gen_id)', id, '$USER_ID', 'Run Events Drill', 'studio', 'active'
  FROM workspaces WHERE owner_id = '$USER_ID';
INSERT INTO studio_canvases (id, project_id, workspace_id, name, revision, schema_version, created_by, updated_by)
SELECT 'canvas-drill-$(gen_id)', p.id, p.workspace_id, 'Drill Canvas', 1, 1, '$USER_ID', '$USER_ID'
  FROM projects p WHERE p.owner_id = '$USER_ID' LIMIT 1;
-- FK order: studio_runs row FIRST, then its studio_run_nodes row (run_id -> studio_runs)
INSERT INTO studio_runs
       (id, workspace_id, project_id, canvas_id, canvas_revision, canvas_schema_version, status, run_mode,
        compiled_graph_json, requested_by, idempotency_key, node_status_counts, nodes_total, executor_unavailable)
SELECT '$RUN_ID', p.workspace_id, p.id, c.id, c.revision, c.schema_version, 'QUEUED', 'ALL',
       '{}', '$USER_ID', 'drill-key-$(gen_id)', '{"READY":1}', 1, FALSE
  FROM projects p JOIN studio_canvases c ON c.project_id = p.id
 WHERE p.owner_id = '$USER_ID' LIMIT 1;
INSERT INTO studio_run_nodes
       (run_id, studio_node_id, node_type, execution_kind, status, dependency_count, remaining_dependency_count, attempt, max_attempts, input_json)
VALUES ('$RUN_ID', 'sn-prompt-drill', 'prompt', 'TRANSFORM', 'READY', 0, 0, 0, 3,
        '{"nodeKind":"prompt","schemaVersion":1,"status":"READY","parameters":{"prompt":"run-events drill"}}');
SQL
RUN_INSERTED=1
echo "[drill] seeded run_id=$RUN_ID (status=QUEUED / 1 READY prompt node)"

# --- 3. one engine tick -------------------------------------------------------
echo "[drill] engine tick (mode=$DRILL_MODE worker=$WORKER_ID, watchdog=${TICK_WATCHDOG_MS}ms) ..."
TICK_OK=1
set +e
if [ "$DRILL_MODE" = "fail" ]; then
  run_node "$TICK_JS" /tmp/drill-tick.cjs "MODULE_BASE=$MODULE_BASE" "DRILL_MODE=fail" "DRILL_WORKER_ID=$WORKER_ID" "TICK_WATCHDOG_MS=$TICK_WATCHDOG_MS"
else
  run_node "$TICK_JS" /tmp/drill-tick.cjs "MODULE_BASE=$MODULE_BASE" "DRILL_MODE=complete" "DRILL_WORKER_ID=$WORKER_ID" "TICK_WATCHDOG_MS=$TICK_WATCHDOG_MS"
fi
TICK_RC=$?
set -e
if [ "$TICK_RC" != "0" ]; then TICK_OK=0; echo "[drill] tick failed rc=$TICK_RC (watchdog rc=124 means lock wait -> see ACTIVITY/DIAGNOSIS above)" >&2; fi

# --- 4. assertions -------------------------------------------------------------
N_EVENTS="$(pg_run "$DRILL_DB" "SELECT count(*) FROM run_events WHERE run_id = '$RUN_ID';" | tail -1)"
CONTIG="$(pg_run "$DRILL_DB" "SELECT (count(*) = max(seq) - min(seq) + 1) AND (min(seq) = 1) FROM run_events WHERE run_id = '$RUN_ID';" | tail -1)"
RUN_STATUS="$(pg_run "$DRILL_DB" "SELECT status FROM studio_runs WHERE id = '$RUN_ID';" | tail -1)"
echo "[drill] ---- run_events log (seq:type) ----"
pg_run "$DRILL_DB" "SELECT seq || ':' || type FROM run_events WHERE run_id = '$RUN_ID' ORDER BY seq;" | sed 's/^/  /'
echo "[drill] ---- (studio_run_events durable mirror) ----"
pg_run "$DRILL_DB" "SELECT event_type FROM studio_run_events WHERE run_id = '$RUN_ID' ORDER BY id;" | sed 's/^/  /'
echo "[drill] -------------------------------------------"
N_EVENTS="${N_EVENTS:-0}"
CONTIG="${CONTIG:-f}"
ok=1
[ "$TICK_OK" = "1" ] || { echo "FAIL: engine tick did not complete (rc=$TICK_RC)" >&2; ok=0; }
if ! [[ "$N_EVENTS" =~ ^[0-9]+$ ]] || [ "$N_EVENTS" -lt 2 ] 2>/dev/null; then
  echo "FAIL: run_events rows=$N_EVENTS (expected >= 2)" >&2; ok=0
fi
if [ "$ok" = "1" ] && [ "$CONTIG" != "t" ]; then
  echo "FAIL: run_events seq not contiguous (COUNT=MAX-MIN+1, MIN=1) -> $CONTIG" >&2; ok=0
fi
if [ "$ok" = "1" ]; then
  echo "PASS run_id=$RUN_ID run_status=$RUN_STATUS run_events_rows=$N_EVENTS seq_contiguous=t (mode=$DRILL_MODE)"
else
  echo "FAIL run_id=$RUN_ID run_status=$RUN_STATUS run_events_rows=$N_EVENTS seq_contiguous=$CONTIG tick_ok=$TICK_OK"
fi
[ "$ok" = "1" ]
