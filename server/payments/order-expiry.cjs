// server/payments/order-expiry.cjs — 订单超时调度器（Node 内存 worker）
//
// 职责：周期性扫描 recharge_orders 中 status='pending' 且超过
//       payment_settings.default_expires_min（默认 15 分钟）的订单，原子置为 expired、
//       写 expired_at，并批量记 payment_audit(event_type='expired')。
//
// 安全铁律：
//   · 仅作用于 pending 订单；已 paid 订单由 webhook 幂等入账，不在本 worker 范围。
//   · 下单不预留积分，积分仅在 webhook 成功时入账 —— 故过期无需「释放预留积分」，
//     绝不触碰用户余额（避免任何误扣）。
//   · 与 webhook 的 FOR UPDATE 行锁天然串行：UPDATE...RETURNING 原子锁定被改行，
//     webhook 若晚到，会按 status 走幂等（已 paid 直接返回成功），不会双入账。
//   · 进程退出前 stop() 清除定时器。timer.unref() 确保不阻止进程自然退出。
//   · PG 不可用时静默跳过（与 payments 模块一致的「PG 优先」前提）。

function createOrderExpiryWorker(ctx) {
  const { getPg, intervalMs = 60000, logger = console } = ctx || {};
  let timer = null;
  let running = false;

  function log(...args) {
    if (logger && typeof logger.log === 'function') logger.log('[order-expiry]', ...args);
  }
  function err(...args) {
    if (logger && typeof logger.error === 'function') logger.error('[order-expiry]', ...args);
  }

  // 单轮扫描：返回 {scanned, expired, skipped?, error?}
  async function tick() {
    const pg = getPg && getPg();
    if (!pg) return { scanned: 0, expired: 0, skipped: true };
    try {
      const s = await pg.query('SELECT default_expires_min FROM payment_settings WHERE id=1');
      const mins = (s.rows[0] && Number(s.rows[0].default_expires_min)) || 15;
      if (!(mins > 0)) return { scanned: 0, expired: 0, skipped: true };

      // 原子过期：单条 UPDATE 锁定被改行，RETURNING 取走批次，天然无并发双改。
      // ⚠️ 双分支兼容：早期订单 expired_at 为 NULL（按 created_at 阈值判超时）；
      //    新订单已持久化 expired_at（按绝对过期时刻判超时）。二者都要覆盖，
      //    否则一旦 createOrder 落 expired_at，新 pending 会被 AND expired_at IS NULL 排除而永不失效。
      const upd = await pg.query(
        `UPDATE recharge_orders
            SET status='expired', expired_at=NOW()
          WHERE status='pending'
            AND (
              (expired_at IS NULL AND created_at < NOW() - ($1::int * INTERVAL '1 minute'))
              OR (expired_at IS NOT NULL AND expired_at < NOW())
            )
          RETURNING id, user_id, amount, pay_order_no`,
        [mins],
      );
      const rows = upd.rows || [];
      const n = rows.length;
      if (n === 0) return { scanned: 0, expired: 0 };

      // 批量审计（单条多值 INSERT，避免 N 次往返）
      const vals = [];
      const params = [];
      let p = 1;
      for (const r of rows) {
        vals.push(`('expired',$${p},$${p + 1},$${p + 2}::jsonb)`);
        params.push(r.user_id, r.id, JSON.stringify({ amount: Number(r.amount), payOrderNo: r.pay_order_no }));
        p += 3;
      }
      await pg.query(
        `INSERT INTO payment_audit (event_type, user_id, order_id, detail) VALUES ${vals.join(',')}`,
        params,
      );

      log(`本轮过期 ${n} 笔（阈值 ${mins} 分钟）`);
      return { scanned: n, expired: n };
    } catch (e) {
      err('tick 失败:', e.message);
      return { scanned: 0, expired: 0, error: e.message };
    }
  }

  function start() {
    if (running) return;
    running = true;
    timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    if (timer.unref) timer.unref(); // 不阻止进程自然退出
    tick().catch(() => {}); // 启动即扫一次，缩短首扫延迟
    log('worker 已启动（间隔 ' + intervalMs + 'ms）');
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    running = false;
    log('worker 已停止');
  }

  return { start, stop, tick, isRunning: () => running };
}

module.exports = { createOrderExpiryWorker };
