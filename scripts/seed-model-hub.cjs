#!/usr/bin/env node
'use strict';
/**
 * seed-model-hub.cjs — 将 model-hub.config.json（43 个模型：image/video/text）灌入后端数据库。
 *
 * 设计目标（对应「后端配好模型 → 前端自动显示 + 执行」闭环）：
 *  - providers 表：每个 vendor 建一个服务商（base_url / protocol / 支持的 type），api_key 留空由后台填。
 *  - models 表：每个模型一行，填充三大承载列：
 *      capabilities  (JSONB) —— 能力标志（图输入/首帧/视觉）
 *      endpoint      (JSONB) —— 接线层（协议 / 同步异步 / region / 原始 notes）
 *      param_template(JSONB) —— 默认参数 + 可渲染选项（qualities/ratios/durations/videoResolutions…）
 *    并额外在 param_template.meta 里塞入定价 / 官方文档 / 是否核实，供前台控制台展示。
 *
 * 幂等：ON CONFLICT(id) DO UPDATE，重复运行只更新、不重复插入。
 *
 * 运行：node scripts/seed-model-hub.cjs
 * 依赖：pg（与 server.js 同环境）。PG 连接参数沿用 server.js 默认值。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── PG 连接（与 server.js 一致）──
const { Pool } = require('pg');
const pgPool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE || 'huabu',
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || '0.0.1abcd',
});

const CONFIG_PATH = path.join(__dirname, 'seed', 'model-hub.config.json');

// ── 工具函数 ──
function stableId(prefix, str) {
  const s = (str || '').toString();
  const h = crypto.createHash('md5').update(s).digest('hex').slice(0, 6);
  const clean = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40);
  return prefix + (clean ? clean + '-' : '') + h;
}

// 像素尺寸 → 1k/2k/3k/4k/8k 桶（图片 supported_resolutions 用，受 Resolution 类型约束）
function pixelSizeToBucket(size) {
  if (!size || typeof size !== 'string') return '1k';
  const nums = size.match(/\d+/g);
  if (!nums || nums.length < 1) return '1k';
  const maxDim = Math.max(...nums.map(Number));
  if (maxDim <= 1280) return '1k';
  if (maxDim <= 1920) return '2k';
  if (maxDim <= 2560) return '3k';
  if (maxDim <= 3840) return '4k';
  return '8k';
}

// 视频分辨率档位标签（自由字符串）："1280x720" → "720p"；"1080p" → "1080p"
function videoResolutionLabel(res) {
  if (!res || typeof res !== 'string') return null;
  const m = res.match(/(\d+)\s*[xX]\s*(\d+)/);
  if (m) {
    const shortSide = Math.min(Number(m[1]), Number(m[2]));
    return shortSide + 'p';
  }
  return res; // 已像 "1080p" / "4k"
}

// "16s" → 16；"8s" → 8；无效 → null
function parseDuration(d) {
  if (!d) return null;
  const m = String(d).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

// 从 size 推导默认比例（仅用于 image 无 aspect_ratio 时兜底）
function sizeToRatio(size) {
  if (!size || typeof size !== 'string') return '1:1';
  const m = size.match(/(\d+)\s*[xX]\s*(\d+)/);
  if (!m) return '1:1';
  const w = Number(m[1]);
  const h = Number(m[2]);
  const r = w / h;
  if (Math.abs(r - 1) < 0.05) return '1:1';
  if (Math.abs(r - 16 / 9) < 0.05) return '16:9';
  if (Math.abs(r - 9 / 16) < 0.05) return '9:16';
  if (Math.abs(r - 4 / 3) < 0.05) return '4:3';
  if (Math.abs(r - 3 / 4) < 0.05) return '3:4';
  if (Math.abs(r - 3 / 2) < 0.05) return '3:2';
  if (Math.abs(r - 2 / 3) < 0.05) return '2:3';
  if (Math.abs(r - 21 / 9) < 0.05) return '21:9';
  return '1:1';
}

const IMAGE_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', 'auto'];
const VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
const VIDEO_STD_DURATIONS = [4, 6, 8, 10];

// ── 核心：把单个 model-hub 条目映射成 DB 行 ──
function buildModelRow(cfg) {
  const category = cfg.category; // image | video | text
  const dp = cfg.default_params || {};

  // 能力标志
  let capabilities = {};
  if (category === 'text') {
    capabilities = { vision: false };
  } else if (category === 'image') {
    capabilities = { imageInput: false, asFirstFrame: true, asVisionInput: true };
  } else if (category === 'video') {
    capabilities = { imageInput: false, asFirstFrame: false, asVisionInput: false };
  }

  // 接线层（endpoint）
  const endpoint = {
    protocol: cfg.openai_compatible ? 'openai-compatible' : 'custom',
    async: !!cfg.async,
    region: cfg.region || null,
    access: cfg.access || null,
    streaming: cfg.streaming || 'none',
    notes: cfg.notes || '',
    officialDoc: cfg.official_doc || null,
    asyncFlow: cfg.async_flow || null,
    auth: cfg.auth || null,
  };

  // 参数模板（驱动前台表单渲染）
  let paramTemplate = { allowCount: false, rules: [] };
  let supportedResolutions = [];

  if (category === 'image') {
    const quality = dp.quality && ['low', 'standard', 'high'].includes(dp.quality) ? dp.quality : 'standard';
    const ratio = dp.aspect_ratio || sizeToRatio(dp.size);
    const resolution = pixelSizeToBucket(dp.size);
    supportedResolutions = [resolution];
    paramTemplate = {
      qualities: ['low', 'standard', 'high'],
      ratios: Array.from(new Set([ratio, ...IMAGE_RATIOS])),
      resolutions: Array.from(new Set([resolution, '1k', '2k', '4k'])).filter((r) =>
        ['1k', '2k', '3k', '4k', '8k'].includes(r),
      ),
      allowCount: true,
      supportsNegative: true,
      supportsReference: false,
      defaults: {
        quality,
        ratio,
        resolution,
      },
      rules: [{ label: '文生图', description: '默认文生图；开启参考图后可图生图（后台可开 supportsReference）' }],
    };
  } else if (category === 'video') {
    const dur = parseDuration(dp.duration);
    const vrLabel = videoResolutionLabel(dp.resolution);
    const ratios = Array.from(new Set([dp.aspect_ratio || '16:9', ...VIDEO_RATIOS]));
    const durations = Array.from(new Set([...(dur ? [dur] : []), ...VIDEO_STD_DURATIONS])).sort((a, b) => a - b);
    paramTemplate = {
      qualities: ['standard', 'high'],
      ratios,
      durations,
      videoResolutionsEnabled: true,
      videoResolutions: Array.from(new Set([...(vrLabel ? [vrLabel] : []), '720p', '1080p', '4k'])),
      allowCount: false,
      supportsNegative: true,
      supportsReference: true,
      defaults: {
        quality: 'standard',
        ratio: dp.aspect_ratio || '16:9',
        duration: dur || 8,
      },
      rules: [{ label: '异步生成', description: '视频为异步任务，提交后轮询结果；支持首帧/参考图' }],
    };
  } else {
    // text：无生成参数
    paramTemplate = { allowCount: false, rules: [] };
  }

  // 把定价/文档/核实状态塞进 meta，供前台展示（后端忽略未知字段）
  paramTemplate.meta = {
    pricing: cfg.pricing || '',
    officialDoc: cfg.official_doc || null,
    verified: !!cfg.verified,
    region: cfg.region || null,
    access: cfg.access || null,
    async: !!cfg.async,
    openaiCompatible: !!cfg.openai_compatible,
    sourceDefaults: dp, // 官方默认参数原文，供展示/兜底
    notes: cfg.notes || '',
  };

  return {
    id: cfg.id,
    modelId: cfg.id,
    displayName: cfg.name || cfg.id,
    mappingName: '',
    type: category,
    category: category, // 细分类（与 type 同值，后台可细化）
    enabled: true,
    supportedResolutions,
    capabilities,
    endpoint,
    paramTemplate,
    creditCost: 0, // 初始 0，管理员在 ModelHub 设定计费
    supportsRewardBalance: true,
    rewardCreditsRequired: 0,
    maxConcurrent: null,
    estimatedSeconds: category === 'video' ? 60 : category === 'text' ? 8 : 20,
    commercialUse: category === 'text' ? true : null,
    creator: { name: cfg.vendor || '未知厂商' },
  };
}

(async () => {
  let client;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfgDoc = JSON.parse(raw);
    const models = cfgDoc.models || [];
    if (!models.length) throw new Error('model-hub.config.json 中没有 models');

    client = await pgPool.connect();
    await client.query('BEGIN');

    // 1) 建 providers（按 vendor 聚合；base_url 参与去重，避免「字节跳动」两个子厂牌冲突）
    const providerMap = new Map(); // providerId -> {row, categories:Set}
    for (const m of models) {
      const pid = stableId('prov-', (m.vendor || 'unknown') + '|' + (m.base_url || 'no-endpoint'));
      if (!providerMap.has(pid)) {
        providerMap.set(pid, {
          id: pid,
          name: m.vendor || 'unknown',
          type: 'official',
          baseUrl: m.base_url || '',
          apiKey: '',
          supportedTypes: new Set(),
          protocol: m.openai_compatible ? 'openai-compatible' : 'custom',
          enabled: true,
          remark: `由 model-hub 种子导入（${m.region || ''}）`,
          defaultEndpoint: { protocol: m.openai_compatible ? 'openai-compatible' : 'custom', async: !!m.async },
        });
      }
      const p = providerMap.get(pid);
      p.supportedTypes.add(m.category);
    }

    let providersUpserted = 0;
    for (const p of providerMap.values()) {
      const types = Array.from(p.supportedTypes);
      await client.query(
        `INSERT INTO providers (id, name, type, base_url, api_key, supported_types, enabled, protocol, remark, default_endpoint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           name=EXCLUDED.name, type=EXCLUDED.type, base_url=EXCLUDED.base_url,
           supported_types=EXCLUDED.supported_types, enabled=EXCLUDED.enabled,
           protocol=EXCLUDED.protocol, remark=EXCLUDED.remark, default_endpoint=EXCLUDED.default_endpoint`,
        [p.id, p.name, p.type, p.baseUrl, p.apiKey, types, p.enabled, p.protocol, p.remark, JSON.stringify(p.defaultEndpoint)],
      );
      providersUpserted++;
    }

    // 2) 建 models
    let modelsUpserted = 0;
    for (const m of models) {
      const row = buildModelRow(m);
      const pid = stableId('prov-', (m.vendor || 'unknown') + '|' + (m.base_url || 'no-endpoint'));
      await client.query(
        `INSERT INTO models
          (id, model_id, display_name, mapping_name, type, category, provider_id, enabled,
           supported_resolutions, capabilities, endpoint, param_template, credit_cost,
           supports_reward_balance, reward_credits_required, max_concurrent, estimated_seconds, commercial_use, creator)
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,
           $9, $10::jsonb, $11::jsonb, $12::jsonb, $13,
           $14, $15, $16, $17, $18, $19::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           model_id=EXCLUDED.model_id, display_name=EXCLUDED.display_name, mapping_name=EXCLUDED.mapping_name,
           type=EXCLUDED.type, category=EXCLUDED.category, provider_id=EXCLUDED.provider_id, enabled=EXCLUDED.enabled,
           supported_resolutions=EXCLUDED.supported_resolutions, capabilities=EXCLUDED.capabilities,
           endpoint=EXCLUDED.endpoint, param_template=EXCLUDED.param_template, credit_cost=EXCLUDED.credit_cost,
           supports_reward_balance=EXCLUDED.supports_reward_balance, reward_credits_required=EXCLUDED.reward_credits_required,
           max_concurrent=EXCLUDED.max_concurrent, estimated_seconds=EXCLUDED.estimated_seconds,
           commercial_use=EXCLUDED.commercial_use, creator=EXCLUDED.creator`,
        [
          row.id, row.modelId, row.displayName, row.mappingName, row.type, row.category, pid, row.enabled,
          row.supportedResolutions, JSON.stringify(row.capabilities), JSON.stringify(row.endpoint),
          JSON.stringify(row.paramTemplate), row.creditCost, row.supportsRewardBalance,
          row.rewardCreditsRequired, row.maxConcurrent, row.estimatedSeconds, row.commercialUse,
          JSON.stringify(row.creator),
        ],
      );
      modelsUpserted++;
    }

    await client.query('COMMIT');

    // 3) 统计输出
    const byCat = {};
    for (const m of models) byCat[m.category] = (byCat[m.category] || 0) + 1;
    console.log('✅ seed-model-hub 完成：');
    console.log(`   providers 写入/更新：${providersUpserted}`);
    console.log(`   models    写入/更新：${modelsUpserted}`);
    console.log(`   分类分布：${JSON.stringify(byCat)}`);
    console.log('   提示：api_key 已留空，请在后台 ModelHub 为每个服务商填写密钥后模型方可真实执行。');
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('❌ seed-model-hub 失败：', e.message);
    process.exitCode = 1;
  } finally {
    if (client) client.release();
    await pgPool.end().catch(() => {});
  }
})();
