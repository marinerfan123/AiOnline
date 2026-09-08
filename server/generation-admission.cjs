'use strict';

const DEFAULT_USER_MAX_ACTIVE = 8;
const MAX_USER_MAX_ACTIVE = 64;

function resolveUserActiveLimit(env = process.env) {
  const parsed = Number.parseInt(env.GEN_USER_MAX_ACTIVE || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_USER_MAX_ACTIVE;
  return Math.min(MAX_USER_MAX_ACTIVE, parsed);
}

async function checkUserGenerationCapacity(pgPool, userId, limit = resolveUserActiveLimit()) {
  const result = await pgPool.query(
    `SELECT COUNT(*)::int AS active
       FROM generation_tasks
      WHERE user_id=$1 AND status IN ('running','waiting')`,
    [userId],
  );
  const active = Number(result.rows[0] && result.rows[0].active) || 0;
  return { allowed: active < limit, active, limit };
}

module.exports = { DEFAULT_USER_MAX_ACTIVE, resolveUserActiveLimit, checkUserGenerationCapacity };
