'use strict';
/**
 * ModelHub V3 Phase 1 · Operation Registry 服务（L3）。
 *
 * 职责（§7 / §129 Admin ModelHub）：
 *   把「Operation」作为一等对象，提供登记查询与修订（revision）解析/激活/下线。
 *   本模块只读 L1/L2 新表（logical_models / model_revisions / model_operations /
 *   model_operation_revisions），不新增表、不写 schema 内容；schema 变更由上游
 *   新建 revision（§7：ACTIVE 后禁 UPDATE schema 内容）。
 *
 * 列形状依赖 L1/L2（迁移 0058/0059，本叶不建表）：
 *   logical_models            (id, code, media_type, display_name, vendor_family, status, created_at)
 *   model_revisions           (id, logical_model_id, revision_code, upstream_vendor,
 *                              upstream_model_family, released_at, status, metadata, created_at)
 *   model_operations          (id, code, media_type, kind, display_name, status)
 *   model_operation_revisions (id, model_revision_id, operation_id, revision,
 *                              input_schema, output_schema, ui_schema, semantic_map,
 *                              capability_descriptor, schema_hash, status, created_at, activated_at)
 *
 * 状态机（model_operation_revisions.status）：
 *   DRAFT → VALIDATING → CANARY → ACTIVE（激活梯，只能向前）
 *   DEPRECATED / RETIRED（终态，禁止任何再迁移 → 终态拒）
 *
 * 错误码化：所有方法统一返回 { ok, ... } 信封；失败带 code/httpStatus/message，
 *   与 §70 Error Taxonomy 的 SCREAMING_SNAKE 命名一致。
 */

// 激活梯（下标即 rank，只能向大前进）
const ACTIVATION_LADDER = ['DRAFT', 'VALIDATING', 'CANARY', 'ACTIVE'];
const RANK = new Map(ACTIVATION_LADDER.map((s, i) => [s, i]));
// 终态：不可再迁移（activate/deactivate 一律拒绝）
const TERMINAL = new Set(['DEPRECATED', 'RETIRED']);
// activateRevision 允许的前进目标
const ACTIVATE_TARGETS = new Set(['VALIDATING', 'CANARY', 'ACTIVE']);
// deactivate 允许的目标（终态）
const DEACTIVATE_TARGETS = new Set(['DEPRECATED', 'RETIRED']);

/** 统一错误信封构造 */
function err(code, httpStatus, message, extra) {
  return Object.assign({ ok: false, code, httpStatus, message }, extra || {});
}

/**
 * @param {object} deps
 * @param {object} deps.pg  PG Pool/Client（需 .query(sql, params)）
 * @returns {{listOperations, resolveOperationRevision, activateRevision, deactivate}}
 */
