// server/reference-style-audit.cjs — 参考样式 AI 预审
// 原则：AI 只做建议，最终 approve/reject 由人工决定；
//       对任何模棱两可、可能违规、质量存疑的内容一律 flag 并说明原因。
//       AI 不会直接 approved。

const accounting = require('./accounting.cjs');

const GUARD = "m.enabled=true AND p.enabled=true AND p.api_key IS NOT NULL AND LENGTH(p.api_key) >= 6 ";
const COLS = "m.id AS m_id, m.model_id, m.display_name, m.credit_cost, p.id AS p_id, p.base_url, p.api_key, p.protocol ";

async function selectCandidates(pgPool) {
  // 1) 后台显式指定审核模型
  let appAuditModel = '';
  try {
    const sr = await pgPool.query("SELECT value FROM settings WHERE key='app'");
    const sv = (sr.rows[0] && sr.rows[0].value) || {};
    appAuditModel = sv && sv.styleAuditModel ? String(sv.styleAuditModel) : '';
  } catch (_) {}

  const candidates = [];
  if (appAuditModel) {
    const r = await pgPool.query(
      `SELECT ${COLS}FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.id=$1 AND ${GUARD}`,
      [appAuditModel],
    );
    if (r.rows.length) candidates.push(r.rows[0]);
  }

  // 2) 智能体专属 agent_providers（agent_key='style_auditor'）
  if (candidates.length === 0) {
    const r = await pgPool.query(
      `SELECT ${COLS}FROM agent_providers ap JOIN models m ON m.id = ap.model
       JOIN providers p ON p.id = m.provider_id
       WHERE ap.agent_key='style_auditor' AND ap.enabled=true AND ${GUARD}
       ORDER BY ap.priority ASC, ap.weight DESC, m.credit_cost ASC`,
    );
    for (const row of r.rows) candidates.push(row);
  }

  // 3) 回退：所有启用的 text 模型（很多多模态模型注册为 text）
  if (candidates.length === 0) {
    const r = await pgPool.query(
      `SELECT ${COLS}FROM models m JOIN providers p ON p.id = m.provider_id
       WHERE m.type='text' AND ${GUARD}
       ORDER BY m.credit_cost ASC, m.id ASC`,
    );
    for (const row of r.rows) candidates.push(row);
  }
  return candidates.slice(0, 6);
}

const AUDIT_SYSTEM_PROMPT = [
  '你是一名严格、谨慎的 AI 图像内容审核员，负责判断一张参考样式图是否适合在公共平台展示并被其他用户作为参考。',
  '你必须同时看到图片和文字信息，基于事实做出判断。',
  '',
  '【审核维度】',
  '1. 涉黄/性暗示/NSFW：裸露、性器官、性行为、强烈性暗示、情趣/成人内容。',
  '2. 暴力/血腥/恐怖：真实或逼真的血腥、残害、自残、恐怖猎奇、令人极度不适的画面。',
  '3. 政治/敏感/仇恨：政治人物、国家标志、敏感事件、煽动仇恨、歧视、极端主义。',
  '4. 侵权/水印/商标：明显带第三方水印、LOGO、品牌标识、版权角色/明星/IP（如迪士尼、漫威、真人明星）。',
  '5. 隐私/真人：可识别真实个人面部+个人身份信息、未经同意的真人照片。',
  '6. 低质量/不可用：严重模糊、黑屏、纯色、明显崩坏、文字乱码、无法作为参考。',
  '7. 误导/不当：与 prompt 严重不符、可能误导其他用户。',
  '',
  '【核心原则】',
  '- 宁可误判，不可漏判：对任何模棱两可、不好判断、可能引发争议的内容，一律 flag 并说明具体原因。',
  '- 只有“明显安全、无争议、高质量、适合公开参考”的样式才返回 pass。',
  '- 不要过度敏感：正常艺术、时尚、风景、产品设计、动漫角色（非盗用 IP）可以 pass。',
  '',
  '【输出格式】',
  '只输出一段严格 JSON，不要任何解释、 markdown 代码块或额外文字：',
  '{"decision":"flag" | "pass", "reason":"中文原因，50字以内"}',
  '',
  'decision 含义：',
  '- "flag"：存在疑虑或违规，必须转交人工审核。',
  '- "pass"：AI 认为明显安全，但仍需人工最终确认（人工有最终决定权）。',
].join('\n');

