// ============================================================
// docs/phase-a/generate_integration.js
// 展示两处改造：① server.js 的 POST /api/generate 接入鉴权+幂等+reserve；
//               ② dispatcher.cjs 的 generateAsync 完成回调里落地 commit/release + 写 media(owner)。
// 注意：这些是对【现有文件】的「改造示意」，非独立可运行模块。
// ============================================================

// ----------------------------------------------------------
// ① server.js — POST /api/generate（替换现有 447 行块）
// ----------------------------------------------------------
// if (url === '/api/generate' && method === 'POST') {
//   if (!pgPool) return sendJSON(res, 200, { status: 'failed', error: '数据库不可用' });
//   // —— 鉴权（G3/多用户前提）——
//   await auth.requireAuth(req, res, async () => {
//     const body = await parseBody(req);
//     if (!body || !body.model || !body.prompt)
//       return sendJSON(res, 400, { error: '缺少 model 或 prompt' });
//
//     // —— 幂等键（G4）：前端每次生成请求生成 UUID 随重试复用 ——
//     const idemKey = (body.idempotencyKey || '').toString().trim();
//     if (!idemKey) return sendJSON(res, 400, { error: '缺少 idempotencyKey' });
//
//     // 已存在同键任务？
//     const ex = await pgPool.query(
//       `SELECT task_id, status FROM generation_tasks WHERE idempotency_key = $1`,
//       [idemKey],
//     );
//     if (ex.rows.length) {
//       const row = ex.rows[0];
//       if (row.status === 'failed') {
//         // 失败的可复用同一键重试：先释放旧 held，再删行腾出唯一约束
//         await billing.releaseCredits(pgPool, req.user.id, row.cost || 0, idemKey).catch(() => {});
//         await pgPool.query(`DELETE FROM generation_tasks WHERE idempotency_key = $1`, [idemKey]);
//       } else {
//         // running/done：直接返回原 taskId，绝不重复 reserve（防双扣）
//         return sendJSON(res, 200, {
//           status: row.status === 'done' ? 'done' : 'pending',
//           taskId: row.task_id, idempotent: true,
//         });
//       }
//     }
//
//     // —— 成本解析：用与 dispatcher 相同的 model 标识查 credit_cost（G5 credits 单位）——
//     const costRes = await pgPool.query(
//       `SELECT credit_cost FROM models WHERE id = $1 OR model_id = $1 LIMIT 1`, [body.model],
//     );
//     const cost = costRes.rows.length ? Number(costRes.rows[0].credit_cost) || 0 : 0;
//
//     // —— reserve（G3 时序：仅在此扣，结算留给后台回调）——
//     try {
//       await billing.reserveCredits(pgPool, req.user.id, cost, idemKey);
//     } catch (e) {
//       return sendJSON(res, 402, { status: 'failed', error: '积分不足' });
//     }
//
//     try {
//       const { taskId, error } = await dispatcher.generateAsync(pgPool, {
//         model: body.model, prompt: body.prompt,
//         ratio: body.ratio || '1:1', resolution: body.resolution || '1k',
//         count: body.count || 1, contentType: body.contentType || 'image',
//         referenceImages: body.referenceImages || [],
//         pendingIds: body.pendingIds || [], user_id: req.user.id,
//         idempotencyKey: idemKey, cost,                 // ← 传入供回调使用
//         clientMeta: { ratio: body.ratio || '1:1', resolution: body.resolution || '1k',
//                       contentType: body.contentType || 'image' },
//       });
//       if (error) {                                    // generateAsync 自身失败：回滚 held
//         await billing.releaseCredits(pgPool, req.user.id, cost, idemKey).catch(() => {});
//         return sendJSON(res, 200, { status: 'failed', error });
//       }
//       return sendJSON(res, 200, { status: 'pending', taskId });
//     } catch (e) {
//       await billing.releaseCredits(pgPool, req.user.id, cost, idemKey).catch(() => {});
//       return sendJSON(res, 200, { status: 'failed', error: `分发异常：${e.message}` });
//     }
//   });
//   return; // requireAuth 已处理响应
// }

// ----------------------------------------------------------
// ② dispatcher.cjs — generateAsync 改造（传入 user_id/idempotencyKey/cost）
// ----------------------------------------------------------
// async function generateAsync(pgPool, opts) {
//   if (!pgPool) return { taskId: null, error: '数据库不可用' };
//   const { model, prompt, count, contentType, referenceImages, pendingIds = [],
//           clientMeta = {}, user_id, idempotencyKey, cost = 0 } = opts;
//   const taskId = `gt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
//   try {
//     await pgPool.query(
//       `INSERT INTO generation_tasks
//          (task_id, status, model, prompt, count, content_type, pending_ids, client_meta, user_id, idempotency_key, cost)
//        VALUES ($1,'running',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
//       [taskId, model || '', prompt || '', count || 1, contentType || 'image',
//        pendingIds, clientMeta, user_id || null, idempotencyKey || null, cost],
//     );
//   } catch (e) { return { taskId: null, error: `写入任务表失败：${e.message}` }; }
//
//   generate(pgPool, opts).then(async (result) => {
//     const ok = result && result.status === 'success' && result.images && result.images.length;
//     try {
//       if (ok) {
//         await billing.commitCredits(pgPool, user_id, cost, idempotencyKey);   // G3 结算点
//         // 服务端写 media（owner=用户，解决 G2；前端改为轮询刷新列表，不再自写）
//         for (const url of result.images) {
//           await pgPool.query(
//             `INSERT INTO media (id, title, type, full_url, thumbnail, prompt, model, ratio, source, user_id, status)
//              VALUES ($1,$2,$3,$4,$4,$5,$6,$7,'user',$8,'success')`,
//             [crypto.randomUUID(), (prompt || '').slice(0, 80), contentType || 'image',
//              url, prompt, model, (clientMeta && clientMeta.ratio) || '1:1', user_id],
//           ).catch((e) => console.warn('[dispatcher] 写 media 失败(已计费):', e.message));
//         }
//       } else {
//         await billing.releaseCredits(pgPool, user_id, cost, idempotencyKey);  // G3 释放点
//       }
//       await pgPool.query(
//         `UPDATE generation_tasks SET status=$2, result=$3, error=$4, completed_at=NOW(), user_id=$5
//          WHERE task_id=$1`,
//         [taskId, ok ? 'done' : 'failed', JSON.stringify(result || {}),
//          (result && result.error) || '', user_id],
//       );
//     } catch (e) { console.warn('[dispatcher] 完成回调失败:', e.message); }
//   }).catch(async (e) => {
//     await billing.releaseCredits(pgPool, user_id, cost, idempotencyKey).catch(() => {});
//     await pgPool.query(
//       `UPDATE generation_tasks SET status='failed', error=$2, completed_at=NOW(), user_id=$3
//        WHERE task_id=$1`,
//       [taskId, String((e && e.message) || e), user_id],
//     ).catch(() => {});
//   });
//   return { taskId };
// }

// ----------------------------------------------------------
// 配套：GET /api/media 必须按 owner 过滤（G2 读侧）
// 现有列表查询 WHERE 子句追加：AND (user_id = $N OR user_id IS NULL)
//   —— user_id IS NULL 兼容 Phase A 前的历史数据（seed / 旧生成），所有人可见。
// ----------------------------------------------------------
