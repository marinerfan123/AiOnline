'use strict';
/**
 * 乐观锁 UPDATE 助手（ModelHub V3 · 防并发覆盖）
 *
 * 业务语义（参照用户示例）：
 *   revision = 12 管理员 A 保存：WHERE revision = 12 更新后 revision = 13
 *   管理员 B 仍拿 12 保存：UPDATE 命中 0 行 → 409 Conflict（而不是覆盖 A）
 *
 * 实现要点：
 *   - revision 整型自增：UPDATE ... SET <cols>, revision = revision + 1, updated_at = NOW(), updated_by = $actor
 *                       WHERE id = $id AND revision = $expected
 *   - rowCount === 0 时二次 SELECT 区分「不存在(404)」与「revision 不匹配(409)」
 *   - 表名 / 列名白名单校验，杜绝 SQL 注入（pg 占位符只能绑定值，不能绑定标识符）
 *
 * 注意：必须运行在事务/READ COMMITTED 下才能保证「两个相同 expectedRevision 并发只会成功一个」。
 *       本助手不主动开事务，由调用方视需要在外部 BEGIN/COMMIT 包裹。
 */

// 仅允许这两张受管表，避免任意表名注入
const ALLOWED_TABLES = new Set(['providers', 'models']);

// 列名必须是合法 SQL 标识符（字母/数字/下划线，且不以数字开头）
const COL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * @param {object} pg            pg Pool / Client（需有 .query(sql, params)）
 * @param {object} opts
 * @param {string} opts.table    受管表名（'providers' | 'models'）
 * @param {string} opts.id       行主键
 * @param {number} opts.expectedRevision  客户端持有的 revision（乐观锁基线）
 * @param {string[]} opts.columns  要更新的 snake_case 列名（白名单）
 * @param {any[]}   opts.values    与 columns 一一对应的新值
 * @param {string} [opts.actor]    操作人（写入 updated_by），缺省 ''
 * @returns {Promise<{status:'ok'|'notFound'|'conflict', revision?:number, currentRevision?:number}>}
 */
async function optimisticUpdate(pg, { table, id, expectedRevision, columns, values, actor }) {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error('optimisticUpdate: 非法的表名 ' + table);
  }
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('optimisticUpdate: columns 不能为空');
  }
  if (!Array.isArray(values) || values.length !== columns.length) {
    throw new Error('optimisticUpdate: values 必须与 columns 等长');
  }
  for (const c of columns) {
    if (typeof c !== 'string' || !COL_IDENT_RE.test(c)) {
      throw new Error('optimisticUpdate: 非法列名 ' + String(c));
    }
  }

  const setClause = columns.map((c, i) => `${c} = $${i + 4}`).join(', ');
  // 参数顺序：$1=id, $2=expectedRevision, $3=actor, $4..=values
  const params = [id, expectedRevision, actor || '', ...values];
  const sql =
    `UPDATE ${table} SET ${setClause}, revision = revision + 1, updated_at = NOW(), updated_by = $3 ` +
    `WHERE id = $1 AND revision = $2`;

  const r = await pg.query(sql, params);
  if (r.rowCount === 0) {
    // 命中 0 行：区分「记录不存在」还是「revision 已被别人改过」
    const ex = await pg.query(`SELECT id, revision FROM ${table} WHERE id = $1`, [id]);
    if (!ex.rows || ex.rows.length === 0) {
      return { status: 'notFound' };
    }
    return { status: 'conflict', currentRevision: ex.rows[0].revision };
  }
  return { status: 'ok', revision: Number(expectedRevision) + 1 };
}

module.exports = { optimisticUpdate, ALLOWED_TABLES };
