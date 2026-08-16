// ============================================================
// docs/phase-a/billing.js — reserve/commit/release 三段式计费
// 关键不变量：余额在 reserve 时即扣减；commit 只记日志（不再动余额）；
//              release 把 reserve 扣掉的加回。两阶段都落在【后台完成回调】，
//              绝不在 HTTP handler 里结算 held（否则 held 永不被释放 → G3 信用泄漏）。
// 并发安全：用「原子 UPDATE ... WHERE credits >= $1」而非「SELECT FOR UPDATE + UPDATE」，
//           因为单条 pg.query 是 autocommit，FOR UPDATE 的锁在 SELECT 结束即释放，
//           跨两条语句不构成原子，反而制造虚假安全感（见 LOGIC_CHECK）。
// ============================================================
async function reserveCredits(pg, userId, amount, ref) {
  // 1) 原子扣减并校验余额（余额不足则 rowCount=0）
  const r = await pg.query(
    `UPDATE users SET credits = credits - $1 WHERE id = $2 AND credits >= $1`,
    [amount, userId],
  );
  if (r.rowCount === 0) {
    const ex = new Error('积分不足');
    ex.code = 'INSUFFICIENT';
    throw ex;
  }
  // 2) 仅追加记账（reserve 是负债登记）
  await pg.query(
    `INSERT INTO credit_transactions (user_id, kind, amount, ref)
     VALUES ($1, 'reserve', $2, $3)`,
    [userId, amount, ref],
  );
  return true;
}

async function commitCredits(pg, userId, amount, ref) {
  // 余额已在 reserve 扣除；commit 仅登记消费完成并回填余额快照，余额不变
  await pg.query(
    `INSERT INTO credit_transactions (user_id, kind, amount, ref, balance_after)
     VALUES ($1, 'commit', $2, $3, (SELECT credits FROM users WHERE id = $1))`,
    [userId, amount, ref],
  );
}

async function releaseCredits(pg, userId, amount, ref) {
  // 生成失败：把 reserve 扣回，并登记 release
  await pg.query(`UPDATE users SET credits = credits + $1 WHERE id = $2`, [amount, userId]);
  await pg.query(
    `INSERT INTO credit_transactions (user_id, kind, amount, ref, balance_after)
     VALUES ($1, 'release', $2, $3, (SELECT credits FROM users WHERE id = $1))`,
    [userId, amount, ref],
  );
}

// 幂等兜底：若因异常路径（进程崩溃/回调丢失）导致某 ref 的 held 从未 commit/release，
// 提供对账任务可查 credit_transactions 中仅有 'reserve' 无配对的记录并释放。
async function findDanglingReserves(pg, olderThanMin = 30) {
  return pg.query(
    `SELECT DISTINCT ref, user_id, amount
     FROM credit_transactions r
     WHERE kind = 'reserve'
       AND created_at < NOW() - ($1 || ' minutes')::INTERVAL
       AND NOT EXISTS (
         SELECT 1 FROM credit_transactions c
         WHERE c.ref = r.ref AND c.kind IN ('commit', 'release')
       )`,
    [olderThanMin],
  );
}

module.exports = { reserveCredits, commitCredits, releaseCredits, findDanglingReserves };
