// server/seed-defaults.cjs
// 首次部署种子：填充占位服务商 + 常用图像模型，解决 clone 后空库、无模型可选的问题。
// 安全：不含任何真实 API Key，所有 provider 默认 enabled=false，需用户填 Key 后启用。
// 幂等：INSERT ... ON CONFLICT (id) DO NOTHING，可重复运行（已存在则跳过）。
// 注意：本文件放在 server/ 根目录（非 server/data/），确保进入 Docker 镜像并被 git 跟踪。
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

// 默认占位服务商（无 Key，需用户填写并启用）
const DEFAULT_PROVIDERS = [
  {
    id: 'prov-demo',
    name: '示例服务商（待配置）',
    type: 'official',
    base_url: 'https://api.openai.com/v1',
    api_key: '',
    supported_types: ['image', 'text'],
    enabled: false,
    protocol: 'openai-compatible',
    remark: '克隆仓库后的占位服务商：在后台「服务商」填入 API Key 并启用即可使用。',
    default_endpoint: {},
    capacity_model: 'limited',
    cooldown_ms: 60000,
  },
  {
    // MiniMax H3 视频 V2：适配器在 base_url 上拼 /video_generation，故 base_url 必须含 /v2
    id: 'prov-minimax',
    name: 'MiniMax 视频（H3）',
    type: 'official',
    base_url: 'https://api.minimaxi.com/v2',
    api_key: '',
    supported_types: ['video'],
    enabled: false,
    protocol: 'custom',
    remark: 'MiniMax H3 视频 V2：768P/2K，文生/图生首末帧/参考生视频。填 Key 后启用（base_url 含 /v2）。',
    default_endpoint: {},
    capacity_model: 'limited',
    cooldown_ms: 60000,
  },
  {
    // 火山方舟 Seedance：适配器在 base_url 上拼 /contents/generations/tasks，故 base_url 必须含 /api/v3
    id: 'prov-volcano',
    name: '火山方舟（Seedance）',
    type: 'official',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    api_key: '',
    supported_types: ['video'],
    enabled: false,
    protocol: 'custom',
    remark: '火山方舟 Seedance 2.5：480p/720p，文生/图生首末帧/参考生视频。填 Key 后启用（base_url 含 /api/v3）。',
    default_endpoint: {},
    capacity_model: 'limited',
    cooldown_ms: 60000,
  },
];

// 常用图像模型（挂到 prov-demo；provider 无 Key，默认 enabled=false）
const DEFAULT_MODELS = [
  {
    id: 'model-demo-dall-e-3',
    model_id: 'dall-e-3',
    display_name: 'DALL·E 3',
    type: 'image',
    provider_id: 'prov-demo',
    enabled: false,
    supported_resolutions: ['1k', '2k'],
    capabilities: {},
    endpoint: {},
  },
  {
    id: 'model-demo-sdxl',
    model_id: 'stabilityai/stable-diffusion-xl-base-1.0',
    display_name: 'Stable Diffusion XL',
    type: 'image',
    provider_id: 'prov-demo',
    enabled: false,
    supported_resolutions: ['1k', '2k', '4k'],
    capabilities: {},
    endpoint: {},
  },
  {
    id: 'model-demo-flux',
    model_id: 'flux-1.1-pro',
    display_name: 'FLUX 1.1 Pro',
    type: 'image',
    provider_id: 'prov-demo',
    enabled: false,
    supported_resolutions: ['1k', '2k', '4k'],
    capabilities: {},
    endpoint: {},
  },
  {
    // MiniMax H3：videoModes 声明后前台点亮「模式选择器」
    id: 'model-minimax-h3',
    model_id: 'MiniMax-H3',
    display_name: 'MiniMax H3',
    type: 'video',
    provider_id: 'prov-minimax',
    enabled: false,
    supported_resolutions: [],
    capabilities: { imageInput: true },
    endpoint: {},
    param_template: {
      videoResolutionsEnabled: true,
      videoResolutions: ['768P', '2K'],
      videoModes: ['t2v', 'i2v_first', 'i2v_first_last', 'reference_image'],
      durations: [4, 6, 8, 10],
      allowCount: false,
      supportsReference: true,
      rules: [
        { label: '2K 直出', description: 'H3 支持 2K 直出；文生视频需指定比例（非自适应），图生/参考视频由首帧自适应。' },
        { label: '参考图上限', description: '参考生视频最多 9 张图（可含参考视频/音频），前台默认至多 4 张。' },
      ],
    },
  },
  {
    // 火山方舟 Seedance 2.5：videoModes 声明后前台点亮「模式选择器」
    id: 'model-volcano-seedance-25',
    model_id: 'doubao-seedance-2-5',
    display_name: 'Seedance 2.5',
    type: 'video',
    provider_id: 'prov-volcano',
    enabled: false,
    supported_resolutions: [],
    capabilities: { imageInput: true },
    endpoint: {},
    param_template: {
      videoResolutionsEnabled: true,
      videoResolutions: ['480p', '720p'],
      videoModes: ['t2v', 'i2v_first', 'i2v_first_last', 'reference_image'],
      durations: [4, 6, 8, 10],
      allowCount: false,
      supportsReference: true,
      rules: [
        { label: '时长智能', description: 'Seedance 2.5 duration 默认 -1（智能选时长），也可指定 4–30s；前台档位 4/6/8/10s。' },
        { label: '参考图上限', description: '多模态参考生视频支持 1–30 张图，前台默认至多 4 张。' },
      ],
    },
  },
];

async function seedDefaults(pool) {
  if (!pool) return;
  try {
    for (const p of DEFAULT_PROVIDERS) {
      await pool.query(
        `INSERT INTO providers (id, name, type, base_url, api_key, supported_types, enabled, protocol, remark, default_endpoint, capacity_model, cooldown_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO NOTHING`,
        [
          p.id, p.name, p.type, p.base_url, p.api_key, p.supported_types,
          p.enabled, p.protocol, p.remark, JSON.stringify(p.default_endpoint),
          p.capacity_model, p.cooldown_ms,
        ]
      );
    }
    for (const m of DEFAULT_MODELS) {
      await pool.query(
        `INSERT INTO models (id, model_id, display_name, type, provider_id, enabled, supported_resolutions, capabilities, endpoint, param_template)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO NOTHING`,
        [
          m.id, m.model_id, m.display_name, m.type, m.provider_id, m.enabled,
          m.supported_resolutions, JSON.stringify(m.capabilities), JSON.stringify(m.endpoint),
          JSON.stringify(m.param_template || {}),
        ]
      );
    }
    console.log('[SEED] 默认占位服务商/模型已就绪（如已存在则跳过）');
  } catch (e) {
    console.warn('[SEED] 写入默认数据失败（非致命）：', e.message);
  }
}

module.exports = { seedDefaults, DEFAULT_PROVIDERS, DEFAULT_MODELS };

// 独立运行入口：node server/seed-defaults.cjs
if (require.main === module) {
  const { pool, initDB } = require('./db.cjs');
  (async () => {
    try {
      await initDB();
      await seedDefaults(pool);
      console.log('[SEED] 完成');
    } catch (e) {
      console.error('[SEED] 失败:', e.message);
      process.exitCode = 1;
    } finally {
      await pool.end();
    }
  })();
}
