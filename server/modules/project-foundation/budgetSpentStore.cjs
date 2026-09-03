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
 *
 * 原子性（G20 修复）：占键 INSERT 与累计 UPDATE 必须同一事务。二者若分属两次自动提交，
 * 一旦 UPDATE 因瞬时故障失败，占键行仍已提交且 status 默认 'recorded'，重试会误判
 * 「已记录」而永久漏扣。故本模块在 pg 提供 connect()（node-postgres Pool/Client）时
 * 用 BEGIN…COMMIT/ROLLBACK 包裹整段；pg 无 connect()（纯直连/假实现）时退化为直连。
 *
 * 幂等键全局唯一契约（G20 修复）：0044 的 idempotency_key 是全局 UNIQUE（非按 project
 * 复合）。因此重放分支必须校验「同键 → 同 project_id 且同 amount」，否则跨预算撞键或
 * 同键不同金额会被静默回放成另一笔预算的结果。校验不通过 → SPEND_IDEMPOTENCY_KEY_CONFLICT
 * （fail-closed），调用方必须保证幂等键全局唯一。
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
 * 记录一笔预算扣减（幂等 + 超限拒绝 + 原子事务）。
 * 返回 { ok, recorded, alreadyRecorded?, spent?, remaining?, error? }。
 * 幂等键已存在时回放其结果（recorded → no-op；rejected → 再次拒绝），不二次扣减。
 * 同键但 project_id/amount 不一致 → SPEND_IDEMPOTENCY_KEY_CONFLICT（fail-closed）。
 */
async function recordSpend(pg, { projectId, amount, idempotencyKey } = {}) {
  if (!projectId) return { ok: false, error: { code: 'SPEND_MISSING_PROJECT' } };
  const amt = toNum(amount);
  if (!(amt > 0)) return { ok: false, error: { code: 'SPEND_INVALID_AMOUNT' } };
  if (!idempotencyKey) return { ok: false, error: { code: 'SPEND_MISSING_IDEMPOTENCY_KEY' } };

  // 有 connect()（Pool/Client）就取专属 client 走事务；否则退化为直连（假实现/单语句）。
  const client = typeof pg.connect === 'function' ? await pg.connect() : null;
  const q = client || pg;
  let begun = false;
  try {
    if (client) {
      await q.query('BEGIN');
      begun = true;
    }

    // 1. 先占幂等键（ledger 风格去重）。UNIQUE 约束是唯一仲裁者：
    //    同键并发只有一个能成功，其余走回放分支，杜绝双扣。
    const ins = await q.query(
      `INSERT INTO project_budget_spends (project_id, idempotency_key, amount)
       VALUES ($1, $2, $3)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [projectId, idempotencyKey, amt],
    );
    if (!ins || !ins.rowCount) {
      const prior = await q.query(
        `SELECT project_id, amount, status FROM project_budget_spends WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      const p = prior && prior.rows && prior.rows[0];
      if (client) {
        await q.query('ROLLBACK').catch(() => {});
        begun = false;
      }
      // 同键重放必须同 project 且同金额；否则是幂等键冲突（跨预算撞键 / 金额不一致）。
      if (p && (p.project_id !== projectId || toNum(p.amount) !== amt)) {
        return { ok: false, error: { code: 'SPEND_IDEMPOTENCY_KEY_CONFLICT' } };
      }
      if (p && p.status === 'rejected') {
        return { ok: false, error: { code: 'SPEND_OVER_REMAINING' }, alreadyRejected: true };
      }
      return { ok: true, recorded: false, alreadyRecorded: true };
    }

    // 2. 带守卫的原子累计：仅当 amount <= remaining (budget - spent) 时才加。
    //    WHERE 在 UPDATE 内 → PG 行锁下重估条件，并发扣减被串行化，绝不超卖。
    const upd = await q.query(
      `UPDATE project_budgets
          SET spent = spent + $2, updated_at = NOW()
        WHERE project_id = $1 AND budget - spent >= $2
        RETURNING project_id, budget, spent`,
      [projectId, amt],
    );
    const row = upd && upd.rows && upd.rows[0];
    if (!row) {
      // 超限或无预算行：记账行标记 rejected（同一事务内提交），计数器不动。
      await q.query(
        `UPDATE project_budget_spends SET status = $2 WHERE idempotency_key = $1`,
        [idempotencyKey, 'rejected'],
      );
      const ex = await q.query(
        `SELECT budget, spent FROM project_budgets WHERE project_id = $1`,
        [projectId],
      );
      if (client) {
        await q.query('COMMIT');
        begun = false;
      }
      if (!(ex && ex.rows && ex.rows[0])) return { ok: false, error: { code: 'SPEND_NO_BUDGET' } };
      return { ok: false, error: { code: 'SPEND_OVER_REMAINING' } };
    }

    if (client) {
      await q.query('COMMIT');
      begun = false;
    }
    return {
      ok: true,
      recorded: true,
      projectId: row.project_id,
      spent: toNum(row.spent),
      remaining: toNum(row.budget) - toNum(row.spent),
    };
  } catch (e) {
    if (begun) await q.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (client && typeof client.release === 'function') await client.release();
  }
}

module.exports = { getBudgetSpent, recordSpend };
