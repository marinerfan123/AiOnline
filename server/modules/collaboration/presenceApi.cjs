'use strict';
/**
 * G22 推进③ — COLLABORATION PRESENCE HTTP API（不挂载，handle 导出 leaf）。
 * 依据 docs/product-v2/18-collaboration-g22-audit.md §3 与 presenceBus.cjs：
 * 给 G22 的 presence 总线补上最小 HTTP 面，路由仅三条 + OPTIONS：
 *   POST /api/v2/presence/heartbeat   {canvasId, state} → bus.heartbeat，200/400
 *   GET  /api/v2/presence/peers/:canvasId               → bus.peers，200 列表
 *   OPTIONS（同上述路由）→ 204（CORS 预检，不要求会话）
 *
 * 设计决策：
 *   - 纯薄壳、零存储依赖：状态机/校验/归一全部下沉到注入的 bus（createPresenceBus），
 *     本模块只做 会话(401) → 路由 → 字段透传 → 结果序列化。userId 一律取自
 *     sessionUser(req).id，绝不信任客户端传入的 userId（防冒名）。
 *   - 归一保证：state=busy 是 legacy alias，bus.heartbeat 在入列前归一 busy→editing，
 *   - 异步兼容：bus 方法一律 await（内存 bus 同步返回亦可 await），支持 PG-backed adapter。
 *     HTTP 层原样透传（canonical 枚举与 alias 语义的单一真源在 presenceBus.cjs）。
 *   - 无会话（sessionUser(req) 为 null/undefined）→ 401 {ok:false,error:'未登录'}，
 *     与 timelineApi/scriptApi 等既有模块一致。
 *   - 路由认领：仅认领 /api/v2/presence 前缀下上述路由；前缀内未匹配的路径/方法
 *     → 404（本模块不生产 405，语义交由未来挂载层的统一网关处理）；
 *     前缀外的 URL → 返回 false，交由可能的 dispatcher 继续尝试。
 *   - ⚠️ sweep 不在 HTTP 面暴露/触发：过期清理由 bus 的宿主在外部定时调度
 *     （如 setInterval 每 5s 调一次 bus.sweep()），本模块只做心跳写入与 peers 读取；
 *     peers() 惰性过滤过期记录，故清理偶发延迟不影响正确性。
 *   - 依赖注入 { bus, sessionUser, sendJSON, parseBody }（无 pg），镜像
 *     timelineApi/uploadApi 的 {pg, sessionUser, sendJSON, parseBody} 壳约定。
 */

const API_PREFIX = '/api/v2/presence';
const HEARTBEAT_PATH = `${API_PREFIX}/heartbeat`;
/** /api/v2/presence/peers/:canvasId —— canvasId 为单个路径段（可含 encodeURIComponent 编码）。 */
const PEERS_PATH_RE = /^\/api\/v2\/presence\/peers\/([^/]+)$/;

/**
 * 创建 presence HTTP API。
 * @param {{ bus:{heartbeat:Function, peers:Function},
 *           sessionUser?: Function, sendJSON: Function, parseBody: Function }} deps
 *   bus         — presenceBus.cjs 的 createPresenceBus() 产物（需 heartbeat/peers；sweep 由外部调度）
 *   sessionUser — (req) => user|null（user.id 作为 userId）
 *   sendJSON    — (res, statusCode, body) => void
 *   parseBody   — async (req) => object|null
 * 返回 { handle }：handle(req, res, urlPath, method) -> Promise<true|false>
 *   true  = 本模块已认领并响应（含前缀内 404）；false = URL 不属于本模块（不响应）。
 */
function createPresenceApi({ bus, sessionUser, sendJSON, parseBody }) {
  if (!bus || typeof bus.heartbeat !== 'function' || typeof bus.peers !== 'function') {
    throw new TypeError('createPresenceApi: bus must provide heartbeat/peers functions');
  }
  if (typeof sendJSON !== 'function' || typeof parseBody !== 'function') {
    throw new TypeError('createPresenceApi: sendJSON and parseBody must be functions');
  }

  /** 会话检查：无会话 → 401 并返回 null；否则返回 user。 */
  function requireUser(req, res) {
    const user = sessionUser ? sessionUser(req) : null;
    if (!user) { sendJSON(res, 401, { ok: false, error: '未登录' }); return null; }
    return user;
  }

  async function handle(req, res, urlPath, method) {
    // 前缀外：不认领，交由 dispatcher（本模块可能被挂载进多模块路由链）。
    if (typeof urlPath !== 'string' || !urlPath.startsWith(API_PREFIX)) return false;

    const isHeartbeat = urlPath === HEARTBEAT_PATH;
    const peersMatch = PEERS_PATH_RE.exec(urlPath);
    if (!isHeartbeat && !peersMatch) {
      // 前缀内但非三条路由 → 404（无论是否有会话，不泄露路由存在性）。
      sendJSON(res, 404, { ok: false, error: '接口不存在' });
      return true;
    }

    // OPTIONS 预检：不要求会话（浏览器跨域预检不带 Authorization）。
    if (method === 'OPTIONS') { sendJSON(res, 204, null); return true; }

    if (method === 'POST' && isHeartbeat) {
      const user = requireUser(req, res);
      if (!user) return true;
      // 客户端可传 canvasId/state；userId 只取会话身份，忽略 body.userId（防冒名）。
      const body = (await parseBody(req)) || {};
      const result = await bus.heartbeat({
        userId: user.id,
        canvasId: body && body.canvasId,
        state: body && body.state,
      });
      if (!result || result.ok !== true) {
        const status = result && Number.isInteger(result.status) ? result.status : 400;
        const errors =
          result && Array.isArray(result.errors) && result.errors.length > 0
            ? result.errors
            : ['heartbeat rejected'];
        return sendJSON(res, status, { ok: false, errors });
      }
      // 200：state=offline 时 bus 返回 presence:null（已摘除），原样透传。
      return sendJSON(res, 200, { ok: true, presence: result.presence === undefined ? null : result.presence });
    }

    if (method === 'GET' && peersMatch) {
      const user = requireUser(req, res);
      if (!user) return true;
      let canvasId;
      try { canvasId = decodeURIComponent(peersMatch[1]); } catch { return sendJSON(res, 400, { ok: false, error: 'canvasId 非法' }); }
      // bus.peers 惰性过滤：仅返回该画布 ≤TTL 且在线的成员；过期记录由外部 sweep 清。
      const peers = await bus.peers(canvasId);
      return sendJSON(res, 200, { ok: true, canvasId, peers });
    }

    // 路由存在但方法不在集合（如 GET /heartbeat）→ 404（同未匹配处理）。
    sendJSON(res, 404, { ok: false, error: '接口不存在' });
    return true;
  }

  return { handle };
}

module.exports = { createPresenceApi };
