'use strict';
/**
 * W3-12/W3-13 — Asset lineage graph + Selected Asset Version ↔ Shot binding (pure, no I/O).
 * W3-12: asset-version lineage (uploaded/generated/derived, derived_from edges) is queryable + traces source.
 * W3-13: the selected Asset Version bound to a Shot is tracked deterministically.
 */

/** Build a lineage graph from asset-version edges. Returns adjacency + a deterministic root/source resolution. */
function buildLineageGraph(versions) {
  const byId = new Map((versions || []).map((v) => [v.version_id, v]));
  const children = new Map(); // version_id -> Set(child ids)
  for (const v of versions || []) {
    if (v.derived_from && byId.has(v.derived_from)) {
      if (!children.has(v.derived_from)) children.set(v.derived_from, new Set());
      children.get(v.derived_from).add(v.version_id);
    }
  }
  return {
    ids: (versions || []).map((v) => v.version_id),
    edges: (versions || []).filter((v) => v.derived_from).map((v) => ({ from: v.derived_from, to: v.version_id })),
    children: Object.fromEntries([...children].map(([k, v]) => [k, [...v]])),
    byId: Object.fromEntries([...byId].map(([k, v]) => [k, v])),
  };
}

/** Resolve the origin/source of an asset version (walk derived_from to a root, detect cycles). */
function resolveLineage(version, graph) {
  const seen = new Set();
  let cur = version;
  const path = [];
  let sourceGenerationId = null;
  while (cur) {
    if (seen.has(cur.version_id)) return { ok: false, error: { code: 'LINEAGE_CYCLE' } };
    seen.add(cur.version_id);
    if (!sourceGenerationId && cur.generation_id) sourceGenerationId = cur.generation_id; // nearest generation
    if (!cur.derived_from) break;
    cur = graph.byId[cur.derived_from] || null;
    if (cur) path.push(cur.version_id);
  }
  const origin = cur || version;
  return { ok: true, originId: origin.version_id, originKind: origin.kind || 'upload', path, sourceGenerationId };
}

/** W3-13: deterministically bind a selected asset version to a shot. Returns {ok, binding}. */
function buildShotAssetBinding({ shotId, assetVersionId }) {
  if (!shotId || !assetVersionId) return { ok: false, error: { code: 'BINDING_MISSING_FIELDS' } };
  return { ok: true, binding: { shotId, assetVersionId, boundAt: new Date().toISOString(), bindingHash: `${shotId}:${assetVersionId}` } };
}

// ─────────────────────────────────────────────────────────────────────────────────
// L47 — Generation Lineage（§83）：Job 级生成链路写入 + 级联查询（ancestors/descendants）。
//
// 实查结论（本叶裁决依据）：
//   - 本模块原有三函数（buildLineageGraph/resolveLineage/buildShotAssetBinding）是纯函数，
//     操作 asset_versions 的「版本级」derived_from 边，无自有表、无 I/O。
//   - shotLineage.cjs 是只读 trace 查询，无 lineage 表。
//   - 故 Job 级 lineage 无既有表可加列 → 0070 追加 additive 新表 generation_lineage
//     （child_job_id PK / parent_job_id / source_asset_ids TEXT[] / relation CHECK）。
//
// 本段提供两类能力（延续 shotLineage.cjs 的 DI 形状 { pg }）：
//   1) 纯函数：resolveParentJobId / resolveSourceAssetIds / resolveRelation —— 从
//      finalize 时的 output manifest「parent 链」解析上游与源资产，规则：
//        · provider/manifest 显式给 parent → 用之；
//        · 否则用调用方注入的 parentJobId（连续镜头 / 工作流步骤由调用方注入）；
//        · 都没有 → null（provider 无显式 parent → null）。
//   2) createGenerationLineage({ pg })：recordLineage（幂等写）/ recordFinalizeLineage
//      （finalize 成功时写 lineage 的入口）/ getLineage / getAncestors / getDescendants
//      （级联查，环安全）。
//
// 幂等语义：child_job_id 为幂等锚点，ON CONFLICT (child_job_id) DO NOTHING ——
//   首写胜出，重复写（finalize 重放/崩溃恢复重入）不产生重复行、不覆盖既有边。
//   返回 created=false 表示该行已存在（no-op）。
//
// 本叶只写此模块与 0070 追加，不接线 assetFinalize（勿动其它）；finalize 成功的调用方
//   在 jobSuccess 后调用 recordFinalizeLineage({ jobId, manifest, parentJobId, sourceAssetIds }) 即可。

const LINEAGE_RELATIONS = Object.freeze(['child_of_job', 'derived_from_asset', 'retry_of']);