function createModelRegistry({ pg }) {
  const hasPg = pg && typeof pg.query === 'function';

  /** 读当前 operation revision 行（供 activate/deactivate 状态机判定）。 */
  async function readRevision(operationRevisionId) {
    const r = await pg.query(
      'SELECT * FROM model_operation_revisions WHERE id = $1 LIMIT 1',
      [operationRevisionId],
    );
    return (r.rows && r.rows[0]) || null;
  }

  /**
   * 列出 Operation（可按 mediaType 过滤），并附带各自最新 ACTIVE 修订。
   * @param {{mediaType?:string}} [opts]
   * @returns {Promise<{ok:true, operations:Array}>}
   */
  async function listOperations(opts = {}) {
    const mediaType = opts && opts.mediaType ? String(opts.mediaType) : null;
    if (!hasPg) return err('DB_UNAVAILABLE', 503, 'registry: 无可用 pg 连接');
    try {
      const sql = mediaType
        ? 'SELECT * FROM model_operations WHERE media_type = $1 ORDER BY code ASC'
        : 'SELECT * FROM model_operations ORDER BY code ASC';
      const params = mediaType ? [mediaType] : [];
      const opRes = await pg.query(sql, params);
      const operations = (opRes.rows || []).slice();

      // 附最新 ACTIVE 修订（§129 需看到 operation 的活跃 revision）
      if (operations.length) {
        const opIds = operations.map((o) => o.id).filter(Boolean);
        const revRes = await pg.query(
          "SELECT * FROM model_operation_revisions WHERE operation_id = ANY($1) AND status = 'ACTIVE' ORDER BY revision DESC",
          [opIds],
        );
        const byOp = new Map();
        for (const rv of revRes.rows || []) {
          if (!byOp.has(rv.operation_id)) byOp.set(rv.operation_id, rv);
        }
        for (const op of operations) {
          const rv = byOp.get(op.id);
          if (rv) {
            op.activeRevisionId = rv.id;
            op.activeRevision = rv.revision;
          }
        }
      }
      return { ok: true, operations };
    } catch (e) {
      console.warn('[registry] listOperations 失败:', e && e.message);
      return err('DB_ERROR', 500, 'registry: listOperations 查询失败');
    }
  }

  /**
   * 解析某个逻辑模型 × 某 Operation 的修订：默认取「最新 ACTIVE 修订」。
   *  - status 缺省 = 'ACTIVE'（ACTIVE 优先：即便存在更新的 DRAFT，也返回 ACTIVE）。
   *  - 命中同 status 多修订时，按 revision 降序取最新（latest）。
   *
   * @param {{logicalModelCode:string, operationCode:string, status?:string}} q
   * @returns {Promise<{ok:true, revisionRow:object, modelRevisionRow:object}|
   *                   {ok:false, code, httpStatus, message}>}
   */
  async function resolveOperationRevision({ logicalModelCode, operationCode, status } = {}) {
    if (!hasPg) return err('DB_UNAVAILABLE', 503, 'registry: 无可用 pg 连接');
    if (!logicalModelCode || !operationCode) {
      return err('INVALID_ARGUMENT', 400, 'registry: logicalModelCode 与 operationCode 必填');
    }
    const effectiveStatus = status ? String(status) : 'ACTIVE';
    try {
      // 1) 逻辑模型 code → 行（404）
      const lmRes = await pg.query('SELECT * FROM logical_models WHERE code = $1 LIMIT 1', [logicalModelCode]);
      const logicalModel = (lmRes.rows && lmRes.rows[0]) || null;
      if (!logicalModel) {
        return err('LOGICAL_MODEL_NOT_FOUND', 404, `逻辑模型未登记: ${logicalModelCode}`);
      }

      // 2) Operation code → 行（404）
      const opRes = await pg.query('SELECT * FROM model_operations WHERE code = $1 LIMIT 1', [operationCode]);
      const operation = (opRes.rows && opRes.rows[0]) || null;
      if (!operation) {
        return err('OPERATION_NOT_FOUND', 404, `Operation 未登记: ${operationCode}`);
      }

      // 3) 该逻辑模型下的全部 model_revisions（用于定位父 revision 行）
      const mrRes = await pg.query('SELECT * FROM model_revisions WHERE logical_model_id = $1', [logicalModel.id]);
      const modelRevisions = mrRes.rows || [];
      const modelRevisionById = new Map(modelRevisions.map((m) => [m.id, m]));
      if (modelRevisionById.size === 0) {
        return err('OPERATION_REVISION_NOT_FOUND', 404, `逻辑模型 ${logicalModelCode} 无任何 model_revision`);
      }

      // 4) latest 修订：ACTIVE 优先（status 过滤）+ revision 降序
      const revRes = await pg.query(
        `SELECT * FROM model_operation_revisions
          WHERE model_revision_id = ANY($1) AND operation_id = $2 AND status = $3
          ORDER BY revision DESC, created_at DESC, id DESC
          LIMIT 1`,
        [[...modelRevisionById.keys()], operation.id, effectiveStatus],
      );
      const revisionRow = (revRes.rows && revRes.rows[0]) || null;
      if (!revisionRow) {
        return err(
          'OPERATION_REVISION_NOT_FOUND', 404,
          `Operation ${operationCode} 无 ${effectiveStatus} 修订`,
        );
      }

      return {
        ok: true,
        revisionRow,
        modelRevisionRow: modelRevisionById.get(revisionRow.model_revision_id) || null,
      };
    } catch (e) {
      console.warn('[registry] resolveOperationRevision 失败:', e && e.message);
      return err('DB_ERROR', 500, 'registry: resolveOperationRevision 查询失败');
    }
  }

  /**
   * 激活修订：沿激活梯向前推进（默认前进一档），CAS 在 status 上，防并发覆盖。
   *  - 终态（DEPRECATED/RETIRED）拒绝（终态拒）。
   *  - 已到目标态 → 幂等成功（changed:false）。
   * @param {{operationRevisionId:string, targetStatus?:string}} q
   */
  async function activateRevision({ operationRevisionId, targetStatus } = {}) {
    if (!hasPg) return err('DB_UNAVAILABLE', 503, 'registry: 无可用 pg 连接');
    if (!operationRevisionId) return err('INVALID_ARGUMENT', 400, 'registry: operationRevisionId 必填');
    if (targetStatus && !ACTIVATE_TARGETS.has(targetStatus)) {
      return err('INVALID_STATE_TRANSITION', 409, `非法激活目标状态: ${targetStatus}`);
    }
    try {
      const current = await readRevision(operationRevisionId);
      if (!current) return err('OPERATION_REVISION_NOT_FOUND', 404, `修订不存在: ${operationRevisionId}`);
      const cur = current.status;

      if (TERMINAL.has(cur)) {
        return err('REVISION_TERMINAL_STATE', 409, `修订 ${operationRevisionId} 已处终态 ${cur}，不可再激活`);
      }

      // 确定目标态：显式 target 或默认前进一档
      let target = targetStatus || null;
      if (!target) {
        const curRank = RANK.has(cur) ? RANK.get(cur) : -1;
        target = curRank < 0 || curRank + 1 >= ACTIVATION_LADDER.length
          ? 'ACTIVE'
          : ACTIVATION_LADDER[curRank + 1];
      }

      // 状态机合法性：不允许回退
      if (RANK.has(cur) && RANK.has(target) && RANK.get(target) < RANK.get(cur)) {
        return err('INVALID_STATE_TRANSITION', 409, `禁止回退: ${cur} → ${target}`);
      }

      // 幂等：已在目标态
      if (cur === target) {
        return { ok: true, revisionRow: current, previousStatus: cur, status: cur, changed: false };
      }

      // CAS：WHERE status = 读取时态，并发下只有一方成功
      const up = await pg.query(
        `UPDATE model_operation_revisions
            SET status = $2,
                activated_at = CASE WHEN $2 = 'ACTIVE' THEN NOW() ELSE activated_at END
          WHERE id = $1 AND status = $3
          RETURNING *`,
        [operationRevisionId, target, cur],
      );
      if (up.rowCount > 0 && up.rows && up.rows[0]) {
        return { ok: true, revisionRow: up.rows[0], previousStatus: cur, status: target, changed: true };
      }

      // CAS 未命中：区分「行已消失(404)」与「并发已改(409)」
      const after = await readRevision(operationRevisionId);
      if (!after) return err('OPERATION_REVISION_NOT_FOUND', 404, `修订不存在: ${operationRevisionId}`);
      return err('CONCURRENT_TRANSITION', 409,
        `修订 ${operationRevisionId} 状态已并发变更为 ${after.status}（期望 ${cur}）`,
        { currentStatus: after.status });
    } catch (e) {
      console.warn('[registry] activateRevision 失败:', e && e.message);
      return err('DB_ERROR', 500, 'registry: activateRevision 失败');
    }
  }

  /**
   * 下线修订：非终态 → DEPRECATED（默认）/RETIRED；终态拒绝；CAS 在 status 上。
   * @param {{operationRevisionId:string, targetStatus?:string}} q
   */
  async function deactivate({ operationRevisionId, targetStatus } = {}) {
    if (!hasPg) return err('DB_UNAVAILABLE', 503, 'registry: 无可用 pg 连接');
    if (!operationRevisionId) return err('INVALID_ARGUMENT', 400, 'registry: operationRevisionId 必填');
    if (targetStatus && !DEACTIVATE_TARGETS.has(targetStatus)) {
      return err('INVALID_STATE_TRANSITION', 409, `非法下线目标状态: ${targetStatus}`);
    }
    try {
      const current = await readRevision(operationRevisionId);
      if (!current) return err('OPERATION_REVISION_NOT_FOUND', 404, `修订不存在: ${operationRevisionId}`);
      const cur = current.status;

      if (TERMINAL.has(cur)) {
        return err('REVISION_TERMINAL_STATE', 409, `修订 ${operationRevisionId} 已处终态 ${cur}，不可再下线`);
      }

      const target = targetStatus || 'DEPRECATED';
      const up = await pg.query(
        `UPDATE model_operation_revisions
            SET status = $2, activated_at = NULL
          WHERE id = $1 AND status = $3
          RETURNING *`,
        [operationRevisionId, target, cur],
      );
      if (up.rowCount > 0 && up.rows && up.rows[0]) {
        return { ok: true, revisionRow: up.rows[0], previousStatus: cur, status: target, changed: true };
      }

      const after = await readRevision(operationRevisionId);
      if (!after) return err('OPERATION_REVISION_NOT_FOUND', 404, `修订不存在: ${operationRevisionId}`);
      return err('CONCURRENT_TRANSITION', 409,
        `修订 ${operationRevisionId} 状态已并发变更为 ${after.status}（期望 ${cur}）`,
        { currentStatus: after.status });
    } catch (e) {
      console.warn('[registry] deactivate 失败:', e && e.message);
      return err('DB_ERROR', 500, 'registry: deactivate 失败');
    }
  }

  return { listOperations, resolveOperationRevision, activateRevision, deactivate };
}

module.exports = {
  createModelRegistry,
  ACTIVATION_LADDER,
  TERMINAL,
};