function buildUserMessage(style) {
  const text = [
    '请审核以下参考样式：',
    `样式名称：${style.name || '未命名'}`,
    `用户描述：${style.description || '无'}`,
    `生成提示词：${style.prompt || '无'}`,
    `图片地址：${style.preview_url || style.full_url || ''}`,
    '',
    '请结合图片和文字信息，按系统提示的格式输出 JSON 审核结果。',
  ].join('\n');
  return [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: style.preview_url || style.full_url || '' } },
  ];
}

function parseAuditJson(text) {
  if (!text) return null;
  let s = text.trim();
  // 去掉可能的 markdown 代码块
  if (s.startsWith('```')) {
    s = s.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
  }
  const idx = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (idx === -1 || last === -1 || last <= idx) return null;
  try {
    const obj = JSON.parse(s.slice(idx, last + 1));
    if (obj && typeof obj.decision === 'string' && typeof obj.reason === 'string') {
      return { decision: obj.decision.trim().toLowerCase(), reason: obj.reason.trim() };
    }
  } catch {}
  return null;
}

async function auditStyle(pgPool, styleId, actorId) {
  if (!pgPool) return;
  const styleR = await pgPool.query(
    'SELECT id, user_id, name, description, preview_url, full_url, prompt, status FROM reference_styles WHERE id=$1',
    [styleId],
  );
  if (!styleR.rows.length) return;
  const style = styleR.rows[0];
  if (style.status !== 'pending') return;

  const candidates = await selectCandidates(pgPool).catch(() => []);
  if (!candidates.length) {
    await pgPool.query(
      "UPDATE reference_styles SET status='ai_flagged', ai_reason=$1, updated_at=NOW() WHERE id=$2",
      ['未配置可用审核模型，转人工审核', styleId],
    );
    return;
  }

  let lastModel = null;
  let lastError = '';
  let result = null;
  let usage = null;

  for (const candidate of candidates) {
    lastModel = candidate;
    const base = (candidate.base_url || '').trim().replace(/\/+$/, '');
    if (!base) { lastError = '未配置 base_url'; continue; }
    try {
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${candidate.api_key}` },
        body: JSON.stringify({
          model: candidate.model_id,
          messages: [
            { role: 'system', content: AUDIT_SYSTEM_PROMPT },
            { role: 'user', content: buildUserMessage(style) },
          ],
          max_tokens: 800,
          temperature: 0.2,
          response_format: { type: 'json_object' },
        }),
      });
      const raw = await r.text();
      if (!r.ok) {
        lastError = `HTTP ${r.status}: ${raw.slice(0, 120)}`;
        continue;
      }
      let data; try { data = JSON.parse(raw); } catch { lastError = '返回非 JSON'; continue; }
      const msg = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
      const rawText = `${msg.content || ''}\n${msg.reasoning_content || ''}`.trim();
      const parsed = parseAuditJson(rawText);
      if (!parsed) { lastError = '未返回合法 JSON'; continue; }
      result = parsed;
      usage = (data && data.usage) || null;
      break;
    } catch (e) {
      lastError = e.message;
    }
  }

  if (!result) {
    await pgPool.query(
      "UPDATE reference_styles SET status='ai_flagged', ai_reason=$1, updated_at=NOW() WHERE id=$2",
      [`AI 审核调用失败：${lastError || '所有候选模型不可用'}，转人工`, styleId],
    );
    return;
  }

  const status = result.decision === 'pass' ? 'ai_passed' : 'ai_flagged';
  await pgPool.query(
    'UPDATE reference_styles SET status=$1, ai_reason=$2, updated_at=NOW() WHERE id=$3',
    [status, result.reason, styleId],
  );

  // 双边记账：AI 审核对客户免费，平台成本照实记录
  try {
    await accounting.recordConsumption(pgPool, {
      scope: 'system',
      actorId: actorId || style.user_id || '',
      purpose: 'agent:style-audit',
      providerId: lastModel.p_id || '',
      modelId: lastModel.model_id || '',
      modelType: 'text',
      inputUnits: usage && usage.prompt_tokens ? usage.prompt_tokens : 0,
      outputUnits: usage && usage.completion_tokens ? usage.completion_tokens : 0,
      customerChargeCredits: 0,
      idempotencyKey: `style-audit-${styleId}-${Date.now()}`,
    });
  } catch (e) { console.warn('[style-audit accounting]', e.message); }
}

module.exports = { auditStyle };