// 本模块 SQL（导出供测试 fake pg 按句路由；与 shotLineage.cjs 的 SQL 导出同款做法）。
const LINEAGE_SQL = {
  INSERT: `INSERT INTO generation_lineage (child_job_id, parent_job_id, source_asset_ids, relation)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (child_job_id) DO NOTHING`,
  SELECT_BY_CHILD: `SELECT child_job_id, parent_job_id, source_asset_ids, relation, created_at
     FROM generation_lineage
    WHERE child_job_id = $1`,
  SELECT_BY_PARENT: `SELECT child_job_id, parent_job_id, source_asset_ids, relation, created_at
     FROM generation_lineage
    WHERE parent_job_id = $1
    ORDER BY created_at ASC, child_job_id ASC`,
};

function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }
function linErr(code, message) { return { ok: false, error: { code, message } }; }

// §83 经 manifest parent 链解析 parent_job_id：
//   1) manifest 显式携带 parent（provider/上游注入的 parent_job_id / lineage.parent_job_id
//      或 provider_metadata.parent_job_id，兼容 camelCase/snake_case）；
//   2) 否则用调用方注入的 parentJobId（连续镜头/工作流步骤由调用方注入）；
//   3) 都没有 → null（provider 无显式 parent → null）。
function resolveParentJobId(manifest, injectedParentJobId) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const lg = m.lineage && typeof m.lineage === 'object' ? m.lineage : {};
  const pm = m.provider_metadata && typeof m.provider_metadata === 'object' ? m.provider_metadata : {};
  const explicit = m.parent_job_id || m.parentJobId
    || lg.parent_job_id || lg.parentJobId
    || pm.parent_job_id || pm.parentJobId;
  if (isNonEmptyString(explicit)) return String(explicit).trim();
  if (isNonEmptyString(injectedParentJobId)) return String(injectedParentJobId).trim();
  return null;
}

// §83 解析 source_asset_ids（本 Job 消费的源资产）。优先级：调用方注入 > manifest 显式；
// 归一为去空字符串数组（单值/多值均兼容）。
function resolveSourceAssetIds(manifest, injectedSourceAssetIds) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const lg = m.lineage && typeof m.lineage === 'object' ? m.lineage : {};
  let src = (Array.isArray(injectedSourceAssetIds) && injectedSourceAssetIds.length)
    ? injectedSourceAssetIds
    : (m.source_asset_ids || m.sourceAssetIds || lg.source_asset_ids || lg.sourceAssetIds);
  if (src == null) return [];
  const arr = Array.isArray(src) ? src : [src];
  return arr.filter((x) => x != null && String(x).trim() !== '').map((x) => String(x));
}

// §83 推断 relation：显式 relation（合法三态）优先；否则「有源资产且无 parent」→
//   derived_from_asset；否则 child_of_job（retry_of 须调用方显式指定）。
function resolveRelation(relation, parentJobId, sourceAssetIds) {
  if (relation && LINEAGE_RELATIONS.includes(relation)) return relation;
  if (parentJobId == null && Array.isArray(sourceAssetIds) && sourceAssetIds.length) return 'derived_from_asset';
  return 'child_of_job';
}

