'use strict';
/**
 * W3-09 — project_budgets.spent 持久化读模型 + 接口。
 *
 * 0031_project_budgets.sql 已有持久列 `spent NUMERIC(18,4) NOT NULL DEFAULT 0`，但代码库
 * 没有任何写入点（G20 审计：spent 只存在于内存/从未落库）。本模块是该列的最小持久化面：
 *
 *   - getBudgetSpent(pg, projectId)   读模型：budget / spent / remaining / 阈值
 *   - recordSpend(pg, {...})          受上限保护的幂等累计（ledger 风格防双扣）
 *
 * recordSpend 不是结算引擎。它只「烧」项目预算上限并凭幂等键去重；真实资金移动
 * （用户余额扣减、credit 流水、退款）归 FinGate-7，本模块刻意不触及、不新造结算语义。
 *
 * 幂等（防双扣）：idempotency_key 先 INSERT ... ON CONFLICT DO NOTHING 落 UNIQUE 列，
 * 只有抢到键的请求才能推进累计；同键重试是 no-op，并回放已记录/已拒绝的结果。
 * 超剩余（budget - spent < amount）由带守卫的 UPDATE 拒绝，绝不触碰计数器。
 */

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 读模型：读取某项目的预算上限、累计 spent 与剩余。无预算行返回 null。 */
async function getBudgetSpent(pg, projectId) {
  if (!projectId) return null;
  const r = await pg.query(
    `SELECT project_id, workspace_id, budget, spent, warning_threshold, approval_threshold
       FROM project_budgets
      WHERE project_id = $1`,
    [projectId],
  );
  const row = r && r.rows && r.rows[0];
  if (!row) return null;
  const budget = toNum(row.budget);
  const spent = toNum(row.spent);
  return {
    projectId: row.project_id,
    workspaceId: row.workspace_id,
    budget,
    spent,
    remaining: budget - spent,
    warningThreshold: toNum(row.warning_threshold),
    approvalThreshold: toNum(row.approval_threshold),
  };
}

/**
 * 记录一笔预算扣减（幂等 + 超限拒绝）。
 * 返回 { ok, recorded, alreadyRecorded?, spent?, remaining?, error? }。
 * 幂等键已存在时回放其结果（recorded → no-op；rejected → 再次拒绝），不二次扣减。
 */
async function recordSpend(pg, { projectId, amount, idempotencyKey } = {}) {
  if (!projectId) return { ok: false, error: { code: 'SPEND_MISSING_PROJECT' } };
  const amt = toNum(amount);
  if (!(amt > 0)) return { ok: false, error: { code: 'SPEND_INVALID_AMOUNT' } };
  if (!idempotencyKey) return { ok: false, error: { code: 'SPEND_MISSING_IDEMPOTENCY_KEY' } };

  // 1. 先占幂等键（ledger 风格去重）。UNIQUE 约束是唯一仲裁者：
  //    同键并发只有一个能成功，其余走回放分支，杜绝双扣。
  const ins = await pg.query(
    `INSERT INTO project_budget_spends (project_id, idempotency_key, amount)
     VALUES ($1, $2, $3)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [projectId, idempotencyKey, amt],
  );
  if (!ins || !ins.rowCount) {
    const prior = await pg.query(
      `SELECT status FROM project_budget_spends WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    const st = prior && prior.rows && prior.rows[0] && prior.rows[0].status;
    if (st === 'rejected') {
      return { ok: false, error: { code: 'SPEND_OVER_REMAINING' }, alreadyRejected: true };
    }
    return { ok: true, recorded: false, alreadyRecorded: true };
  }

  // 2. 带守卫的原子累计：仅当 amount <= remaining (budget - spent) 时才加。
  const upd = await pg.query(
    `UPDATE project_budgets
        SET spent = spent + $2, updated_at = NOW()
      WHERE project_id = $1 AND budget - spent >= $2
      RETURNING project_id, budget, spent`,
    [projectId, amt],
  );
  const row = upd && upd.rows && upd.rows[0];
  if (!row) {
    await pg
      .query(
        `UPDATE project_budget_spends SET status = $2 WHERE idempotency_key = $1`,
        [idempotencyKey, 'rejected'],
      )
      .catch(() => {});
    const ex = await pg.query(
      `SELECT budget, spent FROM project_budgets WHERE project_id = $1`,
      [projectId],
    );
    if (!(ex && ex.rows && ex.rows[0])) return { ok: false, error: { code: 'SPEND_NO_BUDGET' } };
    return { ok: false, error: { code: 'SPEND_OVER_REMAINING' } };
  }

  return {
    ok: true,
    recorded: true,
    projectId: row.project_id,
    spent: toNum(row.spent),
    remaining: toNum(row.budget) - toNum(row.spent),
  };
}

module.exports = { getBudgetSpent, recordSpend };
