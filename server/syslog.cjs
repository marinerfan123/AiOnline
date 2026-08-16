// server/syslog.cjs — 核心错误持久化 + 进程级异常兜底
// ─────────────────────────────────────────────────────────────────────────
// 职责（对应诉求「系统发出的每一次核心错误都要能记录」）：
//   1) system_error_logs 表写入（insertError）
//      - fire-and-forget：绝不阻塞主链路；异常一律 catch 静默
//      - 由 server.js 在 logbus.emit('ERROR') 时统一调用（persistError 回调），
//        因此「所有 console.error + 业务显式 ERROR」零死角、零重复落库
//   2) 查询 / 统计 / 清理（供后台 /api/admin/errors 使用）
//   3) 进程级异常兜底：uncaughtException / unhandledRejection → 记录 + 优雅退出
//
// 用法（server.js）：
//   const syslog = require('./syslog.cjs');
//   syslog.initSyslog(pgPool);          // initDB 之后注入连接池
//   syslog.installGlobalHandlers();     // 注册进程级异常兜底（尽早）
//   createLogBus({ persistError: (lvl,src,msg,meta)=>syslog.insertError(src,src,msg,meta,null) })

// 捕获「原始」console.error/warn：logbus 会覆写 console.error 以采集日志，
// 全局异常处理器内若再用 console.error 会触发 logbus hook → emit ERROR → 重复/递归记录。
// 本模块在加载期（早于 installConsoleHook）保存原始引用即可。
const origError = console.error.bind(console);
const origWarn = console.warn.bind(console);

const startTime = Date.now();

let pool = null;             // PostgreSQL 连接池（由 initSyslog 注入）
let handlersInstalled = false;

function initSyslog(pg) { pool = pg; }

// ─── 写入：核心错误落库（fire-and-forget）─────────────────────────────
// category: 归类（子系统，如 pg/redis/console/billing/uncaughtException）
// source  : 来源（与 category 一致，便于前端按子系统筛选）
// meta    : 结构化附加信息（JSONB）
// stack   : 错误堆栈（TEXT，可选）
function insertError(category, source, message, meta, stack) {
  if (!pool) return;                       // PG 不可用 → 静默跳过（不阻塞主链路）
  const msg = (message == null ? '' :
    (typeof message === 'string' ? message : (message.stack || String(message))));
  const m = (meta && typeof meta === 'object') ? meta : {};
  Promise.resolve()
    .then(() => pool.query(
      `INSERT INTO system_error_logs (category, source, message, meta, stack)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        String(category || 'app').slice(0, 64),
        String(source || 'app').slice(0, 64),
        String(msg).slice(0, 8000),
        (JSON.stringify(m) || '{}').slice(0, 8000),
        stack ? String(stack).slice(0, 16000) : null,
      ]
    ))
    .catch(() => { /* 静默，绝不抛 */ });
}

// ─── 查询（后台历史错误页）──────────────────────────────────────────
async function queryErrors(query = {}) {
  if (!pool) throw new Error('数据库未就绪');
  const category = (query.category || '').trim();
  const keyword = (query.keyword || '').trim();
  const limit = Math.min(parseInt(query.limit || '100', 10) || 100, 500);
  const before = query.before ? new Date(query.before) : null;
  const params = [];
  let where = '1=1';
  let i = 1;
  if (category) { where += ` AND category=$${i}`; params.push(category); i++; }
  if (keyword) { where += ` AND (message ILIKE $${i} OR source ILIKE $${i})`; params.push(`%${keyword}%`); i++; }
  if (before && !isNaN(before.getTime())) { where += ` AND created_at < $${i}`; params.push(before); i++; }

  const totalR = await pool.query(`SELECT COUNT(*) FROM system_error_logs WHERE ${where}`, params);
  const total = parseInt(totalR.rows[0].count, 10);
  const r = await pool.query(
    `SELECT id, category, source, message, meta, stack, created_at
     FROM system_error_logs WHERE ${where} ORDER BY created_at DESC LIMIT $${i}`,
    [...params, limit]
  );

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const s = await pool.query(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE created_at >= $1) AS today,
            COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS last24
     FROM system_error_logs`, [today]);
  const top = await pool.query(
    `SELECT category, COUNT(*) AS c FROM system_error_logs GROUP BY category ORDER BY c DESC LIMIT 12`);
  const stats = {
    total: parseInt(s.rows[0].total, 10),
    today: parseInt(s.rows[0].today, 10),
    last24h: parseInt(s.rows[0].last24, 10),
    byCategory: top.rows.map((x) => ({ category: x.category, count: parseInt(x.c, 10) })),
  };

  return {
    items: r.rows.map((x) => ({
      id: Number(x.id),
      category: x.category,
      source: x.source,
      message: x.message,
      meta: x.meta || {},
      stack: x.stack || null,
      createdAt: x.created_at,
    })),
    total,
    stats,
  };
}

// ─── 清理（后台可清空历史错误）────────────────────────────────────
async function clearErrors(category) {
  if (!pool) throw new Error('数据库未就绪');
  if (category) await pool.query('DELETE FROM system_error_logs WHERE category=$1', [category]);
  else await pool.query('DELETE FROM system_error_logs');
  return { ok: true };
}

// ─── 进程级异常兜底 ────────────────────────────────────────────────
function installGlobalHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;

  // 未捕获异常：进程已处于未知状态 → 记录后优雅退出（给落库留 800ms）
  process.on('uncaughtException', (err) => {
    const message = err && err.message ? err.message : String(err);
    const stack = err && err.stack ? err.stack : String(err);
    try { origError('[FATAL] uncaughtException:', message); } catch {}
    insertError('uncaughtException', 'process', message, { millisSinceStart: Date.now() - startTime }, stack);
    setTimeout(() => { try { process.exit(1); } catch {} }, 800);
  });

  // 未处理的 Promise 拒绝：单个失败通常不致命 → 记录即可，不主动退出（避免误杀在线服务）
  process.on('unhandledRejection', (reason) => {
    const message = reason && reason.message ? reason.message : String(reason);
    const stack = reason && reason.stack ? reason.stack : null;
    try { origWarn('[FATAL] unhandledRejection:', message); } catch {}
    insertError('unhandledRejection', 'process', message, { millisSinceStart: Date.now() - startTime }, stack);
  });
}

module.exports = { initSyslog, insertError, queryErrors, clearErrors, installGlobalHandlers };