function formatLineageRow(row, depth) {
  if (!row) return null;
  return {
    childJobId: row.child_job_id,
    parentJobId: row.parent_job_id != null ? row.parent_job_id : null,
    relation: row.relation,
    sourceAssetIds: Array.isArray(row.source_asset_ids) ? row.source_asset_ids : [],
    depth,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function createGenerationLineage({ pg }) {
  if (!pg || typeof pg.query !== 'function') {
    throw new TypeError('createGenerationLineage: { pg } with query() required');
  }

  /**
   * 幂等写一条 lineage 边（first-write-wins）。child_job_id 为幂等锚点。
   * @returns {Promise<{ok:true, created:boolean, lineage:object} | {ok:false, error:{code,message}}>}
   *   created=false 表示该 child_job_id 已有行（重复写被 ON CONFLICT 吞掉，不覆盖）。
   */
  async function recordLineage({ childJobId, parentJobId, sourceAssetIds, relation } = {}) {
    if (!isNonEmptyString(childJobId)) {
      return linErr('INVALID_CHILD_JOB_ID', 'childJobId (non-empty string) required');
    }
    const child = String(childJobId).trim();
    const parent = isNonEmptyString(parentJobId) ? String(parentJobId).trim() : null;
    if (parent != null && parent === child) {
      return linErr('SELF_PARENT_FORBIDDEN', 'parentJobId must not equal childJobId');
    }
    const rel = relation != null ? String(relation) : null;
    if (rel != null && !LINEAGE_RELATIONS.includes(rel)) {
      return linErr('INVALID_RELATION', `relation must be one of ${LINEAGE_RELATIONS.join('/')}`);
    }
    const sources = Array.isArray(sourceAssetIds)
      ? sourceAssetIds.filter((x) => x != null && String(x).trim() !== '').map((x) => String(x))
      : [];
    const finalRelation = rel || resolveRelation(null, parent, sources);

    const r = await pg.query(LINEAGE_SQL.INSERT, [child, parent, sources, finalRelation]);
    const created = !!(r && r.rowCount > 0);
    return {
      ok: true,
      created,
      lineage: { childJobId: child, parentJobId: parent, relation: finalRelation, sourceAssetIds: sources },
    };
  }

  /**
   * finalize 成功时写 lineage 的入口（§83）。解析规则见文件头：
   *   parent 经 manifest parent 链（provider 显式 → 调用方注入 → null）；
   *   source_asset_ids 经 manifest / 调用方；relation 三态推断。
   * @param {{jobId:string, parentJobId?:string, sourceAssetIds?:string[], manifest?:object, relation?:string}} params
   */
  async function recordFinalizeLineage({ jobId, parentJobId, sourceAssetIds, manifest, relation } = {}) {
    if (!isNonEmptyString(jobId)) {
      return linErr('INVALID_JOB_ID', 'jobId (non-empty string) required');
    }
    const childJobId = String(jobId).trim();
    const parent = resolveParentJobId(manifest, parentJobId);
    const sources = resolveSourceAssetIds(manifest, sourceAssetIds);
    const rel = resolveRelation(relation, parent, sources);
    return recordLineage({ childJobId, parentJobId: parent, sourceAssetIds: sources, relation: rel });
  }

  /** 读单条边（child_job_id 的 lineage 行）；无行 → lineage:null。 */
  async function getLineage(childJobId) {
    if (!isNonEmptyString(childJobId)) {
      return linErr('INVALID_CHILD_JOB_ID', 'childJobId (non-empty string) required');
    }
    const r = await pg.query(LINEAGE_SQL.SELECT_BY_CHILD, [String(childJobId).trim()]);
    const row = (r && r.rows && r.rows[0]) || null;
    return { ok: true, lineage: formatLineageRow(row, 0) };
  }

  /**
   * 级联查上游祖先（沿 parent_job_id 上溯，环安全）。
   * @returns {Promise<{ok:true, chain:Array<lineage edge>}>}
   *   chain[i] = 从被查节点向上的第 i 代「边」（generation_lineage 行原样 + depth）：
   *     chain[0].childJobId = 被查节点，chain[0].parentJobId = 其直接父；
   *     chain[1] = 父的边 … 直到 parent 为 NULL 或无行。
   *   祖先 job id 序列 = chain.map(r => r.parentJobId).filter(x => x != null)。
   */
  async function getAncestors(childJobId) {
    if (!isNonEmptyString(childJobId)) {
      return linErr('INVALID_CHILD_JOB_ID', 'childJobId (non-empty string) required');
    }
    const chain = [];
    const visited = new Set();
    let current = String(childJobId).trim();
    let depth = 0;
    while (current != null) {
      if (visited.has(current)) break; // 环守卫：绝不无限上溯
      visited.add(current);
      const r = await pg.query(LINEAGE_SQL.SELECT_BY_CHILD, [current]);
      const row = (r && r.rows && r.rows[0]) || null;
      if (!row) break; // 该节点无 lineage 行 → 链在此截断
      chain.push(formatLineageRow(row, depth));
      current = row.parent_job_id != null ? String(row.parent_job_id) : null;
      depth += 1;
    }
    return { ok: true, chain };
  }

  /**
   * 级联查下游后代（沿 parent_job_id 下溯 BFS，环安全、按代序）。
   * @returns {Promise<{ok:true, chain:Array<lineage edge>}>}
   *   chain 按 depth 升序（depth 1 = 直接子，depth 2 = 孙 …），每条为 generation_lineage 行 + depth。
   */
  async function getDescendants(jobId) {
    if (!isNonEmptyString(jobId)) {
      return linErr('INVALID_CHILD_JOB_ID', 'jobId (non-empty string) required');
    }
    const chain = [];
    const visited = new Set([String(jobId).trim()]);
    let frontier = [String(jobId).trim()];
    let depth = 0;
    while (frontier.length) {
      const next = [];
      for (const id of frontier) {
        const r = await pg.query(LINEAGE_SQL.SELECT_BY_PARENT, [id]);
        for (const row of ((r && r.rows) || [])) {
          if (visited.has(row.child_job_id)) continue; // 环守卫
          visited.add(row.child_job_id);
          chain.push(formatLineageRow(row, depth + 1));
          next.push(row.child_job_id);
        }
      }
      frontier = next;
      depth += 1;
    }
    return { ok: true, chain };
  }

  return { recordLineage, recordFinalizeLineage, getLineage, getAncestors, getDescendants };
}

module.exports = {
  buildLineageGraph,
  resolveLineage,
  buildShotAssetBinding,

  // ─── L47 — Generation Lineage（§83：Job.parent_job_id + Asset.source_asset_ids）───
  LINEAGE_RELATIONS,
  resolveParentJobId,
  resolveSourceAssetIds,
  resolveRelation,
  createGenerationLineage,
  LINEAGE_SQL,
};
