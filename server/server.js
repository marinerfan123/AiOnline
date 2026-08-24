// 纯 Node.js 后端 API — PostgreSQL 17 + Redis 7.2
// 用法: node server.js
import 'dotenv/config'; // Phase 0: 配置外置化（必须在读取 process.env 前加载）
import http from 'http';
import express from 'express'; // 框架化：HTTP 服务 + 中间件 + 路由由 Express 承载
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import cluster from 'node:cluster';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const NODE_ID = process.env.NODE_ID || `${os.hostname()}-${process.pid}`;
const DATA_DIR = path.join(__dirname, 'data');
const TOKEN_FILE = path.join(DATA_DIR, '.api_token');
const CLIENT_DIR = path.join(__dirname, '..', 'dist', 'build2');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Token ──────────────────────────────────────
// ─── 安全相关开关 ──────────────────────────────
const isProduction = process.env.NODE_ENV === 'production';
const tokenFromEnv = !!process.env.API_TOKEN;

let API_TOKEN = '';
// Multi-node/production: API_TOKEN MUST come from env (shared secret across all nodes).
// Local file fallback only for single-node dev.
if (process.env.API_TOKEN) {
  API_TOKEN = process.env.API_TOKEN;
} else {
  // Dev-only: try local file, then auto-generate
  try { API_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf-8').trim(); } catch {}
  if (!API_TOKEN) {
    API_TOKEN = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(TOKEN_FILE, API_TOKEN);
    if (!isProduction) console.log(`\n🔑 API Token: ${API_TOKEN}\n`);
  }
}
// 生产环境若未显式通过环境变量提供 API_TOKEN，则自动生成的 dev 令牌不可作为 system 身份（防后门）
const devTokenEnabled = !isProduction || tokenFromEnv;

// ─── 数据库：PostgreSQL ─────────────────────────
import pgLib from 'pg';
const { Pool } = pgLib;
let pgPool = null;
import dispatcher from './dispatcher.cjs';
import generationV2Shadow from './modules/generation-v2/shadow.cjs';
// ModelHub V3 Phase 1 — 唯一模型身份 resolver（server.js 仅在此一处调用，不再散落处理 display_name）
import modelHubResolver from './modules/modelhub/resolver.cjs';
import modelHubBindings from './modules/modelhub/bindings.cjs';
import revisionHelper from './modules/modelhub/revision.cjs'; // Phase 3 乐观锁 UPDATE 助手
const { optimisticUpdate } = revisionHelper;
import realtime from './realtime.cjs'; // 生成任务实时通道（SSE）：终态切换推前端，替代固定轮询
import session from './auth.cjs';   // Phase A 用户会话（cookie JWT，零依赖）
import billing from './billing.cjs'; // Phase A 积分计费
import accounting from './accounting.cjs'; // Phase M6+ 全局双边账务（后台量 vs 客户量）
import redisStore from './redis.cjs';       // Phase 0 优雅 Redis 层（自动内存兜底）
import rateLimitMod from './ratelimit.cjs'; // Phase 0 固定窗口限流
import cpuMonitor from './cpuMonitor.cjs'; // CPU 自适应负载降级（dispatcher 入口检查 + healthz 暴露）
const { initRedis, isRedisUp } = redisStore;
const { clientIp, rateLimit } = rateLimitMod;
import adminMod from './admin.cjs'; // Phase 2 运营总控台(M3) + 全局智能体层(M4) 后台接口
import shopMod from './shop.cjs';   // Phase 5 电商模块（AI 市集）：商品/购物车/订单
import paymentsMod from './payments.cjs'; // 充值订单 + 真实支付通道适配器(M2 账务)；绝无 DEV 模拟入账
import { createOrderExpiryWorker } from './payments/order-expiry.cjs'; // 订单超时调度器(Node 内存 worker)
import monitorMod from './monitor.cjs'; // 后台「实时监控 · API 活动流」(全路径环形缓冲 + SSE 广播)
import ossLoggerMod from './oss-logger.cjs'; // OssConfigPanel 专用实时日志（仅 /api/oss/*，含脱敏）
import ossMod from './oss.cjs';             // OSS 签名/loadOssConfigs/diagnoseOssError/logger 统一模块（被 server.js + dispatcher.cjs/assetFinalize.cjs 共用；Phase 1 主流化抽出）
import logbusMod from './logbus.cjs';   // 后台「实时日志 · 数据库/Redis/控制台」(统一日志总线 + SSE 广播)
import syslogMod from './syslog.cjs';    // 核心错误持久化 + 进程级异常兜底(system_error_logs)
import financeMod from './finance.cjs';  // Phase 4 后台账务系统（底层：总览/对账/账本/套餐）
import meMod from './me.cjs';            // 用户侧账务（积分流水 / 充值订单 / 概览）
import referenceStylesMod from './reference-styles.cjs'; // 参考样式库：用户投稿 + AI 预审 + 人工终审
import referenceStyleAudit from './reference-style-audit.cjs'; // 参考样式 AI 预审
import agentResolver from './agent-model-resolver.cjs';         // 智能体文本模型统一解析（全局兜底模型）
import seedDefaultsMod from './seed-defaults.cjs'; // 首次部署兜底种子（占位服务商 + 常用模型）

// 初始化向导限流（同一进程内 ≤20 次/10min；真正防护靠"建好即锁定"）
const setupAttempts = new Map();

// ─── 日志总线：先 installConsoleHook，再做后续 init，
//    这样后续 console.warn/error 自动落入 logbus（同时保留原 console 行为）───
const logbus = logbusMod.createLogBus({
  // 所有 ERROR（console.error 自动捕获 + 业务显式 emit）统一落库 system_error_logs
  persistError: (level, source, message, meta) =>
    syslogMod.insertError(source, source, message, meta, null),
});
logbus.installConsoleHook();
logbus.startStatsTimer();
// 把日志总线注入 dispatcher：生成失败/异常现在会落到后台「核心错误日志 + 实时监控」大屏
dispatcher.setLogSink(logbus);

async function initDB() {
  // ── 「数据必须入正式数据库」铁律（2026-08-08 拍板，实时约束）──
  // PostgreSQL 是唯一正式数据源。连接失败 → 重试若干次 → 仍失败则 **硬性退出进程**，
  // 绝不允许静默降级到本地 JSON 文件（server/data/*.json）兜底，避免数据分裂/丢失。
  const PG_MAX_RETRY = 5, PG_RETRY_DELAY_MS = 2000;
  for (let attempt = 1; attempt <= PG_MAX_RETRY; attempt++) {
    try {
      // PG SSL/TLS support for managed/external PostgreSQL (commercial deployment)
      const pgSslMode = process.env.PG_SSLMODE || 'prefer';
      const pgSsl = (pgSslMode === 'require' || pgSslMode === 'verify-ca' || pgSslMode === 'verify-full')
        ? { rejectUnauthorized: pgSslMode === 'verify-full' }
        : undefined;
      pgPool = new Pool({
        host: process.env.PG_HOST || 'localhost',
        port: parseInt(process.env.PG_PORT || '5432', 10),
        database: process.env.PG_DATABASE || 'huabu',
        user: process.env.PG_USER || 'postgres',
        password: process.env.PG_PASSWORD || '0.0.1abcd',
        max: parseInt(process.env.PG_POOL_MAX || '10', 10),
        connectionTimeoutMillis: parseInt(process.env.PG_CONN_TIMEOUT_MS || '5000', 10),
        idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10),
        ...(pgSsl ? { ssl: pgSsl } : {}),
      });
      await pgPool.query('SELECT 1');
      console.log(`[DB] PostgreSQL 连接成功（第 ${attempt} 次尝试）`);
      break;
    } catch (e) {
      if (pgPool) { try { await pgPool.end(); } catch {} pgPool = null; }
      if (attempt < PG_MAX_RETRY) {
        console.warn(`[DB] PostgreSQL 连接失败（第 ${attempt}/${PG_MAX_RETRY} 次），${PG_RETRY_DELAY_MS}ms 后重试：`, e.message);
        await new Promise(r => setTimeout(r, PG_RETRY_DELAY_MS));
      } else {
        console.error('[DB] ❌ PostgreSQL 连接失败且已达最大重试次数。依据「数据必须入正式数据库」铁律，拒绝以本地 JSON 文件兜底启动 —— 进程退出。最后错误：', e.message);
        process.exit(1);
      }
    }
  }
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT 'official', base_url TEXT DEFAULT '', api_key TEXT DEFAULT '', supported_types TEXT[] DEFAULT '{}', enabled BOOLEAN DEFAULT TRUE, protocol TEXT DEFAULT 'openai-compatible', remark TEXT DEFAULT '', default_endpoint JSONB DEFAULT '{}', capacity_model TEXT DEFAULT 'limited', bucket_max INT, cooldown_ms INT DEFAULT 60000, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, model_id TEXT NOT NULL, display_name TEXT NOT NULL, mapping_name TEXT DEFAULT '', type TEXT DEFAULT 'image', provider_id TEXT REFERENCES providers(id) ON DELETE CASCADE, enabled BOOLEAN DEFAULT TRUE, supported_resolutions TEXT[] DEFAULT '{}', capabilities JSONB DEFAULT '{}', endpoint JSONB DEFAULT '{}', param_template JSONB DEFAULT '{}'::jsonb, credit_cost NUMERIC(18,4) DEFAULT 0, supports_reward_balance BOOLEAN NOT NULL DEFAULT TRUE, reward_credits_required NUMERIC(18,4) NOT NULL DEFAULT 0, max_concurrent INT, created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, title TEXT DEFAULT '', type TEXT DEFAULT 'image', thumbnail TEXT DEFAULT '', full_url TEXT DEFAULT '', prompt TEXT DEFAULT '', model TEXT DEFAULT '', ratio TEXT DEFAULT '1:1', source TEXT DEFAULT 'user', is_favorite BOOLEAN DEFAULT FALSE, is_deleted BOOLEAN DEFAULT FALSE, oss_url TEXT DEFAULT '', oss_object_key TEXT DEFAULT '', oss_uploaded BOOLEAN DEFAULT FALSE, category TEXT DEFAULT 'generated', status TEXT DEFAULT 'success', error_message TEXT DEFAULT '', failed_at TIMESTAMPTZ, file_size BIGINT, task_id TEXT DEFAULT '', provider_url TEXT DEFAULT '', created_at TIMESTAMPTZ DEFAULT NOW());
      -- 兼容旧库：缺失列自动补齐
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='media' AND column_name='status') THEN ALTER TABLE media ADD COLUMN status TEXT DEFAULT 'success'; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='media' AND column_name='error_message') THEN ALTER TABLE media ADD COLUMN error_message TEXT DEFAULT ''; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='media' AND column_name='failed_at') THEN ALTER TABLE media ADD COLUMN failed_at TIMESTAMPTZ; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='media' AND column_name='file_size') THEN ALTER TABLE media ADD COLUMN file_size BIGINT; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='media' AND column_name='character_id') THEN ALTER TABLE media ADD COLUMN character_id TEXT DEFAULT NULL; END IF;
        -- ── Phase 1 主流化：服务端最终化 + reaper 兜底，新字段 task_id（关联 generation_tasks.task_id）、provider_url（重传兜底）──
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='media' AND column_name='task_id') THEN ALTER TABLE media ADD COLUMN task_id TEXT DEFAULT ''; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='media' AND column_name='provider_url') THEN ALTER TABLE media ADD COLUMN provider_url TEXT DEFAULT ''; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='mapping_name') THEN ALTER TABLE models ADD COLUMN mapping_name TEXT DEFAULT ''; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='credit_cost') THEN ALTER TABLE models ADD COLUMN credit_cost NUMERIC(18,4) DEFAULT 0; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='estimated_seconds') THEN ALTER TABLE models ADD COLUMN estimated_seconds INT; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='category') THEN ALTER TABLE models ADD COLUMN category TEXT DEFAULT ''; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='creator') THEN ALTER TABLE models ADD COLUMN creator JSONB DEFAULT '{}'::jsonb; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='commercial_use') THEN ALTER TABLE models ADD COLUMN commercial_use BOOLEAN; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='max_concurrent') THEN ALTER TABLE models ADD COLUMN max_concurrent INT; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='supports_reward_balance') THEN ALTER TABLE models ADD COLUMN supports_reward_balance BOOLEAN NOT NULL DEFAULT TRUE; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='reward_credits_required') THEN ALTER TABLE models ADD COLUMN reward_credits_required NUMERIC(18,4) NOT NULL DEFAULT 0; END IF;
        -- ── 手动权重排序：sort_order 越小越靠前；同值按 created_at 升序兜底 ──
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='sort_order') THEN ALTER TABLE models ADD COLUMN sort_order INT NOT NULL DEFAULT 0; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='param_template') THEN ALTER TABLE models ADD COLUMN param_template JSONB DEFAULT '{}'::jsonb; END IF;
        -- 价格/积分字段从 INT 扩为 NUMERIC(18,4)，支持小数；幂等，旧整数数据无损
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='credit_cost' AND data_type='integer') THEN ALTER TABLE models ALTER COLUMN credit_cost TYPE NUMERIC(18,4); END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='reward_credits_required' AND data_type='integer') THEN ALTER TABLE models ALTER COLUMN reward_credits_required TYPE NUMERIC(18,4); END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='model_price_history' AND column_name='credit_cost' AND data_type='integer') THEN ALTER TABLE model_price_history ALTER COLUMN credit_cost TYPE NUMERIC(18,4); END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='model_pricing' AND column_name='credit_price' AND data_type='integer') THEN ALTER TABLE model_pricing ALTER COLUMN credit_price TYPE NUMERIC(18,4); END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='model_pricing' AND column_name='reward_price' AND data_type='integer') THEN ALTER TABLE model_pricing ALTER COLUMN reward_price TYPE NUMERIC(18,4); END IF;
        -- ── ModelHub V3 Phase 3 乐观锁 + 审计列（revision / updated_at / updated_by）──
        -- 旧库无这些列：ADD COLUMN ... DEFAULT 在 PG11+ 对旧行瞬时回填（无全表重写），旧库安全。
        -- 新库：CREATE TABLE 未含这些列，靠下面的 ALTER 补齐（与 house style 一致：新增列走兼容块）。
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='providers' AND column_name='revision') THEN ALTER TABLE providers ADD COLUMN revision INT NOT NULL DEFAULT 1; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='providers' AND column_name='updated_at') THEN ALTER TABLE providers ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW(); END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='providers' AND column_name='updated_by') THEN ALTER TABLE providers ADD COLUMN updated_by TEXT DEFAULT ''; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='revision') THEN ALTER TABLE models ADD COLUMN revision INT NOT NULL DEFAULT 1; END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='updated_at') THEN ALTER TABLE models ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW(); END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='updated_by') THEN ALTER TABLE models ADD COLUMN updated_by TEXT DEFAULT ''; END IF;
      END $$;
      -- ── ModelHub V3 Phase 2：逻辑模型 × 服务商 线路绑定 ──
      -- models 收敛为「逻辑模型」（id/model_id/display_name/type/...），
      -- provider_model_bindings 表示「某服务商提供某逻辑模型的具体线路」（含上游真实模型名 upstream_model_name）。
      -- 旧 models.provider_id 等字段保留不删（双读兼容 + 回滚安全）。model_id 在 models 中非唯一，故不加 FK。
      CREATE TABLE IF NOT EXISTS provider_model_bindings (
        id                  TEXT PRIMARY KEY DEFAULT 'pmb-' || gen_random_uuid()::text,
        model_id            TEXT NOT NULL,
        provider_id         TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        upstream_model_name TEXT NOT NULL DEFAULT '',   -- 上游真实模型名（wire name）；迁移默认取 model_id（=现状）
        enabled             BOOLEAN NOT NULL DEFAULT TRUE,
        priority            INT NOT NULL DEFAULT 0,      -- 路由优先级（Phase 3 用），越大越优先
        weight              INT NOT NULL DEFAULT 0,       -- 路由权重（Phase 3 用）
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (model_id, provider_id)
      );
      CREATE INDEX IF NOT EXISTS ix_pmb_model ON provider_model_bindings(model_id);
      CREATE INDEX IF NOT EXISTS ix_pmb_provider ON provider_model_bindings(provider_id);
      -- 前向兼容：已存在表但缺列时补齐（幂等；支持老库 ALTER 升级）
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_model_bindings' AND column_name='upstream_model_name') THEN
          ALTER TABLE provider_model_bindings ADD COLUMN upstream_model_name TEXT NOT NULL DEFAULT '';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_model_bindings' AND column_name='priority') THEN
          ALTER TABLE provider_model_bindings ADD COLUMN priority INT NOT NULL DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_model_bindings' AND column_name='weight') THEN
          ALTER TABLE provider_model_bindings ADD COLUMN weight INT NOT NULL DEFAULT 0;
        END IF;
      END $$;
      CREATE TABLE IF NOT EXISTS oss_config (id INTEGER PRIMARY KEY DEFAULT 1, provider TEXT DEFAULT 'aliyun-oss', access_point_name TEXT DEFAULT '', endpoint_external TEXT DEFAULT '', endpoint_internal TEXT DEFAULT '', bucket TEXT DEFAULT '', region TEXT DEFAULT '', region_label TEXT DEFAULT '', access_key_id TEXT DEFAULT '', access_key_secret TEXT DEFAULT '', path_prefix TEXT DEFAULT 'images/', custom_domain TEXT DEFAULT '', enabled BOOLEAN DEFAULT TRUE);
      -- ── 多槽位对象存储（两套 OSS 支持 + 单 active） ──
      CREATE TABLE IF NOT EXISTS oss_configs (
        id TEXT PRIMARY KEY,                 -- 槽位 ID（UUID），引用此 id 做各项操作
        provider_type TEXT NOT NULL DEFAULT 'aliyun-oss',  -- 'aliyun-oss' | 'tencent-cos'
        display_name TEXT DEFAULT '',        -- 用户起的别名，方便辨识（"上海-工作"、"广州-备份" 等）
        bucket TEXT DEFAULT '',
        region TEXT DEFAULT '',
        region_label TEXT DEFAULT '',
        app_id TEXT DEFAULT '',              -- 仅腾讯云需要（bucket-{appid}.cos.{region}.myqcloud.com 形式）
        access_key_id TEXT DEFAULT '',
        access_key_secret TEXT DEFAULT '',
        endpoint_external TEXT DEFAULT '',
        path_prefix TEXT DEFAULT 'images/',
        custom_domain TEXT DEFAULT '',
        enabled BOOLEAN DEFAULT TRUE,         -- 单槽位停用（不影响其它槽位）
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE oss_config ADD COLUMN IF NOT EXISTS active_id TEXT DEFAULT '';
      -- 单次迁移：把旧 oss_config(id=1) 中已填写的字段升格为 oss_configs 中的一条（若尚未迁移过）
      DO $$
      DECLARE v_active TEXT;
      BEGIN
        SELECT active_id INTO v_active FROM oss_config WHERE id=1;
        IF (SELECT count(*) FROM oss_configs) = 0 THEN
          INSERT INTO oss_configs (id, provider_type, display_name, bucket, region, region_label, access_key_id, access_key_secret, endpoint_external, path_prefix, custom_domain, enabled)
          SELECT 'oss-legacy', COALESCE((SELECT provider FROM oss_config WHERE id=1), 'aliyun-oss'),
                 '默认（从旧配置迁移）',
                 bucket, region, region_label, access_key_id, access_key_secret, endpoint_external, path_prefix, custom_domain, TRUE
          FROM oss_config WHERE id=1;
          UPDATE oss_config SET active_id='oss-legacy' WHERE id=1;
        END IF;
      END $$;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT NOW());
      ALTER TABLE providers ADD COLUMN IF NOT EXISTS max_concurrent INT DEFAULT 2;
      ALTER TABLE providers ADD COLUMN IF NOT EXISTS rate_limits JSONB DEFAULT '{}'::jsonb;
      ALTER TABLE providers ADD COLUMN IF NOT EXISTS capacity_model TEXT DEFAULT 'limited';
      ALTER TABLE providers ADD COLUMN IF NOT EXISTS bucket_max INT;
      ALTER TABLE providers ADD COLUMN IF NOT EXISTS cooldown_ms INT DEFAULT 60000;
      -- 生成任务表（用于刷新恢复：前端点生成即插一行，后台跑完后更新结果，前端刷新后能查到状态）
      CREATE TABLE IF NOT EXISTS generation_tasks (
        task_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'running',  -- running | done | failed
        model TEXT DEFAULT '',
        prompt TEXT DEFAULT '',
        count INT DEFAULT 1,
        content_type TEXT DEFAULT 'image',
        result JSONB,                            -- 生成完成后的完整结果（images/usedProviders/errors）
        error TEXT DEFAULT '',
        pending_ids TEXT[] DEFAULT '{}',         -- 对应的前端占位 item id 列表
        client_meta JSONB DEFAULT '{}',           -- 前端可写入任意键值（ratio/model/prompt 等用于恢复渲染）
        created_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS generation_tasks_status_idx ON generation_tasks (status);
      CREATE INDEX IF NOT EXISTS generation_tasks_created_at_idx ON generation_tasks (created_at);

      -- === 智能路由尝试数据（ModelHub V3）：generation_jobs / generation_attempts ===
      -- 与 generation_tasks 共存（task_id 外键 1:1），记录每次智能路由的「向各 provider 实际尝试」全量数据。
      -- job_id = task_id__subIndex（每个子任务一个 job），attempt_no 在单 job 内串行自增。
      CREATE TABLE IF NOT EXISTS generation_jobs (
        job_id        TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL REFERENCES generation_tasks(task_id) ON DELETE CASCADE,
        model_id      TEXT,
        provider_id   TEXT,
        binding_id    TEXT,
        status        TEXT NOT NULL DEFAULT 'running',   -- running | success | failed | timeout | throttled | canceled
        cost          INT DEFAULT 0,
        attempt_count INT NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        finished_at   TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS generation_jobs_task_id_idx ON generation_jobs (task_id);
      CREATE INDEX IF NOT EXISTS generation_jobs_status_idx ON generation_jobs (status);
      CREATE INDEX IF NOT EXISTS generation_jobs_created_at_idx ON generation_jobs (created_at);

      CREATE TABLE IF NOT EXISTS generation_attempts (
        attempt_id          BIGSERIAL PRIMARY KEY,
        job_id              TEXT NOT NULL REFERENCES generation_jobs(job_id) ON DELETE CASCADE,
        task_id             TEXT NOT NULL,
        attempt_no          INT NOT NULL,
        model_id            TEXT,
        binding_id          TEXT,
        provider_id         TEXT,
        started_at          TIMESTAMPTZ,
        finished_at         TIMESTAMPTZ,
        latency_ms          INT,
        status              TEXT NOT NULL,               -- success | timeout | failed | rate_limited | error
        http_status         INT,
        provider_error_code TEXT,
        cost                INT DEFAULT 0,
        retry_reason        TEXT,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (job_id, attempt_no)
      );
      CREATE INDEX IF NOT EXISTS generation_attempts_job_id_idx ON generation_attempts (job_id);
      CREATE INDEX IF NOT EXISTS generation_attempts_task_id_idx ON generation_attempts (task_id);
      CREATE INDEX IF NOT EXISTS generation_attempts_created_at_idx ON generation_attempts (created_at);

      INSERT INTO oss_config (id, enabled) VALUES (1, TRUE) ON CONFLICT (id) DO NOTHING;
      INSERT INTO settings (key, value) VALUES ('app', '{}') ON CONFLICT (key) DO NOTHING;

      -- === Phase A: 认证 + 积分计费地基 ===
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY DEFAULT 'u-' || gen_random_uuid()::text,
        email         TEXT UNIQUE NOT NULL,
        display_name  TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        reward_credits   NUMERIC(18,4) NOT NULL DEFAULT 0,
        recharge_credits NUMERIC(18,4) NOT NULL DEFAULT 0,
        credits          NUMERIC(18,4) GENERATED ALWAYS AS (reward_credits + recharge_credits) STORED,
        role          TEXT NOT NULL DEFAULT 'user',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- 用户套餐等级（供会员调度与前端展示；缺省 free）
      ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
      -- 用户状态（active / suspended），管理后台启停用依赖此列
      ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
      CREATE TABLE IF NOT EXISTS credit_transactions (
        id            BIGSERIAL PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind          TEXT NOT NULL,
        amount        NUMERIC(18,4) NOT NULL,
        ref           TEXT,
        balance_after NUMERIC(18,4),
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ix_ct_user ON credit_transactions(user_id);
      CREATE INDEX IF NOT EXISTS ix_ct_ref  ON credit_transactions(ref);
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token_hash  TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        revoked     BOOLEAN NOT NULL DEFAULT FALSE,
        expires_at  TIMESTAMPTZ NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id          BIGSERIAL PRIMARY KEY,
        aggregate   TEXT NOT NULL,
        event_type  TEXT NOT NULL,
        payload     JSONB NOT NULL,
        published   BOOLEAN NOT NULL DEFAULT FALSE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ix_outbox_unpub ON outbox(published) WHERE published = FALSE;
      ALTER TABLE media ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS ix_media_user ON media(user_id);
      ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS user_id         TEXT REFERENCES users(id);
      ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
      ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS cost            NUMERIC(18,4) DEFAULT 0;
      ALTER TABLE generation_tasks ALTER COLUMN cost TYPE NUMERIC(18,4);
      ALTER TABLE credit_transactions ALTER COLUMN amount TYPE NUMERIC(18,4);
      ALTER TABLE credit_transactions ALTER COLUMN balance_after TYPE NUMERIC(18,4);
      -- 计费池标识（reward/recharge），billing.cjs reserve/commit/release 与注册送积分均写入
      ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS pool TEXT DEFAULT 'recharge';
      CREATE INDEX IF NOT EXISTS ix_gt_user ON generation_tasks(user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_gt_idem
        ON generation_tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;
      -- 崩溃恢复续轮询地基：持久化 provider 任务标识，重启后按 taskId 续轮询（拿回崩溃前在途的视频结果）
      ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS provider_id      TEXT;
      ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS model_id        TEXT;
      ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS provider_key     TEXT;
      ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS provider_task_id TEXT;
      ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS resume_meta     JSONB DEFAULT '{}'::jsonb;
      CREATE INDEX IF NOT EXISTS ix_gt_provider_task
        ON generation_tasks(provider_task_id) WHERE provider_task_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS ix_gt_running_provider
        ON generation_tasks(status, provider_task_id) WHERE status='running' AND provider_task_id IS NOT NULL;
      -- 计费池标识（reward/recharge），dispatcher.cjs 在途/孤儿/等待区扫描与 finalize 均读取
      ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS cost_pool TEXT DEFAULT 'recharge';
    `);

    // === 模型级参数模板回填（后台可自定义；空模板按 type 派生默认）===
    await backfillModelParamTemplates();

    // === Phase 1 回填：generation_tasks.model_id 历史空值（display_name → model_id 兜底）===
    // 仅当存在 NULL 行时才执行 UPDATE（幂等；常态下 0 行命中，开销可忽略）。
    try {
      const nullCheck = await pgPool.query("SELECT 1 FROM generation_tasks WHERE model_id IS NULL LIMIT 1");
      if (nullCheck.rows && nullCheck.rows.length) {
        await pgPool.query(`
          UPDATE generation_tasks
             SET model_id = COALESCE(
                   (SELECT m.model_id FROM models m WHERE m.display_name = generation_tasks.model LIMIT 1),
                   (SELECT m.model_id FROM models m WHERE m.model_id    = generation_tasks.model LIMIT 1),
                   generation_tasks.model)
           WHERE model_id IS NULL`);
        console.log('[initDB] 已回填 generation_tasks.model_id 历史空值');
      }
    } catch (e) {
      console.warn('[initDB] 回填 generation_tasks.model_id 失败(可忽略，可手动运行迁移脚本):', e.message);
    }

    // === 公共默认资产（default_assets 模板库 + media 归属标记）===
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS default_assets (
        id TEXT PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        title TEXT DEFAULT '',
        type TEXT DEFAULT 'image',
        thumbnail TEXT DEFAULT '',
        full_url TEXT DEFAULT '',
        prompt TEXT DEFAULT '',
        model TEXT DEFAULT '',
        ratio TEXT DEFAULT '1:1',
        source TEXT DEFAULT 'default',
        category TEXT DEFAULT 'generated',
        status TEXT DEFAULT 'success',
        sort INT DEFAULT 0,
        tags JSONB DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE default_assets ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb;
      ALTER TABLE media ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT FALSE;
      ALTER TABLE media ADD COLUMN IF NOT EXISTS default_key TEXT;
      ALTER TABLE media ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb;
      CREATE INDEX IF NOT EXISTS ix_media_default ON media(user_id, default_key) WHERE default_key IS NOT NULL;

      -- === Phase C：参考样式库（用户投稿 + AI 预审 + 人工终审）===
      CREATE TABLE IF NOT EXISTS reference_styles (
        id            TEXT PRIMARY KEY DEFAULT 'rs-' || gen_random_uuid()::text,
        user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
        name          TEXT NOT NULL DEFAULT '',
        description   TEXT DEFAULT '',
        preview_url   TEXT NOT NULL DEFAULT '',
        full_url      TEXT DEFAULT '',
        prompt        TEXT DEFAULT '',
        negative_prompt TEXT DEFAULT '',
        model_id      TEXT DEFAULT '',
        ratio         TEXT DEFAULT '1:1',
        tags          JSONB DEFAULT '[]'::jsonb,
        status        TEXT NOT NULL DEFAULT 'pending', -- pending | ai_passed | ai_flagged | approved | rejected
        ai_reason     TEXT DEFAULT '',
        reject_reason TEXT DEFAULT '',
        source_media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
        reviewed_by   TEXT DEFAULT '',
        reviewed_at   TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_promoted   BOOLEAN DEFAULT FALSE,          -- 是否强制推行（额外出现在客户工作台示例墙）
        commission_rate INT DEFAULT 0                  -- 设计者分成比例（%）：客户付费时返给设计者的百分比
      );
      CREATE INDEX IF NOT EXISTS ix_reference_styles_status ON reference_styles(status);
      CREATE INDEX IF NOT EXISTS ix_reference_styles_user ON reference_styles(user_id);
      CREATE INDEX IF NOT EXISTS ix_reference_styles_tags ON reference_styles USING GIN(tags);
      CREATE INDEX IF NOT EXISTS ix_reference_styles_created ON reference_styles(created_at DESC);
      -- 已存在的库补列（IF NOT EXISTS 幂等）
      ALTER TABLE reference_styles ADD COLUMN IF NOT EXISTS is_promoted BOOLEAN DEFAULT FALSE;
      ALTER TABLE reference_styles ADD COLUMN IF NOT EXISTS commission_rate INT DEFAULT 0;
      -- 媒体表归属参考样式（用于生成时给设计者分成 + 客户端展示来源）
      ALTER TABLE media ADD COLUMN IF NOT EXISTS reference_style_id TEXT REFERENCES reference_styles(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS ix_media_style ON media(reference_style_id) WHERE reference_style_id IS NOT NULL;
      -- Phase 1 主流化：按 generation_task 找媒体（reaper 重传/前端恢复都用得上）
      CREATE INDEX IF NOT EXISTS ix_media_task ON media(task_id) WHERE task_id <> '';
      -- 设计者分成记账表
      CREATE TABLE IF NOT EXISTS style_earnings (
        id                 TEXT PRIMARY KEY DEFAULT 'se-' || gen_random_uuid()::text,
        reference_style_id TEXT REFERENCES reference_styles(id) ON DELETE SET NULL,
        designer_id        TEXT,
        customer_id        TEXT,
        media_id           TEXT,
        charge_credits     INT DEFAULT 0,   -- 该次生成客户实际支付的积分（基准）
        commission_credits INT DEFAULT 0,   -- 实际返给设计者的积分
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ix_style_earnings_style ON style_earnings(reference_style_id);
      CREATE INDEX IF NOT EXISTS ix_style_earnings_designer ON style_earnings(designer_id);
    `);

    console.log('[DB] PostgreSQL 连接成功');

    // === Phase 2：运营总控台(M3) + 全局智能体层(M4) 地基 ===
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS request_logs (
        id BIGSERIAL PRIMARY KEY,
        method TEXT, path TEXT, ip TEXT, status INT, latency_ms INT,
        user_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGSERIAL PRIMARY KEY,
        actor_id TEXT, action TEXT, target TEXT, detail JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ix_audit_created ON audit_logs(created_at DESC);
      CREATE TABLE IF NOT EXISTS agents (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled BOOLEAN DEFAULT TRUE,
        daily_budget INT DEFAULT 0,
        config JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      -- Phase M4/M6：智能体可绑定 skill（agent_type=skill 时引用 skill_registry.key）
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_type TEXT DEFAULT 'model';
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS skill_key TEXT DEFAULT '';
      CREATE INDEX IF NOT EXISTS ix_agents_type ON agents(agent_type);
      CREATE TABLE IF NOT EXISTS agent_providers (
        id TEXT PRIMARY KEY,
        agent_key TEXT NOT NULL REFERENCES agents(key) ON DELETE CASCADE,
        provider TEXT DEFAULT '', model TEXT DEFAULT '',
        weight INT DEFAULT 1, priority INT DEFAULT 10, cost_per_call INT DEFAULT 0,
        enabled BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS agent_rules (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger TEXT DEFAULT '',
        condition JSONB DEFAULT '{}', action JSONB DEFAULT '{}',
        enabled BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS agent_calls (
        id BIGSERIAL PRIMARY KEY, agent_key TEXT, user_id TEXT, provider TEXT DEFAULT '',
        ok BOOLEAN DEFAULT TRUE, latency_ms INT DEFAULT 0, cost_credits INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ix_ac_created ON agent_calls(created_at DESC);
      CREATE TABLE IF NOT EXISTS agent_rule_logs (
        id BIGSERIAL PRIMARY KEY, rule_id TEXT, fired_at TIMESTAMPTZ DEFAULT NOW(),
        result JSONB DEFAULT '{}'
      );
      -- === Phase 2 收尾：充值订单（M2 账务 / DEV 支付适配器）===
      CREATE TABLE IF NOT EXISTS recharge_orders (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel       TEXT NOT NULL DEFAULT 'wechat',   -- wechat | alipay
        amount        INT NOT NULL,                     -- 充值金额（元）= 入账积分
        status        TEXT NOT NULL DEFAULT 'pending',  -- pending | paid | failed
        pay_order_no  TEXT UNIQUE NOT NULL,
        sign          TEXT DEFAULT '',
        meta          JSONB DEFAULT '{}',               -- 失败原因 / 回调原始数据
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        paid_at       TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS ix_ro_user ON recharge_orders(user_id);
      CREATE INDEX IF NOT EXISTS ix_ro_payno ON recharge_orders(pay_order_no);
      -- 兼容已在运行的库：对已有 recharge_orders 补齐 meta 列
      ALTER TABLE recharge_orders ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}';

      -- === Phase 4：充值套餐（后台可配置，替换前端硬编码预设）===
      CREATE TABLE IF NOT EXISTS topup_packages (
        id          TEXT PRIMARY KEY DEFAULT 'pkg-' || gen_random_uuid()::text,
        name        TEXT NOT NULL DEFAULT '',
        credits     INT  NOT NULL DEFAULT 0,    -- 基础到账积分
        price       INT  NOT NULL DEFAULT 0,    -- 售价（元）
        bonus       INT  NOT NULL DEFAULT 0,    -- 赠送积分
        sort_order  INT  NOT NULL DEFAULT 0,
        enabled     BOOLEAN NOT NULL DEFAULT TRUE,
        remark      TEXT DEFAULT '',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ix_tp_sort ON topup_packages(sort_order);

      -- === 支付 P0：安全优先 + 本机财务对接（#246）===
      -- 全局支付参数（单行 id=1；CHECK 约束保证唯一一行）
      CREATE TABLE IF NOT EXISTS payment_settings (
        id                INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        enabled           BOOLEAN NOT NULL DEFAULT TRUE,
        default_expires_min INT NOT NULL DEFAULT 15,
        min_amount        INT NOT NULL DEFAULT 1000,       -- 最小充值（分）¥10
        max_amount        INT NOT NULL DEFAULT 10000000,   -- 最大充值（分）
        daily_limit       INT NOT NULL DEFAULT 10000000,   -- 单用户日限额（分）
        max_open_orders   INT NOT NULL DEFAULT 5,          -- 单用户最大待支付数
        allow_test        BOOLEAN NOT NULL DEFAULT TRUE,   -- 是否允许 mock/dev 通道
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO payment_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
      -- 支付方式独立开关（默认开启，便于单独关闭微信/支付宝）
      ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS enable_wxpay BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS enable_alipay BOOLEAN NOT NULL DEFAULT TRUE;

      -- 支付服务商（多行；pid/pkey/webhook_secret 加密入库，API 永不返回明文）
      CREATE TABLE IF NOT EXISTS payment_providers (
        id              TEXT PRIMARY KEY DEFAULT 'pp-' || gen_random_uuid()::text,
        name            TEXT NOT NULL DEFAULT '',
        type            TEXT NOT NULL DEFAULT 'easypay',  -- easypay | alipay | wxpay | stripe | mock
        enabled         BOOLEAN NOT NULL DEFAULT TRUE,
        weight          INT NOT NULL DEFAULT 1,           -- 同 type 内负载均衡权重
        sort_order      INT NOT NULL DEFAULT 0,
        api_base        TEXT DEFAULT '',
        pid_enc         TEXT,                              -- 加密：商户号
        pkey_enc        TEXT,                              -- 加密：商户密钥
        webhook_secret_enc TEXT,                          -- 加密：异步通知密钥
        product_name_prefix TEXT DEFAULT '充值',
        allow_refund    BOOLEAN NOT NULL DEFAULT FALSE,
        remark          TEXT DEFAULT '',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ix_pp_enabled ON payment_providers(enabled, sort_order);
      -- 支付服务商升级：支持配置该服务商可用的支付方式（alipay / wxpay / card）
      ALTER TABLE payment_providers ADD COLUMN IF NOT EXISTS supported_methods JSONB DEFAULT '["alipay","wxpay"]'::jsonb;

      -- 充值订单升级：兼容旧 DEV 订单（channel 列保留），新增 provider/渠道流水/超时字段
      ALTER TABLE recharge_orders ADD COLUMN IF NOT EXISTS provider_id      TEXT REFERENCES payment_providers(id) ON DELETE SET NULL;
      ALTER TABLE recharge_orders ADD COLUMN IF NOT EXISTS channel_trade_no TEXT;
      ALTER TABLE recharge_orders ADD COLUMN IF NOT EXISTS channel_method   TEXT;   -- 真实通道方法 alipay/wxpay
      ALTER TABLE recharge_orders ADD COLUMN IF NOT EXISTS channel_raw      JSONB DEFAULT '{}';  -- 回调原始（脱敏后）
      ALTER TABLE recharge_orders ADD COLUMN IF NOT EXISTS expired_at       TIMESTAMPTZ;
      ALTER TABLE recharge_orders ADD COLUMN IF NOT EXISTS fail_reason      TEXT;
      ALTER TABLE recharge_orders ADD COLUMN IF NOT EXISTS package_id       TEXT;
      ALTER TABLE recharge_orders ADD COLUMN IF NOT EXISTS bonus           INT NOT NULL DEFAULT 0;  -- 套餐赠送积分（随本金一并入账到充值余额）
      CREATE INDEX IF NOT EXISTS ix_ro_provider ON recharge_orders(provider_id);
      CREATE INDEX IF NOT EXISTS ix_ro_ctrade  ON recharge_orders(channel_trade_no);
      CREATE INDEX IF NOT EXISTS ix_ro_status  ON recharge_orders(status, created_at DESC);

      -- 角色全局库（characters）：建表 + 兼容补列，使 /api/characters 与前端 ICharacter 形状一致
      CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avatar_url TEXT DEFAULT '',
        gender TEXT DEFAULT '',
        age INTEGER DEFAULT 0,
        tags TEXT[] DEFAULT '{}',
        style JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE characters ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';
      ALTER TABLE characters ADD COLUMN IF NOT EXISTS reference_images TEXT[] DEFAULT '{}';
      ALTER TABLE characters ADD COLUMN IF NOT EXISTS base_model TEXT DEFAULT '';
      ALTER TABLE characters ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'user';

      -- Webhook 幂等表（L2 双保险）：同 (provider_id, channel_trade_no, event_type) 唯一
      CREATE TABLE IF NOT EXISTS webhook_events (
        id              BIGSERIAL PRIMARY KEY,
        provider_id     TEXT,
        channel_trade_no TEXT NOT NULL,
        event_type      TEXT NOT NULL DEFAULT 'paid',
        out_trade_no    TEXT,
        status          TEXT NOT NULL DEFAULT 'new',  -- new | processing | done | failed | dead_letter
        attempts        INT NOT NULL DEFAULT 0,
        last_error      TEXT,
        raw             JSONB DEFAULT '{}',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (provider_id, channel_trade_no, event_type)
      );
      CREATE INDEX IF NOT EXISTS ix_we_pending ON webhook_events(status, updated_at) WHERE status IN ('new','processing','failed');

      -- 支付审计（L6，脱敏，绝不记密钥）
      CREATE TABLE IF NOT EXISTS payment_audit (
        id          BIGSERIAL PRIMARY KEY,
        event_type  TEXT NOT NULL,   -- create | paid | expired | failed | suspicious | verify_fail | refund | settings_change | provider_change
        actor       TEXT DEFAULT '',
        user_id     TEXT,
        order_id    TEXT,
        provider_id TEXT,
        detail      JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ix_pa_created ON payment_audit(created_at DESC);

      -- === Phase M4/M6：技能注册表（能力原子，市集获取即安装到此表）===
      CREATE TABLE IF NOT EXISTS skill_registry (
        key          TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        stage        TEXT DEFAULT 'generation',   -- generation | prompt | post | analysis
        adapter      TEXT NOT NULL,               -- prompt_optimize | text_gen | ...
        params       JSONB DEFAULT '{}',
        cost_credits INT DEFAULT 0,
        enabled      BOOLEAN DEFAULT TRUE,
        description  TEXT DEFAULT '',
        author       TEXT DEFAULT '',
        icon         TEXT DEFAULT '',
        version      TEXT DEFAULT '1.0.0',
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ix_sr_enabled ON skill_registry(enabled);

      -- === Phase M6：AI 市集商品（数字能力包 / 智能体模板）===
      CREATE TABLE IF NOT EXISTS products (
        id            TEXT PRIMARY KEY DEFAULT 'prod-' || gen_random_uuid()::text,
        title         TEXT NOT NULL,
        subtitle      TEXT DEFAULT '',
        cover_url     TEXT DEFAULT '',
        kind          TEXT DEFAULT 'skill_pack',    -- skill_pack | agent_template
        ref_key       TEXT DEFAULT '',              -- skill_registry.key（kind=skill_pack 时）
        price_credits INT DEFAULT 0,                -- 积分价格（0 = 免费）
        price_cents   INT DEFAULT 0,                -- 现金价格（分；0 = 免费）
        status        TEXT DEFAULT 'published',     -- draft | published | archived
        author        TEXT DEFAULT '',
        description   TEXT DEFAULT '',
        tags          TEXT[] DEFAULT '{}',
        installs      INT DEFAULT 0,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ix_prod_status ON products(status, created_at DESC);

      -- 用户已获取技能（市集 acquire = 在此表落一条授权）
      CREATE TABLE IF NOT EXISTS user_skills (
        user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        skill_key    TEXT NOT NULL,
        acquired_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, skill_key)
      );
      CREATE INDEX IF NOT EXISTS ix_us_user ON user_skills(user_id);

      -- === Phase M6+：全局双边账务（后台量 vs 客户量，无例外、精确算量）===
      -- 上游成本价率卡：每个 (provider_id, model_id) 实际向上游付出的成本
      CREATE TABLE IF NOT EXISTS model_cost_rates (
        id                 TEXT PRIMARY KEY DEFAULT 'mcr-' || gen_random_uuid()::text,
        provider_id        TEXT NOT NULL,
        model_id           TEXT NOT NULL,
        model_type         TEXT DEFAULT 'text',          -- text | image | video
        input_cost_per_1k  NUMERIC DEFAULT 0,            -- 上游：每 1k 输入 token 成本（分）
        output_cost_per_1k NUMERIC DEFAULT 0,            -- 上游：每 1k 输出 token 成本（分）
        cost_per_unit      NUMERIC DEFAULT 0,            -- 上游：每生成 1 个资产（图/视频）成本（分）
        currency           TEXT DEFAULT 'CNY',
        source             TEXT DEFAULT 'manual',        -- manual | llm_inferred | default
        updated_at         TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (provider_id, model_id)
      );
      CREATE INDEX IF NOT EXISTS ix_mcr_provider ON model_cost_rates(provider_id);

      -- 统一消费台账（双边）：后台量(backend_cost_cents) vs 客户量(customer_charge_*)，margin = 客户 − 后台
      CREATE TABLE IF NOT EXISTS consumption_ledger (
        id                     BIGSERIAL PRIMARY KEY,
        scope                  TEXT NOT NULL DEFAULT 'user',   -- user | system
        actor_id               TEXT DEFAULT '',                -- user_id 或 'system'
        purpose                TEXT NOT NULL,                  -- generate | skill:* | agent:* | provider_onboarding | ...
        provider_id            TEXT DEFAULT '',
        model_id               TEXT DEFAULT '',
        model_type             TEXT DEFAULT '',
        input_units            INT DEFAULT 0,                  -- 文本：输入 token；图/视频：0
        output_units           INT DEFAULT 0,                  -- 文本：输出 token；图/视频：生成资产数
        backend_cost_cents     NUMERIC DEFAULT 0,              -- 上游实际成本（分）
        customer_charge_credits INT DEFAULT 0,                 -- 向客户收的积分（system 时为 0）
        customer_charge_cents  NUMERIC DEFAULT 0,              -- 客户收费折算（分，按 settings.app.creditToCents）
        margin_cents           NUMERIC DEFAULT 0,              -- = customer_charge_cents - backend_cost_cents（盈亏）
        task_ref               TEXT DEFAULT '',
        idempotency_key        TEXT DEFAULT '',
        status                 TEXT DEFAULT 'ok',              -- ok | error | released
        created_at             TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ix_cl_scope_time ON consumption_ledger(scope, created_at DESC);
      CREATE INDEX IF NOT EXISTS ix_cl_actor ON consumption_ledger(actor_id, created_at DESC);

      -- 模型价格历史快照：每次改价/下架/删除时归档(last credit_cost)，供「再添加时提醒沿用原价格」
      CREATE TABLE IF NOT EXISTS model_price_history (
        id            TEXT PRIMARY KEY DEFAULT 'mph-' || gen_random_uuid()::text,
        model_id      TEXT NOT NULL,
        display_name  TEXT DEFAULT '',
        credit_cost   NUMERIC(18,4) DEFAULT 0,
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ix_mph_model ON model_price_history(model_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS ix_cl_purpose ON consumption_ledger(purpose, created_at DESC);
      CREATE INDEX IF NOT EXISTS ix_cl_idem ON consumption_ledger(idempotency_key) WHERE idempotency_key <> '';

      -- === ModelHub V3 Phase 3：定价层（用户价 vs 每线路成本，双读兼容，零 DELETE）===
      -- 用户侧价：单逻辑模型一行。credit_price=用户积分售价；reward_price=奖励余额售价。
      -- 取代 models.credit_cost / model_price_history 的「用户价」角色（旧表保留不删，作回退）。
      CREATE TABLE IF NOT EXISTS model_pricing (
        model_id     TEXT PRIMARY KEY,                       -- 逻辑模型 id（= models.model_id）
        credit_price NUMERIC(18,4) NOT NULL DEFAULT 0,       -- 用户积分售价（普通余额）
        reward_price NUMERIC(18,4) NOT NULL DEFAULT 0,       -- 奖励余额售价
        currency     TEXT DEFAULT 'CNY',
        updated_at   TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ix_mp_model ON model_pricing(model_id);

      -- 迁移：从 models.credit_cost 初始化 model_pricing（逻辑模型统一价）。
      -- 同一 model_id 多行时取第一个非零值；若全为 0 则写 0。后续价格页保存会覆盖为统一价。
      INSERT INTO model_pricing (model_id, credit_price, reward_price, currency, updated_at)
      SELECT DISTINCT ON (model_id) model_id,
        COALESCE(NULLIF(credit_cost, 0), 0) AS credit_price,
        0 AS reward_price,
        'CNY' AS currency,
        NOW() AS updated_at
      FROM models
      WHERE model_id NOT IN (SELECT model_id FROM model_pricing)
      ORDER BY model_id, credit_cost DESC;

      -- 每线路成本：一条「线路」= 一个 provider_model_bindings.id。
      -- 复合主键 (binding_id, unit)：同一线路可按单位拆多行（如 A 线路 3 行：
      -- per_1k_input_token / per_1k_output_token / per_asset）。这样才能让智能路由逐线路算利润。
      -- provider_id/model_id 冗余存储，满足「线路 A/B/C 各 ¥」的人工查询与回退路径。
      CREATE TABLE IF NOT EXISTS provider_model_costs (
        binding_id   TEXT NOT NULL REFERENCES provider_model_bindings(id) ON DELETE CASCADE,
        provider_id  TEXT NOT NULL,                          -- 冗余，满足 provider/model 字段查询
        model_id     TEXT NOT NULL,                          -- 冗余，回退到 (provider_id, model_id) 路径
        cost         NUMERIC NOT NULL DEFAULT 0,             -- 该单位下成本（分）
        currency     TEXT DEFAULT 'CNY',
        unit         TEXT NOT NULL DEFAULT 'per_1k_input_token',  -- per_1k_input_token|per_1k_output_token|per_asset
        effective_at TIMESTAMPTZ DEFAULT NOW(),              -- 成本生效时间（未来可支持版本化）
        updated_at   TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (binding_id, unit)
      );
      CREATE INDEX IF NOT EXISTS ix_pmc_pm ON provider_model_costs(provider_id, model_id);
      CREATE INDEX IF NOT EXISTS ix_pmc_binding ON provider_model_costs(binding_id);

      -- 消费台账补 binding_id 列：逐线路利润归因（缺列则补，幂等；绝不 DROP 旧列）
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='consumption_ledger' AND column_name='binding_id') THEN
          ALTER TABLE consumption_ledger ADD COLUMN binding_id TEXT DEFAULT '';
        END IF;
      END $$;

      -- Node 内存 worker 游标持久化（超时扫描 / Webhook 重试调度）
      CREATE TABLE IF NOT EXISTS cron_marker (
        name      TEXT PRIMARY KEY,
        last_run  TIMESTAMPTZ,
        cursor    JSONB DEFAULT '{}'
      );
      -- 用户反馈（前端「发送应用反馈」表单落库；user_id 可空以兼容匿名，但本应用强制登录故一般非空）
      CREATE TABLE IF NOT EXISTS feedback (
        id          TEXT PRIMARY KEY,
        user_id     TEXT,
        type        TEXT DEFAULT 'other',
        title       TEXT DEFAULT '',
        content     TEXT DEFAULT '',
        contact     TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      -- 用户举报（前端「举报法律问题」表单落库）
      CREATE TABLE IF NOT EXISTS reports (
        id          TEXT PRIMARY KEY,
        user_id     TEXT,
        type        TEXT DEFAULT 'other',
        target_url  TEXT DEFAULT '',
        content     TEXT DEFAULT '',
        evidence    TEXT DEFAULT '',
        contact     TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      -- === 系统监控日志强化：核心错误持久化（#449/#450）===
      -- 每一次核心错误(console.error / PG / Redis / 业务显式 ERROR / 进程级未捕获异常)
      -- 经 logbus.persistError 统一落库到此表，重启不丢；前端 /api/admin/errors 历史查询。
      CREATE TABLE IF NOT EXISTS system_error_logs (
        id          BIGSERIAL PRIMARY KEY,
        category    TEXT DEFAULT 'app',        -- 归类：pg | redis | console | billing | uncaughtException ...
        source      TEXT DEFAULT 'app',        -- 来源子系统（与 category 一致，便于筛选）
        message     TEXT NOT NULL,
        meta        JSONB DEFAULT '{}',
        stack       TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ix_sel_created ON system_error_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS ix_sel_category ON system_error_logs(category);
    `);

    // 种子：运营智能体 ops_bot + 三条自动化规则（§H.3）
    await pgPool.query(`
      INSERT INTO agents (key, name, enabled, daily_budget, config)
      VALUES ('ops_bot','运营智能体 ops_bot', TRUE, 1000, '{"desc":"自动封禁IP / 错误率告警 / 咨询应答草稿"}')
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO agents (key, name, enabled, config)
      VALUES ('prompt_optimizer','提示词优化智能体', TRUE, '{"desc":"将用户原始提示词改写为适合图像/视频生成的结构化英文提示词","endpoint":"/api/agent/optimize-prompt","skill":"prompt_optimize","skillName":"提示词优化"}')
      ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, config = EXCLUDED.config;
      INSERT INTO agents (key, name, enabled, config)
      VALUES ('prompt_translator','提示词翻译智能体', TRUE, '{"desc":"将用户提示词在中文/英文之间忠实翻译，用于补足缺失语种（生图引擎需要英文，国内工具需要中文）","endpoint":"/api/agent/translate-prompt","skill":"prompt_translate","skillName":"提示词翻译"}')
      ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, config = EXCLUDED.config;
      INSERT INTO agent_rules (id, name, trigger, condition, action, enabled) VALUES
        ('rule-ban-ip','登录失败封禁','login_fail','{"threshold":20,"window":"ip"}','{"type":"ban_ip"}', TRUE),
        ('rule-error-rate','5xx 错误率告警','error_rate','{"threshold":0.02,"metric":"5xx"}','{"type":"alert"}', TRUE),
        ('rule-auto-reply','客服咨询应答','support_query','{"kb_match":true}','{"type":"draft_reply"}', TRUE)
      ON CONFLICT (id) DO NOTHING;
    `);

    // 种子：技能注册表 + 市集示例商品（M4/M6 数字能力包雏形）
    await pgPool.query(`
      INSERT INTO skill_registry (key, name, stage, adapter, params, cost_credits, enabled, description, author, icon, version)
      VALUES
        ('prompt_optimize','提示词优化','prompt','prompt_optimize','{"target":"image"}',1,TRUE,'将原始提示词改写为结构化英文生成提示词','官方','sparkles','1.0.0'),
        ('prompt_translate','提示词翻译','prompt','prompt_translate','{"mode":"translate"}',1,TRUE,'在中文/英文之间忠实翻译提示词，补足缺失语种','官方','languages','1.0.0'),
        ('copy_writer','文案生成','post','text_gen','{"max_tokens":800,"temperature":0.8}',2,TRUE,'为成片生成营销文案 / 标题 / 社媒描述','官方','pencil','1.0.0')
      ON CONFLICT (key) DO NOTHING;
      INSERT INTO products (id, title, subtitle, kind, ref_key, price_credits, price_cents, status, author, description, tags)
      VALUES
        ('prod-prompt-optimize','提示词优化包','一键升级你的提示词质量','skill_pack','prompt_optimize',0,0,'published','官方','将口语化提示词改写为专业生成提示词，显著提升出图质量。',ARRAY['提示词','效率']),
        ('prod-copy-writer','文案生成包','成片自动配文案','skill_pack','copy_writer',50,0,'published','官方','为你的图像 / 视频生成营销文案、标题与社媒描述。',ARRAY['文案','营销'])
      ON CONFLICT (id) DO NOTHING;
    `);

    // 种子：管理员账号（opt-in：仅当显式设置 ADMIN_SEED_PASSWORD 才自动建；否则留空，
    // 由 /setup 首次运行向导或运维手动创建，避免公开仓库硬编码弱口令的安全风险）
    const existingAdmin = await pgPool.query("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
    if (existingAdmin.rows.length === 0 && process.env.ADMIN_SEED_PASSWORD) {
      const adminEmail = process.env.ADMIN_SEED_EMAIL || 'admin@huabu.local';
      const adminPw = process.env.ADMIN_SEED_PASSWORD;
      await pgPool.query(
        `INSERT INTO users (id, email, display_name, password_hash, reward_credits, role)
         VALUES ($1,$2,'平台管理员',$3,1000,'admin')`,
        ['u-' + crypto.randomUUID(), adminEmail, session.hashPassword(adminPw)]
      );
      console.log(`[Seed] 已用环境变量 ADMIN_SEED_PASSWORD 创建管理员账号 ${adminEmail}`);
    }

    // 首次部署兜底种子：providers 表为空时写入占位服务商 + 常用模型（enabled=false，需填 Key 启用）
    try {
      const provCount = await pgPool.query('SELECT COUNT(*)::int AS c FROM providers');
      if (provCount.rows[0].c === 0) {
        await seedDefaultsMod.seedDefaults(pgPool);
      }
    } catch (e) {
      console.warn('[Seed] 默认服务商/模型兜底写入失败（非致命）：', e.message);
    }

    // 公共默认资产种子（幂等：已存在则跳过）
    await seedDefaultAssets();

    // === Phase 4/5：创作工作室项目表 ===
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS studio_projects (
        id            TEXT PRIMARY KEY DEFAULT 'proj-' || gen_random_uuid()::text,
        owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title         TEXT NOT NULL DEFAULT '',
        type          TEXT NOT NULL DEFAULT 'story',
        status        TEXT NOT NULL DEFAULT 'planning',
        current_stage TEXT NOT NULL DEFAULT 'idea',
        description   TEXT DEFAULT '',
        cover_url     TEXT DEFAULT '',
        meta          JSONB DEFAULT '{}'::jsonb,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS ix_studio_owner_updated ON studio_projects(owner_id, updated_at DESC);
    `);

    return true;
  } catch (e) {
    console.error('[DB] ❌ 数据库初始化失败（schema/seed）。依据「数据必须入正式数据库」铁律，拒绝以本地 JSON 文件兜底 —— 进程退出。错误：', e.message);
    process.exit(1);
  }
}

// ─── JSON 兜底（⚠️ 历史残留 · 禁止用于业务数据）───────────────────
// 「数据必须入正式数据库」铁律（2026-08-08）：运行实例已强制 PG（initDB 连接失败即 exit(1)），
// 故下方 readJSON/writeJSON 在正常运行中**不可达**（pgPool 恒非 null）。仅保留作未启用死代码，
// 切勿在新增功能里新建「写本地文件」的分支 —— 所有业务数据必须落 PostgreSQL。
function readJSON(name) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${name}.json`), 'utf-8')); }
  catch { return name === 'oss' || name === 'settings' ? {} : []; }
}
function writeJSON(name, data) {
  fs.writeFileSync(path.join(DATA_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

// ─── snake_case → camelCase ─────────────────────
const SNAKE_MAP = {
  full_url:'fullUrl', oss_url:'ossUrl', oss_object_key:'ossObjectKey', oss_uploaded:'ossUploaded',
  avatar_url:'avatar', reference_images:'referenceImages', base_model:'baseModel',
  is_favorite:'isFavorite', is_deleted:'isDeleted', created_at:'createdAt', base_url:'baseUrl',
  api_key:'apiKey', supported_types:'supportedTypes', default_endpoint:'defaultEndpoint',
  display_name:'displayName', model_id:'modelId', provider_id:'providerId', max_concurrent:'maxConcurrent', rate_limits:'rateLimits', mapping_name:'mappingName', credit_cost:'creditCost', supports_reward_balance:'supportsRewardBalance', reward_credits_required:'rewardCreditsRequired', estimated_seconds:'estimatedSeconds', commercial_use:'commercialUse', capacity_model:'capacityModel', bucket_max:'bucketMax', cooldown_ms:'cooldownMs', sort_order:'sortOrder',
  supported_resolutions:'supportedResolutions', access_point_name:'accessPointName',
  param_template:'paramTemplate',
  endpoint_external:'endpointExternal', endpoint_internal:'endpointInternal',
  access_key_id:'accessKeyId', access_key_secret:'accessKeySecret',
  path_prefix:'pathPrefix', custom_domain:'customDomain', region_label:'regionLabel',
  error_message:'errorMessage', failed_at:'failedAt',
  file_size:'fileSize', character_id:'characterId',
  is_default:'isDefault', default_key:'defaultKey', tags:'tags',
  owner_id:'ownerId', current_stage:'currentStage', cover_url:'coverUrl',
  updated_at:'updatedAt', revision:'revision', updated_by:'updatedBy',
  reward_credits:'rewardCredits', recharge_credits:'rechargeCredits',
  target_url:'targetUrl',
  supports_reward_balance:'supportsRewardBalance', reward_credits_required:'rewardCreditsRequired',
  // ── 参考样式库扩展 ──
  preview_url:'previewUrl', negative_prompt:'negativePrompt', source_media_id:'sourceMediaId',
  ai_reason:'aiReason', reject_reason:'rejectReason', reviewed_by:'reviewedBy', reviewed_at:'reviewedAt',
  user_display_name:'userDisplayName', user_email:'userEmail',
  is_promoted:'isPromoted', commission_rate:'commissionRate', reference_style_id:'referenceStyleId',
  // ── 多 OSS 槽位扩展 ──
  provider_type:'providerType', display_name:'displayName',
  app_id:'appId', active_id:'activeId',
  // ── ModelHub V3 Phase 3 定价层：新列同步 SNAKE_MAP（避免前端 undefined 假死）──
  binding_id:'bindingId', credit_price:'creditPrice', reward_price:'rewardPrice', effective_at:'effectiveAt',
  // ── 用户双余额池（admin 用户管理展示用）──
  reward_credits:'rewardCredits', recharge_credits:'rechargeCredits',
  // ── 智能路由尝试数据：generation_jobs / generation_attempts 新列 ──
  job_id:'jobId', finished_at:'finishedAt', attempt_count:'attemptCount',
  attempt_id:'attemptId', attempt_no:'attemptNo', started_at:'startedAt', latency_ms:'latencyMs',
  http_status:'httpStatus', provider_error_code:'providerErrorCode', retry_reason:'retryReason',
  // ── Phase 1 主流化：服务端最终化新增字段（media.task_id / media.provider_url）──
  task_id:'taskId', provider_url:'providerUrl',
};
function fromSnake(obj) {
  if (!obj) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = SNAKE_MAP[k] || k;
    // PG numeric 类型通过 pg 驱动以字符串返回，前端/计费链路期望 number
    if (['credit_cost', 'reward_credits_required', 'credit_price', 'reward_price', 'cost', 'reward_credits', 'recharge_credits', 'credits', 'amount', 'balance_after'].includes(k) && typeof v === 'string') {
      out[key] = Number(v);
    } else {
      out[key] = v;
    }
  }
  return out;
}
function toSnake(obj) {
  const rev = {};
  for (const [k, v] of Object.entries(SNAKE_MAP)) rev[v] = k;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[rev[k] || k] = v;
  }
  return out;
}

// ─── 模型级参数模板（后台可简单自定义，前台按类型渲染 UI）───
// 后台无模板时，按模型 type + 能力派生一套合理默认值，保证前台始终有可渲染参数。
function defaultParamTemplate(type, supportedResolutions, capabilities) {
  const caps = (capabilities && typeof capabilities === 'object') ? capabilities : {};
  if (type === 'video') {
    return {
      qualities: ['standard', 'high'],
      ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
      durations: [4, 6, 8, 10],
      // 视频分辨率档位（后台开关）：开启才给前台选项，默认每设置智能用 1k
      videoResolutionsEnabled: false,
      videoResolutions: ['1k', '2k', '3k', '4k'],
      // 视频数量固定 1，不显示数量选择
      allowCount: false,
      supportsNegative: true,
      supportsReference: !!caps.imageInput,
      rules: [
        { label: '数量固定', description: '视频每次生成 1 个，不支持批量' },
        { label: '分辨率档位', description: '后台开启 1K/2K/3K/4K 后可选，默认智能 1K' },
      ],
    };
  }
  if (type === 'image') {
    return {
      qualities: ['low', 'standard', 'high'],
      ratios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', 'auto'],
      resolutions: (Array.isArray(supportedResolutions) && supportedResolutions.length ? supportedResolutions : ['1k', '2k', '4k']),
      allowCount: true,
      supportsNegative: true,
      supportsReference: !!(caps.asFirstFrame || caps.imageInput),
      rules: [
        { label: '图生图', description: '开启参考图后按规则提交（Agnes 走 extra_body.image）' },
      ],
    };
  }
  // 文本等其它类型：无生成参数
  return { allowCount: false, rules: [] };
}

// 首次部署 / 旧库无模板时回填（幂等：仅更新空模板）
async function backfillModelParamTemplates() {
  if (!pgPool) return;
  try {
    const empty = await pgPool.query(
      "SELECT id, type, supported_resolutions, capabilities FROM models WHERE param_template IS NULL OR param_template = '{}'::jsonb",
    );
    for (const r of empty.rows || []) {
      const tpl = defaultParamTemplate(r.type, r.supported_resolutions || [], r.capabilities || {});
      await pgPool.query('UPDATE models SET param_template=$1 WHERE id=$2', [JSON.stringify(tpl), r.id]);
    }
    if (empty.rows && empty.rows.length) console.log(`[Init] 回填 ${empty.rows.length} 个模型参数模板`);
  } catch (e) {
    console.warn('[Init] 参数模板回填失败（可忽略）', e.message);
  }
}

// ─── 公共默认资产（新用户注册/登录时拷贝到个人素材库）───
// 初始为本地 SVG 示例素材（public/samples），保证 dev/prod 均可直出。
// 真实素材可在 default_assets 表直接增改，或通过运营后台维护。
const DEFAULT_ASSET_SEED = [
  { key: 'char-01', title: '示例·古风角色', type: 'image', category: 'character', ratio: '3:4', model: 'GM-IMG', thumbnail: '/samples/character.svg', prompt: '电影级 8K 超写实人像，东方古典美人，汉服，柔光，中式庭院背景。', sort: 1, tags: ['古风', '人像'] },
  { key: 'scene-01', title: '示例·古城场景', type: 'image', category: 'scene', ratio: '16:9', model: 'GM-IMG', thumbnail: '/samples/scene.svg', prompt: '宏大古城全景，晨雾，电影感光影，超宽幅。', sort: 2, tags: ['场景', '古城'] },
  { key: 'prop-01', title: '示例·道具参考', type: 'image', category: 'prop', ratio: '1:1', model: 'GM-IMG', thumbnail: '/samples/prop.svg', prompt: '精致道具特写，金属质感，工作室打光。', sort: 3, tags: ['道具', '产品'] },
  { key: 'style-cinematic', title: '示例·电影感风格', type: 'image', category: 'other', ratio: '16:9', model: 'GM-IMG', thumbnail: '/samples/style-cinematic.svg', prompt: '电影感调色，低饱和青橙对比，胶片颗粒，宽幅构图。', sort: 4, tags: ['风格', '电影感'] },
  { key: 'style-anime', title: '示例·二次元风格', type: 'image', category: 'other', ratio: '3:4', model: 'GM-IMG', thumbnail: '/samples/style-anime.svg', prompt: '二次元动画风格，明亮配色，清晰描边，高光柔和。', sort: 5, tags: ['风格', '二次元'] },
  { key: 'prompt-portrait', title: '示例·人像提示词', type: 'image', category: 'other', ratio: '4:5', model: 'GM-IMG', thumbnail: '/samples/prompt-portrait.svg', prompt: '8K 超写实人像，自然光，浅景深，柔和肤质，情绪自然。', sort: 6, tags: ['人像', '提示词'] },
];

async function seedDefaultAssets() {
  if (!pgPool) return;
  // 默认不自动种示例数据：尊重后台「清空示例库」操作，避免重启后 SEED 自动复活（曾因
  // 「表有行才跳过」守卫在清空后被再次种入而反复）。如需初始化/恢复示例，在 .env 设置
  // ENABLE_ASSET_SEED=1 后重启，或管理员在后台示例库页面手动新增（保留系统入口）。
  const allowSeed = process.env.ENABLE_ASSET_SEED === '1' || process.env.ENABLE_ASSET_SEED === 'true';
  if (!allowSeed) {
    console.log('[Seed] ENABLE_ASSET_SEED 未开启，跳过 default_assets 自动写入（示例库清空后不会自动复活）');
    return;
  }
  for (const a of DEFAULT_ASSET_SEED) {
      await pgPool.query(
        `INSERT INTO default_assets (id,key,title,type,thumbnail,full_url,prompt,model,ratio,source,category,status,sort,tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'default',$10,'success',$11,$12::jsonb)
         ON CONFLICT (key) DO UPDATE SET title=EXCLUDED.title, thumbnail=EXCLUDED.thumbnail, full_url=EXCLUDED.full_url, prompt=EXCLUDED.prompt, model=EXCLUDED.model, ratio=EXCLUDED.ratio, category=EXCLUDED.category, sort=EXCLUDED.sort, tags=EXCLUDED.tags`,
        ['da-' + a.key, a.key, a.title, a.type, a.thumbnail, a.thumbnail, a.prompt, a.model, a.ratio, a.category, a.sort || 0, JSON.stringify(a.tags || [])]
      );
  }
  console.log(`[Seed] default_assets 已确保 ${DEFAULT_ASSET_SEED.length} 条公共默认资产`);
}

// 把公共默认资产拷贝到指定用户的个人素材库（幂等：已存在则跳过）
async function ensureUserDefaults(userId) {
  if (!pgPool || !userId) return;
  try {
    const tpl = await pgPool.query('SELECT * FROM default_assets ORDER BY sort ASC, created_at ASC');
    for (const t of tpl.rows) {
      try {
        const ex = await pgPool.query('SELECT 1 FROM media WHERE user_id=$1 AND default_key=$2 LIMIT 1', [userId, t.key]);
        if (ex.rows.length) continue;
        const id = 'def-' + crypto.randomUUID();
          await pgPool.query(
            `INSERT INTO media (id,title,type,thumbnail,full_url,prompt,model,ratio,source,is_favorite,is_deleted,oss_url,oss_object_key,oss_uploaded,category,status,error_message,failed_at,created_at,user_id,is_default,default_key,tags)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'default',FALSE,FALSE,$9,$10,$11,$12,$13,$14,NULL,$15,$16,TRUE,$17,$18::jsonb)`,
            [id, t.title, t.type, t.thumbnail, t.full_url || t.thumbnail, t.prompt, t.model, t.ratio,
             t.oss_url || '', t.oss_object_key || '', t.oss_uploaded || false, t.category, t.status || 'success', t.error_message || '',
             t.created_at || new Date().toISOString(), userId, t.key, JSON.stringify(t.tags || [])]
          );
      } catch (e) {
        console.warn('[Defaults] 拷贝失败 key=%s :', t.key, e.message);
      }
    }
  } catch (e) {
    console.warn('[Defaults] 读取默认资产模板失败:', e.message);
  }
}

// ─── 请求解析 ───────────────────────────────────
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 50 * 1024 * 1024) body = ''; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : null); }
      catch { resolve(null); }
    });
  });
}

// ─── 安全响应头（同源直出 + nginx 双保险）───
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // CSP：同源为主，允许 data:/blob:/https: 图片与媒体（OSS 代理/模型图）；React 内联样式/脚本需 unsafe-inline
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; " +
      "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https: ws: wss:; " +
      "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function sendJSON(res, code, data) {
  // 防御：避免「headers 已发送」异常导致整个进程崩溃（如某 handler 已响应但未 return 时走到末尾 404）
  if (res.headersSent) return;
  applySecurityHeaders(res);
  // SECURITY: CORS origin from config, not wildcard. Allow '*' only without credentials.
  const corsOrigin = process.env.CORS_ORIGIN;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  };
  if (corsOrigin) {
    headers['Access-Control-Allow-Origin'] = corsOrigin;
  } else if (!isProduction) {
    headers['Access-Control-Allow-Origin'] = '*';
  }
  res.writeHead(code, headers);
  res.end(JSON.stringify(data));
}

// 从深度思考模型的 reasoning_content 里提取最终优化提示词
function extractPromptFromReasoning(reasoning) {
  if (!reasoning) return '';
  // 常见模式："Final Optimized Prompt:\n..." / "Optimized Prompt:\n..." / "Final Prompt:\n..."
  const markers = [
    /[\*\s]*(?:Final\s+Optimized\s+Prompt|Optimized\s+Prompt|Final\s+Prompt)[\*\s]*[:：]\s*([\s\S]+)$/im,
    /(?:Here\s+is\s+the\s+optimized\s+prompt|Optimized\s+prompt)[\s\S]*?[:：]\s*([\s\S]+)$/im,
  ];
  for (const re of markers) {
    const m = reasoning.match(re);
    if (m && m[1]) {
      const txt = m[1].trim();
      if (txt.length > 10) return txt;
    }
  }
  // 否则取最后一段看起来是英文提示词的内容（非步骤说明）
  const blocks = reasoning.split(/\n\n+/);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i].trim();
    if (b.length > 30 && /[a-zA-Z]/.test(b) && !/^\d+[.)]/.test(b) && !b.startsWith('-')) return b;
  }
  return '';
}

// 当所有推理模型都不可用时，给出不会彻底失败的兜底英文关键词串
function buildFallbackPrompt(userPrompt) {
  if (!userPrompt) return '';
  // 简单策略：把中文/英文逗号、顿号、换行拆成标签，去重后拼成英文短语串
  const parts = userPrompt
    .replace(/，/g, ',').replace(/、/g, ',').replace(/\n/g, ',')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';
  const unique = [...new Set(parts)];
  // 加上一个通用画质后缀，使其更像结构化提示词
  const base = unique.join(', ');
  if (/[\u4e00-\u9fa5]/.test(base)) {
    // 中文保留原样并补画质后缀；图像模型对中文支持通常有限，但至少可用
    return `${base}, 高画质, 细节丰富, 电影级光影, 专业摄影, 8K, 超高分辨率`;
  }
  return `${base}, high quality, highly detailed, cinematic lighting, professional photography, 8K, ultra high resolution`;
}

// 从模型输出（content 或 reasoning_content，或两者拼接）中提取结构化提示词块：
// [EN_POSITIVE] [EN_NEGATIVE] [ZH_POSITIVE] [ZH_NEGATIVE]
// 返回 { enPos, enNeg, zhPos, zhNeg } 或 null（当两套正向都缺失时）
function extractPromptBlocks(text) {
  if (!text) return null;
  const get = (tag) => {
    const m = text.match(new RegExp(`\\[${tag}\\][\\s\\S]*?\\[\\/${tag}\\]`, 'i'));
    if (!m) return '';
    return m[0].replace(new RegExp(`\\[\\/?${tag}\\]`, 'gi'), '').trim();
  };
  const enPos = get('EN_POSITIVE');
  const enNeg = get('EN_NEGATIVE');
  const zhPos = get('ZH_POSITIVE');
  const zhNeg = get('ZH_NEGATIVE');
  if (!enPos && !zhPos) return null;
  return { enPos, enNeg, zhPos, zhNeg };
}

// 服务端回探图片真实字节数（不受浏览器缓存/CORS 限制），写入 media.file_size。
// 优先 HEAD content-length；失败再用 Range 部分 GET 读 content-range 的总大小；再失败静默忽略。
async function enrichMediaFileSize(pg, id, url) {
  if (!pg || !id || !url) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    let size = null;
    try {
      const r = await fetch(url, { method: 'HEAD', signal: controller.signal });
      const cl = r.headers.get('content-length');
      if (cl) { const n = parseInt(cl, 10); if (Number.isFinite(n) && n > 0) size = n; }
      if (!size) {
        const r2 = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: controller.signal });
        const cr = r2.headers.get('content-range');
        if (cr && cr.includes('/')) {
          const total = parseInt(cr.split('/')[1], 10);
          if (Number.isFinite(total) && total > 0) size = total;
        } else {
          const cl2 = r2.headers.get('content-length');
          if (cl2) { const n = parseInt(cl2, 10); if (Number.isFinite(n) && n > 0) size = n; }
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (size) {
      await pg.query('UPDATE media SET file_size=$1 WHERE id=$2 AND (file_size IS NULL OR file_size<>$1)', [size, id]);
    }
  } catch {
    // 不可达/超时/非 HTTP：静默忽略，前端退化为估算兜底
  }
}

// ─── MIME ────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.json': 'application/json', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.otf': 'font/otf',
};

function serveStatic(req, res) {
  const urlPath = req.url === '/' ? 'index.html' : req.url;
  // 优先从 public 目录读取（可热替换资源，如客服二维码）；命中则直接返回
  const publicFile = path.join(__dirname, '..', 'public', urlPath);
  if (fs.existsSync(publicFile) && !fs.statSync(publicFile).isDirectory()) {
    const ext = path.extname(publicFile);
    applySecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    return res.end(fs.readFileSync(publicFile));
  }
  let filePath = path.join(CLIENT_DIR, urlPath);
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(CLIENT_DIR, 'index.html');
    }
    const ext = path.extname(filePath);
    applySecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(fs.readFileSync(filePath));
  } catch { res.end(); }
}

// ─── 本地静态文件（/media/ 上传 & /samples/ 公共示例，非 /api 路由，必须早于 SPA fallback）───
function serveLocalFiles(req, res) {
  const url = req.url.replace(/\/$/, '');
  const method = req.method;

  // ── 本地上传文件读取 ──
  if (url.startsWith('/media/') && method === 'GET') {
    const rel = url.slice('/media/'.length).replace(/[^a-zA-Z0-9._/-]/g, '_');
    const file = path.join(DATA_DIR, 'media-uploads', rel);
    if (fs.existsSync(file)) {
      const ext = path.extname(file).toLowerCase();
      const ct = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': ct,
        ...(process.env.CORS_ORIGIN ? { 'Access-Control-Allow-Origin': process.env.CORS_ORIGIN } : (!isProduction ? { 'Access-Control-Allow-Origin': '*' } : {})),
      });
      return res.end(fs.readFileSync(file));
    }
    return sendJSON(res, 404, { error: 'Not Found' });
  }

  // ── 公共示例素材（默认资产 SVG 占位，dev/prod 均可直出）──
  if (url.startsWith('/samples/') && method === 'GET') {
    const rel = url.slice('/samples/'.length).replace(/[^a-zA-Z0-9._/-]/g, '_');
    const file = path.join(__dirname, '..', 'public', 'samples', rel);
    if (fs.existsSync(file)) {
      const ext = path.extname(file).toLowerCase();
      const ct = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': ct,
        ...(process.env.CORS_ORIGIN ? { 'Access-Control-Allow-Origin': process.env.CORS_ORIGIN } : (!isProduction ? { 'Access-Control-Allow-Origin': '*' } : {})),
      });
      return res.end(fs.readFileSync(file));
    }
    return sendJSON(res, 404, { error: 'Not Found' });
  }

  return sendJSON(res, 404, { error: 'Not Found' });
}

// ─── Phase 2 实时流量采样（总控台 SSE 用，单实例内存环形缓冲）──
const traffic = {
  recent: [],
  record(method, url, status, user, ms) {
    const now = Date.now();
    this.recent.push({ ts: now, user_id: user && user.id ? user.id : null, method, url, status, ms });
    const cut = now - 60000;
    if (this.recent.length > 4000) this.recent = this.recent.filter((r) => r.ts >= cut);
  },
  onlineUsers() {
    const cut = Date.now() - 300000;
    const s = new Set();
    for (const r of this.recent) if (r.ts >= cut && r.user_id) s.add(r.user_id);
    return s.size;
  },
  currentQps() {
    const cut = Date.now() - 1000;
    let n = 0;
    for (const r of this.recent) if (r.ts >= cut) n++;
    return n;
  },
};

// ─── Phase 2 管理后台模块（注入依赖；pgPool 经 getter 取最新值）──
const monitor = monitorMod.createMonitor();   // 后台实时监控：所有 HTTP 请求(API + 静态资产)的环形缓冲 + SSE 流
monitor.startMetricsTimer();                   // 1s 广播一次 60s 滚动指标

const ossLogger = ossMod.getLogger();  // OSS 实时日志（单例由 oss.cjs 管理）；/api/oss/logs/* 路由与 OssConfigPanel SSE 仍走它

const admin = adminMod.createAdmin({
  getPg: () => pgPool,
  session,
  sendJSON,
  fromSnake,
  toSnake,
  parseBody,
  traffic: { onlineUsers: () => traffic.onlineUsers(), currentQps: () => traffic.currentQps() },
  monitor,                                    // 注入 monitor：admin 实时监控页用(/api/admin/monitor/{snapshot,stream,clear})
  logbus,                                     // 注入 logbus：admin 实时日志页用(/api/admin/logs/{snapshot,stream,clear})
  syslog: syslogMod,                          // 注入 syslog：核心错误历史查询/清理用(/api/admin/errors)
});

const referenceStyles = referenceStylesMod.createReferenceStyles({
  getPg: () => pgPool,
  session,
  sendJSON,
  fromSnake,
  parseBody,
  auditStyle: (styleId, actorId) => referenceStyleAudit.auditStyle(pgPool, styleId, actorId),
});

// ── Phase 5 电商模块（AI 市集）── 注入依赖；pgPool 经 getter 取最新值；内部自行鉴权
const shop = shopMod.createShop({
  getPg: () => pgPool,
  session,
  sendJSON,
  parseBody,
  billing,
});

// ── Phase 4 账务系统 ── 注入依赖；pgPool 经 getter 取最新值
const finance = financeMod.createFinance({
  getPg: () => pgPool,
  session,
  sendJSON,
  fromSnake,
  parseBody,
  // 支付服务商变更后让 loader 缓存立即失效（payments 在下方定义，闭包延迟取值）
  invalidateProviders: () => { try { if (payments && payments.invalidateProviderCache) payments.invalidateProviderCache(); } catch (e) {} },
});
const me = meMod.createMe({
  getPg: () => pgPool,
  session,
  sendJSON,
  parseBody,
});

// ─── 充值订单 + 真实支付通道适配器（注入依赖；pgPool 经 getter 取最新值）──
// 安全：DEV 模拟支付已彻底移除；真实入账只走公开 webhook（鉴权网关前），fails closed。
const payments = paymentsMod.createPayments({
  getPg: () => pgPool,
  session,
  sendJSON,
  parseBody,
});

// ─── 订单超时调度器（Node 内存 worker）──
// 周期性把超时 pending 订单置 expired + 审计；下单不预留积分，故不触碰余额。
// 进程退出时 stop() 清定时器。
const orderExpiry = createOrderExpiryWorker({ getPg: () => pgPool, intervalMs: 60000 });

// ─── 应用网关（Phase A 改造）─────────────────────
// 保留全局 API_TOKEN（后续阶段去 fallback，评审稿 ⑦）；同时接受用户会话 cookie。
// 任一通过即放行，并把身份挂到 req.user：API_TOKEN → {id:'__system__'}，会话 → {id, role}
function appGateway(req) {
  // 仅当 dev 令牌启用时（非生产，或生产显式通过环境变量提供），才接受其作为 system 身份
  if (devTokenEnabled && req.headers['authorization'] === `Bearer ${API_TOKEN}`) {
    req.user = { id: '__system__', role: 'system' };
    return true;
  }
  const u = session.getUserFromCookie(req);
  if (u) { req.user = u; return true; }
  return false;
}

// ══════════════════════════════════════════════════
// API 路由（PG 优先，JSON 降级）
// ══════════════════════════════════════════════════
// ─── 认证路由处理 ────────────────────────────────
// 注册赠送积分：可通过环境变量 SIGNUP_BONUS_CREDITS 覆盖（默认 50），
// 集中管理，避免 credits 列默认 / INSERT / 流水 / 返回值 四处硬编码不一致
const SIGNUP_BONUS_CREDITS = Number(process.env.SIGNUP_BONUS_CREDITS ?? 50);
const SIGNUP_BONUS_RECHARGE_CREDITS = Number(process.env.SIGNUP_BONUS_RECHARGE_CREDITS ?? 0);

// 解析注册赠送积分：优先级 环境变量 > settings.app > 默认
// reward（赠送余额）默认 50；recharge（充值余额赠送）默认 0
async function resolveSignupBonusCredits() {
  let reward = SIGNUP_BONUS_CREDITS;
  let recharge = SIGNUP_BONUS_RECHARGE_CREDITS;
  const envReward = Number(process.env.SIGNUP_BONUS_CREDITS);
  const envRecharge = Number(process.env.SIGNUP_BONUS_RECHARGE_CREDITS);
  if (Number.isFinite(envReward) && envReward > 0) reward = Math.floor(envReward);
  if (Number.isFinite(envRecharge) && envRecharge > 0) recharge = Math.floor(envRecharge);
  if (pgPool) {
    try {
      const r = await pgPool.query("SELECT value FROM settings WHERE key='app'");
      const v = (r.rows[0] && r.rows[0].value) || {};
      // 环境变量未设置时才允许后台设置覆盖
      if (v && !Number.isFinite(envReward) && Number(v.signupBonusCredits) > 0) {
        reward = Math.floor(Number(v.signupBonusCredits));
      }
      // 环境变量未设置时才允许后台设置覆盖
      if (v && (!Number.isFinite(envRecharge) || envRecharge <= 0) && Number(v.signupBonusRechargeCredits) > 0) {
        recharge = Math.floor(Number(v.signupBonusRechargeCredits));
      }
    } catch {}
  }
  return { reward, recharge };
}

// 解析参考样式设计者分成比例（%）：settings.app.styleCommissionRate，默认 30。
// 某样式自身 commission_rate>0 时优先用自身的；否则用全局默认。
async function resolveStyleCommissionRate() {
  if (pgPool) {
    try {
      const r = await pgPool.query("SELECT value FROM settings WHERE key='app'");
      const v = (r.rows[0] && r.rows[0].value) || {};
      if (v && Number(v.styleCommissionRate) > 0) return Math.floor(Number(v.styleCommissionRate));
    } catch {}
  }
  return 30;
}

// 解析「生成接口」应用层限流参数：settings.app.genRateLimit = { limit, windowSec }，
// 默认 { limit: 30, windowSec: 60 }（每 IP 60s 内最多 30 次生成）。
// 后台「系统设置 → 生成限流」可手动调整；仅当值合法（正整数 / 正秒）时覆盖默认，
// 防止误配把限流关成 0（等于放开滥用）。
// 加 30s 内存缓存，避免每次生成请求都打一次 DB。
let _genRateCache = null;
let _genRateCacheAt = 0;
const GEN_RATE_CACHE_TTL = 30 * 1000;
async function resolveGenRateLimit() {
  const DEFAULT = { limit: 30, windowSec: 60 };
  const now = Date.now();
  if (_genRateCache && now - _genRateCacheAt < GEN_RATE_CACHE_TTL) return _genRateCache;
  let result = DEFAULT;
  if (pgPool) {
    try {
      const r = await pgPool.query("SELECT value FROM settings WHERE key='app'");
      const v = (r.rows[0] && r.rows[0].value) || {};
      const cfg = v && v.genRateLimit;
      if (cfg && typeof cfg === 'object') {
        const limit = Number(cfg.limit);
        const windowSec = Number(cfg.windowSec);
        if (Number.isInteger(limit) && limit > 0 && Number.isInteger(windowSec) && windowSec > 0) {
          result = { limit, windowSec };
        }
      }
    } catch {}
  }
  _genRateCache = result;
  _genRateCacheAt = now;
  return result;
}

// 参考样式分成：客户用某样式生图 → 按分成比例返积分给设计者（进奖励池）。
// 设计者==客户自身时跳过（不自我分成）；幂等（同 media_id 已记则跳过）；异常绝不影响主链路。
async function creditStyleDesigner(pg, { referenceStyleId, customerId, mediaId, chargeCredits }) {
  if (!referenceStyleId || !pg) return;
  try {
    // 幂等：同一 media 已分成则跳过（媒体 POST 是 upsert，重试可能重复调用）
    if (mediaId) {
      const ex = await pg.query('SELECT 1 FROM style_earnings WHERE media_id=$1 LIMIT 1', [mediaId]);
      if (ex.rows.length) return;
    }
    const sr = await pg.query(
      'SELECT id, user_id, status, commission_rate FROM reference_styles WHERE id=$1',
      [referenceStyleId],
    );
    if (!sr.rows.length) return;
    const style = sr.rows[0];
    if (style.status !== 'approved') return; // 仅已审核通过的样式才分成
    const designerId = style.user_id;
    if (!designerId || designerId === customerId) return; // 设计者自己用自己样式不分成
    const rate = Number(style.commission_rate) > 0 ? Number(style.commission_rate) : await resolveStyleCommissionRate();
    const base = Number(chargeCredits) > 0 ? Number(chargeCredits) : 0;
    if (base <= 0) return;
    const commission = Math.max(1, Math.round((base * rate) / 100));
    if (commission <= 0) return;
    // 进设计者奖励池（平台发放 → reward_credits）
    await pg.query('UPDATE users SET reward_credits = COALESCE(reward_credits,0) + $1 WHERE id=$2', [commission, designerId]);
    await pg.query(
      `INSERT INTO style_earnings (id, reference_style_id, designer_id, customer_id, media_id, charge_credits, commission_credits)
       VALUES ('se-' || gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
      [referenceStyleId, designerId, customerId || null, mediaId || null, base, commission],
    );
  } catch (e) {
    console.warn('[style-commission] 分成失败（已忽略）:', e.message);
  }
}

async function handleRegister(req, res) {
  // Phase 0 限流：同一 IP 60s 内最多 5 次注册
  const rlReg = await rateLimit({ key: 'rl:register:' + clientIp(req), limit: 5, windowSec: 60 });
  if (!rlReg.allowed) {
    res.setHeader('Retry-After', String(rlReg.retryAfter));
    return sendJSON(res, 429, { error: '注册请求过于频繁，请稍后再试' });
  }
  const body = await parseBody(req);
  const email = ((body && body.email) || '').toString().trim().toLowerCase();
  const pw = (body && body.password) || '';
  const displayName = ((body && body.displayName) || email.split('@')[0] || '').toString().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJSON(res, 400, { error: '邮箱格式不正确' });
  if (!pw || pw.length < 6) return sendJSON(res, 400, { error: '密码至少 6 位' });
  if (!pgPool) return sendJSON(res, 503, { error: '数据库不可用' });
  const ex = await pgPool.query('SELECT id FROM users WHERE email=$1', [email]);
  if (ex.rows.length) return sendJSON(res, 409, { error: '该邮箱已注册' });
  const id = 'u-' + crypto.randomUUID();
  const { reward, recharge } = await resolveSignupBonusCredits();
  await pgPool.query(
    `INSERT INTO users (id, email, display_name, password_hash, reward_credits, recharge_credits, role)
     VALUES ($1, $2, $3, $4, ${reward}, ${recharge}, 'user')`,
    [id, email, displayName, session.hashPassword(pw)],
  );
  if (reward > 0) {
    await pgPool.query(
      `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool) VALUES ($1, 'grant', ${reward}, 'signup-bonus', 'reward')`,
      [id],
    );
  }
  if (recharge > 0) {
    await pgPool.query(
      `INSERT INTO credit_transactions (user_id, kind, amount, ref, pool) VALUES ($1, 'grant', ${recharge}, 'signup-bonus-recharge', 'recharge')`,
      [id],
    );
  }
  // 注册即拷贝公共默认资产到个人素材库（幂等）
  await ensureUserDefaults(id);
  const token = session.signSession({ id, role: 'user' });
  session.setCookie(res, session.COOKIE_NAME, token, session.ACCESS_TTL_SEC, req);
  const totalCredits = reward + recharge;
  return sendJSON(res, 200, { ok: true, user: { id, email, displayName, rewardCredits: reward, rechargeCredits: recharge, credits: totalCredits, role: 'user' } });
}

async function handleLogin(req, res) {
  // Phase 0 限流：同一 IP 60s 内最多 10 次登录（防暴力破解）
  const rlLogin = await rateLimit({ key: 'rl:login:' + clientIp(req), limit: 10, windowSec: 60 });
  if (!rlLogin.allowed) {
    res.setHeader('Retry-After', String(rlLogin.retryAfter));
    return sendJSON(res, 429, { error: '登录请求过于频繁，请稍后再试' });
  }
  const body = await parseBody(req);
  const email = ((body && body.email) || '').toString().trim().toLowerCase();
  const pw = (body && body.password) || '';
  if (!pgPool) return sendJSON(res, 503, { error: '数据库不可用' });
  const r = await pgPool.query(
    'SELECT id, email, display_name, password_hash, reward_credits, recharge_credits, credits, role FROM users WHERE email=$1', [email]);
  if (!r.rows.length) return sendJSON(res, 401, { error: '邮箱或密码错误' });
  const u = r.rows[0];
  if (!session.verifyPassword(pw, u.password_hash)) return sendJSON(res, 401, { error: '邮箱或密码错误' });
  // 登录时确保公共默认资产已就位（幂等；兼容老用户注册前尚无默认资产的情况）
  // 注意：admin 不是「顾客」，不自动塞示例（手动推送 pushSamplesToUsers 也已排除 admin）
  if (u.role !== 'admin') await ensureUserDefaults(u.id);
  const token = session.signSession({ id: u.id, role: u.role });
  session.setCookie(res, session.COOKIE_NAME, token, session.ACCESS_TTL_SEC, req);
  return sendJSON(res, 200, {
    ok: true,
    user: { id: u.id, email: u.email, displayName: u.display_name, rewardCredits: u.reward_credits, rechargeCredits: u.recharge_credits, credits: u.credits, role: u.role },
  });
}

async function handleLogout(req, res) {
  session.clearCookie(res, session.COOKIE_NAME);
  return sendJSON(res, 200, { ok: true });
}

async function handleRefresh(req, res) {
  const user = session.getUserFromCookie(req);
  if (!user) return sendJSON(res, 401, { error: '会话无效' });
  const token = session.signSession({ id: user.id, role: user.role });
  session.setCookie(res, session.COOKIE_NAME, token, session.ACCESS_TTL_SEC, req);
  return sendJSON(res, 200, { ok: true });
}

async function handleMe(req, res) {
  const user = session.getUserFromCookie(req);
  if (!user) return sendJSON(res, 401, { error: '未登录' });
  if (!pgPool) return sendJSON(res, 503, { error: '数据库不可用' });
  const r = await pgPool.query(
    'SELECT id, email, display_name, reward_credits, recharge_credits, credits, role, plan FROM users WHERE id=$1', [user.id]);
  if (!r.rows.length) return sendJSON(res, 401, { error: '用户不存在' });
  const u = r.rows[0];
  return sendJSON(res, 200, {
    user: { id: u.id, email: u.email, displayName: u.display_name, rewardCredits: u.reward_credits, rechargeCredits: u.recharge_credits, credits: u.credits, role: u.role, plan: u.plan || 'free' },
  });
}

// ── 首次部署初始化向导（公开，fails-closed）──────────────────────────────
// GET /api/setup/status → { initialized, presetProviders, presetModels }
// POST /api/setup/init  → 事务内建首个管理员 + 可选服务商 + 选中模型(enabled=true)
async function handleSetupStatus(req, res) {
  try {
    let initialized = false;
    if (pgPool) {
      const r = await pgPool.query("SELECT COUNT(*)::int AS c FROM users WHERE role='admin'");
      initialized = r.rows[0].c > 0;
    }
    return sendJSON(res, 200, {
      initialized,
      presetProviders: seedDefaultsMod.DEFAULT_PROVIDERS.map((p) => ({ id: p.id, name: p.name })),
      presetModels: seedDefaultsMod.DEFAULT_MODELS.map((m) => ({
        id: m.id,
        modelId: m.model_id,
        displayName: m.display_name,
        type: m.type,
        supportedResolutions: m.supported_resolutions,
      })),
    });
  } catch {
    return sendJSON(res, 200, { initialized: false, presetProviders: [], presetModels: [] });
  }
}

async function handleSetupInit(req, res) {
  const body = await parseBody(req);
  if (!body) return sendJSON(res, 400, { error: 'invalid_body' });

  const adminEmail = String(body.adminEmail || '').trim().toLowerCase();
  const adminPassword = String(body.adminPassword || '');
  const adminDisplayName = String(body.adminDisplayName || '平台管理员').trim() || '平台管理员';
  const provider = body.provider || null;
  const selectedModelIds = Array.isArray(body.selectedModelIds) ? body.selectedModelIds : [];

  // 基础校验
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
    return sendJSON(res, 400, { error: 'invalid_email', message: '请输入有效的管理员邮箱' });
  }
  if (adminPassword.length < 8) {
    return sendJSON(res, 400, { error: 'weak_password', message: '管理员密码至少 8 位' });
  }
  if (selectedModelIds.length > 0 && (!provider || !String(provider.api_key || '').trim())) {
    return sendJSON(res, 400, {
      error: 'provider_required',
      message: '启用模型前必须先配置一个有效的服务商 API Key',
    });
  }
  if (!pgPool) return sendJSON(res, 503, { error: 'no_db', message: '数据库未连接，请先配置并启动数据库' });

  // fails-closed：已有管理员则锁定
  const adminCheck = await pgPool.query("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
  if (adminCheck.rows.length > 0) {
    return sendJSON(res, 409, { error: 'already_initialized', message: '平台已完成初始化，无需重复操作' });
  }

  // 轻量限流：同一 IP ≤20 次 / 10 分钟
  const ip = req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const win = setupAttempts.get(ip) || { count: 0, ts: now };
  if (now - win.ts > 10 * 60 * 1000) { win.count = 0; win.ts = now; }
  win.count += 1;
  setupAttempts.set(ip, win);
  if (win.count > 20) return sendJSON(res, 429, { error: 'too_many_attempts' });

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    // 1) 首个管理员
    const adminId = 'u-' + crypto.randomUUID();
    await client.query(
      `INSERT INTO users (id, email, display_name, password_hash, reward_credits, role)
       VALUES ($1,$2,$3,$4,1000,'admin')`,
      [adminId, adminEmail, adminDisplayName, session.hashPassword(adminPassword)]
    );

    // 2) 服务商（可选）
    let providerId = null;
    const apiKey = provider ? String(provider.api_key || '').trim() : '';
    if (apiKey) {
      providerId = 'prov-' + crypto.randomUUID();
      const pname = String(provider.name || '我的服务商').trim() || '我的服务商';
      const baseUrl = String(provider.base_url || 'https://api.openai.com/v1').trim();
      const protocol = String(provider.protocol || 'openai-compatible').trim();
      const supportedTypes =
        Array.isArray(provider.supported_types) && provider.supported_types.length
          ? provider.supported_types
          : ['image'];
      await client.query(
        `INSERT INTO providers (id, name, type, base_url, api_key, supported_types, enabled, protocol, remark, default_endpoint, capacity_model, cooldown_ms)
         VALUES ($1,$2,'custom',$3,$4,$5,TRUE,$6,$7,'{}','limited',60000)`,
        [providerId, pname, baseUrl, apiKey, supportedTypes, protocol, '初始化向导创建的服务商']
      );
    }

    // 3) 选中的模型 → enabled=true，挂到刚建的服务商（无服务商则挂占位 prov-demo）
    const known = new Map(seedDefaultsMod.DEFAULT_MODELS.map((m) => [m.id, m]));
    let enabledCount = 0;
    for (const mid of selectedModelIds) {
      const m = known.get(String(mid));
      if (!m) continue; // 忽略未知 id，防注入
      const targetProvider = providerId || 'prov-demo';
      await client.query(
        `INSERT INTO models (id, model_id, display_name, type, provider_id, enabled, supported_resolutions, capabilities, endpoint)
         VALUES ($1,$2,$3,$4,$5,TRUE,$6,'{}','{}')
         ON CONFLICT (id) DO UPDATE SET enabled=TRUE, provider_id=EXCLUDED.provider_id`,
        [m.id, m.model_id, m.display_name, m.type, targetProvider, m.supported_resolutions]
      );
      enabledCount += 1;
    }

    await client.query('COMMIT');
    return sendJSON(res, 200, {
      ok: true,
      initialized: true,
      adminEmail,
      providerCreated: !!providerId,
      modelsEnabled: enabledCount,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[Setup] 初始化失败:', e.message);
    return sendJSON(res, 500, { error: 'setup_failed', message: e.message });
  } finally {
    client.release();
  }
}

async function handleAPI(req, res) {
  const url = req.url.replace(/\/$/, '').split('?')[0];   // 去掉尾部斜杠 + query，让所有 `url === '/api/...'` 路由不吃 query
  const method = req.method;
  const reqUrl = new URL(req.url, 'http://localhost');
  req.query = Object.fromEntries(reqUrl.searchParams);

  // Phase 0 健康检查：公开端点，网关前放行，供 nginx/容器探针与压测使用
  // /api/healthz — process alive (liveness probe)
  if (url === '/api/healthz' && method === 'GET') {
    const cpu = cpuMonitor.getStatus();
    return sendJSON(res, 200, {
      status: 'ok',
      pg: !!pgPool,
      redis: isRedisUp(),
      node_id: NODE_ID,
      uptime: Math.floor(process.uptime()),
      version: process.env.npm_package_version || '0.1.0',
      ts: Date.now(),
      cpu: {
        percent: Math.round(cpu.cpuPercent * 1000) / 10, // 单核占比（%），保留 1 位小数（仅观测，不再触发 SHED）
        elP99Ms: Math.round((cpu.elP99Ms || 0) * 10) / 10, // 事件循环 p99 延迟（ms）——实际健康闸门信号
        shedding: cpu.shedding,
        primarySignal: cpu.primarySignal, // 'eventloop' 现代 Node | 'cpu' 退化模式
        elShedding: !!cpu.elShedding,
        cpuShedding: !!cpu.cpuShedding,
        shedThreshold: Math.round(cpu.shedThreshold * 100),
        recoverThreshold: Math.round(cpu.recoverThreshold * 100),
      },
    });
  }

  // /api/readiness — dependencies sufficient to serve traffic (readiness probe)
  // Returns 200 only when PG pool and Redis are both available.
  if (url === '/api/readiness' && method === 'GET') {
    const pgReady = !!pgPool;
    const redisReady = isRedisUp();
    if (pgReady && redisReady) {
      return sendJSON(res, 200, { status: 'ready', pg: true, redis: true, node_id: NODE_ID });
    }
    return sendJSON(res, 503, { status: 'not_ready', pg: pgReady, redis: redisReady, node_id: NODE_ID });
  }

  // 公开路由（注册/登录/刷新在全局网关之前）
  if (url === '/api/auth/register' && method === 'POST') return handleRegister(req, res);
  if (url === '/api/auth/login' && method === 'POST') return handleLogin(req, res);
  if (url === '/api/auth/refresh' && method === 'POST') return handleRefresh(req, res);
  // 公开：充值套餐（供充值弹窗预览，无需登录）
  if (url === '/api/finance/topup-packages' && method === 'GET') return finance.handlePublic(req, res, url.split('?')[0], method);
  // 公开：当前可用的支付方式列表（由 payment_providers.supported_methods 并集决定）
  if (url === '/api/credits/payment-methods' && method === 'GET') return payments.handlePayments(req, res, url, method);
  // 公开：等待区聚合状态（仅返回聚合数，不含逐账号明细）。供前台判断是否提示"资源不足"：
  // 所有资源不可用 且 等待区积压 > 阈值（阈值可调）。无需登录，避免未登录用户误刷请求。
  if (url === '/api/generate/queue-status' && method === 'GET') {
    try {
      if (pgPool) await dispatcher.refreshWaitingThreshold(pgPool);
      return sendJSON(res, 200, dispatcher.getWaitingAreaStatus());
    } catch {
      return sendJSON(res, 200, { waitingAreaSize: 0, allResourcesDown: false, threshold: 10, triggered: false });
    }
  }

  // 公开：支付异步通知（真实入账，fails closed）——必须在鉴权网关前放行，供支付平台回调
  {
    const wh = url.match(/^\/api\/credits\/webhook\/([a-z]+)$/);
    if (wh && method === 'POST') return payments.handleWebhook(req, res, wh[1]);
  }

  // 首次部署初始化向导（公开，fails-closed：首个管理员建好后即锁定，任何人再调返回 409）
  if (url === '/api/setup/status' && method === 'GET') return handleSetupStatus(req, res);
  if (url === '/api/setup/init' && method === 'POST') return handleSetupInit(req, res);

  // 参考样式公开列表：无需登录（投稿/删除仍需登录，留在下方 appGateway 之后处理）
  if (url === '/api/reference-styles' && method === 'GET') {
    if (await referenceStyles.handle(req, res, url, method)) return;
  }

  // AI 市集公开浏览 + 技能目录：无需登录（获取/试跑/我的技能等留在下方 appGateway 之后处理）
  if (method === 'GET') {
    const path = url.split('?')[0];
    const isPublicShop = path === '/api/shop/products' || path === '/api/skills' || /^\/api\/shop\/products\/[^/]+$/.test(path);
    if (isPublicShop) {
      if (await shop.handleShop(req, res, path, method)) return;
    }
  }

  // 创作者公开主页（无需登录）：/api/users/:id 与 /api/users/:id/media
  if (method === 'GET') {
    const userPath = /^\/api\/users\/([^/]+)$/.exec(url.split('?')[0]);
    const mediaPath = /^\/api\/users\/([^/]+)\/media$/.exec(url.split('?')[0]);
    if (userPath || mediaPath) {
      const uid = decodeURIComponent((userPath || mediaPath)[1]);
      try {
        const ur = await pgPool.query('SELECT id, display_name, created_at FROM users WHERE id=$1', [uid]);
        if (!ur.rows.length) return sendJSON(res, 404, { error: '用户不存在' });
        const u = ur.rows[0];
        if (mediaPath) {
          const mr = await pgPool.query(
            'SELECT id, title, type, category, thumbnail, full_url, oss_url, created_at FROM media WHERE user_id=$1 AND is_deleted=FALSE ORDER BY created_at DESC LIMIT 200',
            [uid]
          );
          const items = mr.rows.map((x) => {
            const url = x.oss_url || x.full_url || x.thumbnail || '';
            return {
              id: x.id,
              title: x.title || '',
              thumbnail: url,
              fullUrl: url,
              type: x.type || 'image',
              category: x.category || 'generated',
            };
          });
          return sendJSON(res, 200, { items });
        }
        const cnt = await pgPool.query(
          'SELECT COUNT(*)::int AS n FROM media WHERE user_id=$1 AND is_deleted=FALSE',
          [uid]
        );
        return sendJSON(res, 200, {
          user: {
            id: u.id,
            displayName: u.display_name || '',
            createdAt: u.created_at ? new Date(u.created_at).toISOString() : new Date().toISOString(),
          },
          stats: { media: (cnt.rows[0] && cnt.rows[0].n) || 0 },
        });
      } catch (e) {
        return sendJSON(res, 500, { error: '查询失败：' + (e?.message || e) });
      }
    }
  }

  // 应用网关：API_TOKEN 或 用户会话 cookie 任一通过
  if (!appGateway(req)) return sendJSON(res, 401, { error: 'Unauthorized' });

  // 需会话的认证路由
  if (url === '/api/auth/me' && method === 'GET') return handleMe(req, res);
  if (url === '/api/auth/logout' && method === 'POST') return handleLogout(req, res);
  // ── 用户侧账务（积分流水 / 充值订单 / 概览）── 需登录
  if (url.startsWith('/api/me/') && method !== 'OPTIONS') return me.handleMeRoutes(req, res, url.split('?')[0], method);

  // ── 参考样式库（用户投稿 + AI 预审 + 人工终审）── 需登录
  if (url.startsWith('/api/reference-styles') && method !== 'OPTIONS') {
    try {
      const hit = await referenceStyles.handle(req, res, url.split('?')[0], method);
      if (hit) return;
    } catch (e) {
      if (!res.headersSent) sendJSON(res, 500, { error: '参考样式处理异常：' + (e?.message || e) });
      return;
    }
  }

  // ── 管理后台（M3 总控台 / M4 智能体层）──
  if (url === '/api/admin/console/stream' && method === 'GET') return admin.streamConsole(req, res);
  // ── 后台账务系统（Phase 4：总览 / 对账 / 账本 / 套餐）── 优先于通用 admin 分发
  if (url.startsWith('/api/admin/finance/') && method !== 'OPTIONS') return finance.handleFinance(req, res, url.split('?')[0], method);
  // ── 技能注册表后台 CRUD（M4/M6）── 必须在通用 /api/admin/ 之前拦截（否则会被 admin 模块的 404 吞掉）
  if (url.startsWith('/api/admin/skills') && method !== 'OPTIONS') {
    if (await shop.handleShop(req, res, url.split('?')[0], method)) return;
  }
  // ── 全局双边账务看板（后台量 vs 客户量 = 盈亏）── admin 可见
  if ((url === '/api/admin/ledger/summary' || url.startsWith('/api/admin/ledger')) && method === 'GET') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    try {
      if (url === '/api/admin/ledger/summary') {
        const rows = await accounting.summarize(pgPool, {});
        let sumBackend = 0, sumCustomer = 0, sumMargin = 0;
        for (const r of rows) {
          sumBackend += Number(r.sum_backend) || 0;
          sumCustomer += Number(r.sum_customer) || 0;
          sumMargin += Number(r.sum_margin) || 0;
        }
        return sendJSON(res, 200, { ok: true, total: { backendCostCents: sumBackend, customerChargeCents: sumCustomer, marginCents: sumMargin }, byScopePurpose: rows });
      }
      const lim = Math.min(200, Number((url.split('limit=')[1] || '').split('&')[0]) || 50) || 50;
      const r = await pgPool.query('SELECT * FROM consumption_ledger ORDER BY created_at DESC LIMIT $1', [lim]);
      return sendJSON(res, 200, { ok: true, rows: r.rows });
    } catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }
  // ── 参考样式库审核后台（AI 预审 + 人工终审）──
  if (url.startsWith('/api/admin/reference-styles') && method !== 'OPTIONS') {
    try {
      const hit = await referenceStyles.handleAdmin(req, res, url.split('?')[0], method);
      if (hit) return;
    } catch (e) {
      if (!res.headersSent) sendJSON(res, 500, { error: '参考样式审核处理异常：' + (e?.message || e) });
      return;
    }
  }

  // ── 模型历史价格查询（再添加时提醒沿用原价格）──
  if (url === '/api/admin/model-price-history' && method === 'GET') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const modelId = ((req.query && req.query.modelId) || '').toString().trim();
    if (!modelId) return sendJSON(res, 400, { error: 'modelId 必填' });
    try {
      const r = await pgPool.query('SELECT display_name, credit_cost, updated_at FROM model_price_history WHERE model_id=$1 ORDER BY updated_at DESC LIMIT 1', [modelId]);
      if (!r.rows.length) return sendJSON(res, 200, { found: false, modelId });
      const h = r.rows[0];
      return sendJSON(res, 200, { found: true, modelId, displayName: h.display_name, creditCost: Number(h.credit_cost) || 0, updatedAt: h.updated_at });
    } catch (e) {
      return sendJSON(res, 200, { found: false, modelId, error: e.message });
    }
  }
  // ── 智能路由尝试数据（generation_jobs / generation_attempts）后台只读查询 ──
  if (url === '/api/admin/routing/jobs' && method === 'GET') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    try {
      const u = new URL(req.url, 'http://localhost');
      const limit = Math.max(1, Math.min(200, Number(u.searchParams.get('limit')) || 50));
      const taskId = (u.searchParams.get('taskId') || '').trim();
      const status = (u.searchParams.get('status') || '').trim();
      const where = []; const params = []; let pi = 1;
      if (taskId) { where.push(`task_id=$${pi++}`); params.push(taskId); }
      if (status) { where.push(`status=$${pi++}`); params.push(status); }
      let jobsSql = 'SELECT * FROM generation_jobs';
      if (where.length) jobsSql += ' WHERE ' + where.join(' AND ');
      jobsSql += ` ORDER BY created_at DESC LIMIT $${pi}`; params.push(limit);
      const jr = await pgPool.query(jobsSql, params);
      const jobIds = jr.rows.map((r) => r.job_id);
      let attempts = [];
      if (jobIds.length) {
        const ar = await pgPool.query('SELECT * FROM generation_attempts WHERE job_id = ANY($1) ORDER BY job_id, attempt_no', [jobIds]);
        attempts = ar.rows;
      }
      return sendJSON(res, 200, { jobs: jr.rows.map(fromSnake), attempts: attempts.map(fromSnake) });
    } catch (e) {
      return sendJSON(res, 500, { error: '查询路由数据失败：' + (e?.message || e) });
    }
  }
  // ── 智能路由「决策解释」端点（Phase 3.4）：给定 model + contentType，返回确定性路由的完整决策 ──
  if (url === '/api/admin/routing/decide' && method === 'GET') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    try {
      const u = new URL(req.url, 'http://localhost');
      const model = (u.searchParams.get('model') || '').trim();
      const contentType = (u.searchParams.get('contentType') || '').trim() || undefined;
      const seedRaw = Number(u.searchParams.get('seed'));
      const seed = Number.isFinite(seedRaw) ? seedRaw : 1;
      if (!model) return sendJSON(res, 400, { error: 'model 必填' });
      // 1) 归一化 model → canonical model_id（与 generate 同一 resolver）
      const modelIds = await modelHubResolver.resolveModelIdentity(pgPool, model);
      if (!modelIds.length) {
        return sendJSON(res, 200, { model, resolved: false, resolvedIds: [], pairs: 0, chosen: null, ranking: [], rejected: [], note: '未解析到模型' });
      }
      // 2) 拉候选线路（已预过滤 enabled 绑定 + enabled 服务商 + 有效密钥）
      const pairs = await modelHubBindings.loadDispatchPairs(pgPool, modelIds, contentType);
      if (!pairs.length) {
        return sendJSON(res, 200, { model, resolvedIds: modelIds, pairs: 0, chosen: null, ranking: [], rejected: [], note: '无可用绑定/服务商' });
      }
      // 3) 跑确定性路由算法，返回 chosen + ranking + rejected + 权重 + 门控顺序（可解释）
      const tier = contentType === 'video' ? 'video' : '1k'; // 解释端点不感知分辨率，用默认档
      // 解释端点应反映后台当前配置的权重（settings.app.routingWeights），而非仅进程内 ROUTING_WEIGHTS，
      // 使「权重配置 UI」的改动可立即在解释面板看到；读取失败则退化为进程内权重（非阻断）。
      let explainWeights;
      try {
        const sr = await pgPool.query("SELECT value FROM settings WHERE key='app'");
        const sv = sr.rows[0] && sr.rows[0].value;
        if (sv && sv.routingWeights && typeof sv.routingWeights === 'object') explainWeights = sv.routingWeights;
      } catch {}
      const decision = await dispatcher.explainRouting(pairs, { pgPool, contentType, tier, seed, weights: explainWeights });
      return sendJSON(res, 200, {
        model, resolvedIds: modelIds, pairs: pairs.length,
        weights: decision.weights, gateOrder: decision.gateOrder,
        chosen: decision.chosen, ranking: decision.ranking, rejected: decision.rejected,
        metricsBindings: decision.metricsBindings, seed,
      });
    } catch (e) {
      return sendJSON(res, 500, { error: '路由决策失败：' + (e?.message || e) });
    }
  }
  // ── 模型参与度总览（密钥池 / 模型四态：已同步 / 已绑定 / 实际被调用 / 当前冷却熔断）──
  // 参与口径严格对齐 dispatcher.loadDispatchPairs (server/modules/modelhub/bindings.cjs)：
  //   参与 = 存在 enabled 绑定（或 legacy models.provider_id 回退）且对应服务商 enabled + api_key 有效（>=6 位）。
  //   冷却/熔断 = dispatcher.getAccountStates() 内存态（与 generate 同源），cold 或 cbState∈{OPEN,HALF_OPEN}。
  if (url === '/api/admin/model-participation' && method === 'GET') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    if (!pgPool) return sendJSON(res, 503, { error: '数据库不可用' });
    try {
      const u = new URL(req.url, 'http://localhost');
      const onlyProblems = u.searchParams.get('onlyProblems') === '1';
      const providerFilter = (u.searchParams.get('providerId') || '').trim();

      // 1) 实时账号状态（冷却/熔断）来自 dispatcher 内存态（ACCT），与 generate 同源
      const states = dispatcher.getAccountStates(); // pid -> {cold, manualState, cbState:{state,...}, cooldownUntil, ...}

      // 2) 服务商（密钥）基础信息 + 有效性（enabled && api_key.length>=6，对齐 bindings.cjs:106）
      const provRows = await pgPool.query('SELECT id, name, base_url, api_key, enabled, max_concurrent FROM providers ORDER BY created_at');
      const providers = provRows.rows.map((p) => {
        const st = states[p.id] || null;
        const cb = st && st.cbState ? st.cbState.state : 'CLOSED';
        const cooling = !!st && (st.cold || st.manualState === 'cold' || cb === 'OPEN' || cb === 'HALF_OPEN');
        const valid = p.enabled && p.api_key && p.api_key.length >= 6;
        return {
          providerId: p.id,
          name: p.name || '',
          baseUrl: p.base_url || '',
          keyMasked: p.api_key && p.api_key.length > 4 ? '***' + String(p.api_key).slice(-4) : '***',
          enabled: p.enabled,
          maxConcurrent: p.max_concurrent,
          validKey: valid,
          cold: st ? st.cold : null,
          manualState: st ? st.manualState : null,
          cbState: cb,
          cooldownUntil: st ? st.cooldownUntil : null,
          cooling,
        };
      });
      // 2.5) 每个服务商配置的 key 池规模（DB api_keys 为权威源；dispatcher.cjs 注释：DB 是成员与 status 的权威源）
      //      不受重启/内存态影响；AKEYS 运行时态仅作"已加载/熔断"补充。
      const keyRows = await pgPool.query(
        `SELECT provider_id,
                COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE status = 'active')::int AS active_n,
                COUNT(*) FILTER (WHERE status <> 'active')::int AS isolated_n
           FROM api_keys GROUP BY provider_id`
      );
      const keyStatsByProvider = {};
      for (const r of keyRows.rows) {
        keyStatsByProvider[r.provider_id] = { total: Number(r.n) || 0, active: Number(r.active_n) || 0, isolated: Number(r.isolated_n) || 0 };
      }
      const providerStateMap = {};
      for (const p of providers) providerStateMap[p.providerId] = p;
      const validProviderIds = new Set(providers.filter((p) => p.validKey).map((p) => p.providerId));

      // 3) 已同步模型（models 表）——按 model_id 聚合为「逻辑模型」；一行多 provider 属正常设计
      const modelRows = await pgPool.query('SELECT id, model_id, display_name, mapping_name, type, provider_id, enabled FROM models');
      // 4) 绑定（provider_model_bindings，仅 enabled）
      const bindRows = await pgPool.query('SELECT model_id, provider_id, enabled, id FROM provider_model_bindings');
      const boundByModel = {}; // model_id -> [providerId]
      for (const b of bindRows.rows) {
        if (!b.enabled) continue;
        (boundByModel[b.model_id] = boundByModel[b.model_id] || []).push(b.provider_id);
      }
      // 5) 近 24h 实际调用（generation_attempts）
      const attRows = await pgPool.query(
        `SELECT model_id, provider_id, COUNT(*)::int AS cnt,
                SUM(CASE WHEN status='success' THEN 1 ELSE 0 END)::int AS succ
           FROM generation_attempts
          WHERE created_at >= NOW() - INTERVAL '24 hours'
          GROUP BY model_id, provider_id`
      );
      const calledByModel = {};         // model_id -> {cnt, succ}
      const calledByModelProvider = {}; // "model_id|provider_id" -> {cnt, succ}
      for (const a of attRows.rows) {
        calledByModel[a.model_id] = calledByModel[a.model_id] || { cnt: 0, succ: 0 };
        calledByModel[a.model_id].cnt += Number(a.cnt) || 0;
        calledByModel[a.model_id].succ += Number(a.succ) || 0;
        calledByModelProvider[a.model_id + '|' + a.provider_id] = { cnt: Number(a.cnt) || 0, succ: Number(a.succ) || 0 };
      }

      // 6) 组装 per-model 行（按 model_id 聚合；参与口径对齐 loadDispatchPairs）
      //    models 表一行对应一个「模型×服务商」组合（dispatcher 按 model_id|provider_id 组合键去重），
      //    此处按 model_id 归并为逻辑模型，避免参与页面把同一模型渲染 100+ 次。
      const modelAgg = {}; // model_id -> { rows, hasMapping, enabledAny }
      for (const m of modelRows.rows) {
        const a = (modelAgg[m.model_id] = modelAgg[m.model_id] || { modelId: m.model_id, rows: [], hasMapping: false, enabledAny: false });
        a.rows.push(m);
        if (m.mapping_name) a.hasMapping = true;
        if (m.enabled) a.enabledAny = true;
      }
      const models = Object.values(modelAgg).map((a) => {
        const first = a.rows[0];
        const mappingRow = a.rows.find((r) => r.mapping_name) || first;
        const displayName = mappingRow.display_name || first.model_id;
        const mappingName = mappingRow.mapping_name || null;
        // 收集所有有效 legacy provider（enabled 行 + api_key 有效），而非仅取一行
        const legacyProviders = [];
        const seenLegacy = new Set();
        for (const r of a.rows) {
          if (r.enabled && r.provider_id && validProviderIds.has(r.provider_id) && !seenLegacy.has(r.provider_id)) {
            legacyProviders.push(r.provider_id); seenLegacy.add(r.provider_id);
          }
        }
        const bps = boundByModel[a.modelId] || [];
        const candidateProviders = [];
        const seen = new Set();
        for (const lp of legacyProviders) { if (!seen.has(lp)) { candidateProviders.push(lp); seen.add(lp); } }
        for (const bp of bps) { if (validProviderIds.has(bp) && !seen.has(bp)) { candidateProviders.push(bp); seen.add(bp); } }
        const participates = candidateProviders.length > 0;
        const called = calledByModel[a.modelId] || { cnt: 0, succ: 0 };
        // 并发容量维度：单线路 + 低并发 = 批量提交必崩（如 gpt-image-1）
        let totalConcurrency = 0; let unlimited = false;
        for (const cp of candidateProviders) {
          const mc = providerStateMap[cp] ? providerStateMap[cp].maxConcurrent : null;
          if (mc == null) unlimited = true; else totalConcurrency += Number(mc) || 0;
        }
        const poolSize = candidateProviders.length;
        const effectiveSlots = unlimited ? null : totalConcurrency;
        const lowCapacity = participates && (poolSize <= 1 && (effectiveSlots == null ? false : effectiveSlots <= 1));
        let cooling = false; const coolingProviders = [];
        for (const cp of candidateProviders) {
          const ps = providerStateMap[cp];
          if (ps && ps.cooling) { cooling = true; coolingProviders.push(cp); }
        }
        return {
          modelId: a.modelId,
          displayName,
          mappingName,
          type: first.type,
          enabled: a.enabledAny,
          synced: a.rows.some((r) => r.provider_id),   // 已同步到上游服务商
          bound: bps.length > 0,                        // 已绑定（enabled 绑定）
          boundProviders: bps,
          legacyProviders,
          participates,                                  // 实际可参与调度
          candidateProviders,
          poolSize,
          totalConcurrency: effectiveSlots,
          unlimited,
          lowCapacity,
          calledLast24h: called.cnt,
          successLast24h: called.succ,
          cooling,
          coolingProviders,
        };
      });

      // 7) 过滤器
      let filteredModels = models;
      if (providerFilter) filteredModels = filteredModels.filter((x) => (x.candidateProviders || []).includes(providerFilter));
      if (onlyProblems) filteredModels = filteredModels.filter((x) => !x.participates || x.cooling || x.lowCapacity);

      // 8) 服务商维度聚合（每个密钥承载的同步/绑定/调用 + 是否冷却）
      const provAgg = providers.map((p) => {
        let syncedModels = 0, boundModels = 0, servedModels = 0, called24h = 0;
        for (const m of models) {
          const isLegacy = (m.legacyProviders || []).includes(p.providerId);
          const isBound = (m.boundProviders || []).includes(p.providerId);
          if (!isLegacy && !isBound) continue;
          if (m.synced && isLegacy) syncedModels++;
          if (isBound) boundModels++;
          if ((m.candidateProviders || []).includes(p.providerId)) servedModels++;
          const cm = calledByModelProvider[m.model_id + '|' + p.providerId];
          if (cm) called24h += cm.cnt;
        }
        // 密钥池（墨池池）维度：DB api_keys 为权威池规模（配置总数/活跃/隔离，不受重启影响）；
        // AKEYS 为运行时态（与 generate 同源）：已加载 key 数 + 当前熔断(OPEN/HALF_OPEN) key 数。
        const dk = keyStatsByProvider[p.providerId] || { total: 0, active: 0, isolated: 0 };
        const rt = dispatcher.getKeyStates(p.providerId) || [];
        let rtActive = 0, rtIsolated = 0, rtCooling = 0;
        for (const ks of rt) {
          if (ks.status === 'active') rtActive++; else rtIsolated++;
          const cb = ks.cbState; // getKeyStates 返回字符串 CLOSED/OPEN/HALF_OPEN 或 null
          if (cb === 'OPEN' || cb === 'HALF_OPEN') rtCooling++;
        }
        return Object.assign({}, p, {
          syncedModels, boundModels, servedModels, called24h,
          poolSize: dk.total,
          activeKeys: dk.active,
          isolatedKeys: dk.isolated,
          runtimeLoaded: rt.length,
          coolingKeys: rtCooling,
        });
      });

      // 9.5) 为每个provider补充apiKeys详情（单独查询，避免N+1）
      const allKeyRows = await pgPool.query(
        `SELECT provider_id, id, api_key, label, status, weight, created_at FROM api_keys ORDER BY provider_id, created_at`
      );
      const apiKeysByProvider = {};
      for (const r of allKeyRows.rows) {
        if (!apiKeysByProvider[r.provider_id]) apiKeysByProvider[r.provider_id] = [];
        apiKeysByProvider[r.provider_id].push({
          id: r.id, label: r.label || 'key', status: r.status, weight: r.weight,
          masked: r.api_key ? '***' + r.api_key.slice(-4) : '***',
          createdAt: r.created_at,
        });
      }
      for (const p of providers) {
        p.apiKeys = apiKeysByProvider[p.providerId] || [];
      }

      // 9) 汇总
      const summary = {
        totalModels: models.length,
        syncedModels: models.filter((m) => m.synced).length,
        boundModels: models.filter((m) => m.bound).length,
        participatesModels: models.filter((m) => m.participates).length,
        calledModels24h: models.filter((m) => m.calledLast24h > 0).length,
        coolingModels: models.filter((m) => m.cooling).length,
        lowCapacityModels: models.filter((m) => m.lowCapacity).length,
        totalProviders: providers.length,
        validProviders: providers.filter((p) => p.validKey).length,
        coolingProviders: providers.filter((p) => p.cooling).length,
      };

      return sendJSON(res, 200, {
        summary,
        providers: onlyProblems ? provAgg.filter((p) => p.cooling) : provAgg,
        models: filteredModels,
      });
    } catch (e) {
      return sendJSON(res, 500, { error: '查询模型参与度失败：' + (e?.message || e) });
    }
  }
  if (url.startsWith('/api/admin/') && method !== 'OPTIONS') return admin.handleAdmin(req, res, url.split('?')[0], method);

  // ── 电商模块（AI 市集 / 技能注册表 / 试用台）── 命中即处理（内部自行鉴权：目录/商品公开，试用/获取/我的技能需登录）
  if ((url.startsWith('/api/shop/') || url.startsWith('/api/products/') || url.startsWith('/api/cart') || url.startsWith('/api/orders') || url.startsWith('/api/skills') || url.startsWith('/api/skill/')) && method !== 'OPTIONS') {
    if (await shop.handleShop(req, res, url.split('?')[0], method)) return;
  }

  // ── 充值订单 + DEV 支付适配器（M2 账务）── 命中即处理并返回 true
  if (payments.handlePayments(req, res, url, method)) return;

  const realUser = session.getUserFromCookie(req); // 真实用户身份（用于计费/owner）

  // ── 用户反馈（前端「发送应用反馈」表单落库）── 需登录（appGateway 已全局鉴权）
  if (url === '/api/feedback' && method === 'POST') {
    try {
      if (!realUser) return sendJSON(res, 401, { ok: false, error: '需要登录' });
      const body = await parseBody(req);
      if (!body || !body.content || !String(body.content).trim()) {
        return sendJSON(res, 400, { ok: false, error: '反馈内容不能为空' });
      }
      const id = 'fb-' + crypto.randomUUID();
      await pgPool.query(
        'INSERT INTO feedback (id, user_id, type, title, content, contact, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())',
        [id, realUser.id, body.type || 'other', String(body.title || '').slice(0, 200), String(body.content || '').slice(0, 8000), String(body.contact || '').slice(0, 200)]
      );
      return sendJSON(res, 200, { ok: true, id });
    } catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
  }

  // ── 用户举报（前端「举报法律问题」表单落库）── 需登录
  if (url === '/api/report' && method === 'POST') {
    try {
      if (!realUser) return sendJSON(res, 401, { ok: false, error: '需要登录' });
      const body = await parseBody(req);
      if (!body || !body.content || !String(body.content).trim()) {
        return sendJSON(res, 400, { ok: false, error: '举报描述不能为空' });
      }
      const id = 'rp-' + crypto.randomUUID();
      await pgPool.query(
        'INSERT INTO reports (id, user_id, type, target_url, content, evidence, contact, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())',
        [id, realUser.id, body.type || 'other', String(body.targetUrl || '').slice(0, 1000), String(body.content || '').slice(0, 8000), String(body.evidence || '').slice(0, 8000), String(body.contact || '').slice(0, 200)]
      );
      return sendJSON(res, 200, { ok: true, id });
    } catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
  }

  // ── 下载项目：导出当前用户全部素材为 JSON（仅元数据 + 外链，不含二进制文件）── 需登录
  if (url === '/api/export/my-media' && method === 'GET') {
    try {
      if (!realUser) return sendJSON(res, 401, { ok: false, error: '需要登录' });
      const r = await pgPool.query(
        'SELECT id, title, type, prompt, model, ratio, source, category, thumbnail, full_url, oss_url, status, file_size, created_at FROM media WHERE user_id=$1 AND is_deleted=FALSE ORDER BY created_at DESC',
        [realUser.id]
      );
      const items = r.rows.map(fromSnake);
      const exportObj = {
        app: 'manchuang',
        version: 1,
        exportedAt: new Date().toISOString(),
        userId: realUser.id,
        count: items.length,
        items,
      };
      const json = JSON.stringify(exportObj, null, 2);
      const b64 = Buffer.from(json, 'utf-8').toString('base64');
      const filename = `manchuang-export-${realUser.id}-${Date.now()}.json`;
      return sendJSON(res, 200, {
        ok: true,
        url: 'data:application/json;base64,' + b64,
        filename,
        count: items.length,
      });
    } catch (e) { return sendJSON(res, 500, { ok: false, error: e.message }); }
  }

  // ── Media ──
  // 同步预扫：探测前 16 张未标 failed 的图，限并发 4 + 3s 超时
  // 把失效的标 failed + errorMessage 写库，避免前端看到「检测链接…」灰色占位
  // （更深度的扫描由前端 useImageProbe 兜底）
  const PROBE_CONCURRENCY = 4;
  const PROBE_TIMEOUT_MS = 3000;
  const PROBE_BATCH = 16; // 同步预扫只覆盖最显眼的 16 张，避免 GET 卡死

  // 二次验证：HEAD 失败时用 GET range（0-1023 字节）重试
  // 原因：很多 CDN / 签名 URL（OSS、agne-ai、CloudFront 等）对 HEAD 不友好，
  //       实际浏览器 GET 200 的图，HEAD 可能返回 403/405/501 或干脆被网络层拦掉
  async function probeOneUrl(url, timeoutMs = PROBE_TIMEOUT_MS) {
    if (!url || typeof url !== 'string') return { ok: false, error: '链接为空' };
    if (url.startsWith('data:') || url.startsWith('blob:')) return { ok: true, skipWrite: true };
    // 本地自有资源（本服务的 /samples、/media 静态路由）视为可达，跳过探测；
    // 平台专有占位路径（/spark、/runtime 等）在本环境不可外网访问，标记为失败
    if (url.startsWith('/') && !url.startsWith('//')) {
      if (url.startsWith('/samples/') || url.startsWith('/media/')) return { ok: true, skipWrite: true };
      return { ok: false, error: '本地/平台专有路径（不可外网访问）' };
    }
    // 1) 先尝试 HEAD
    let headStatus = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(url, { method: 'HEAD', signal: controller.signal });
      clearTimeout(timer);
      if (resp.ok) return { ok: true };
      headStatus = resp.status;
      // HEAD 失败（任何 4xx/5xx）一律走 GET range 二次验证
      // 原因：OSS 签名 URL、agne-ai CDN、CloudFront 等常对 HEAD 返回 403/405/501，但 GET 实际能下
    } catch (e) {
      // HEAD 网络层失败（AbortError / 连接被拒）→ 走 GET 二次验证
      headStatus = 'NETWORK_ERR';
    }
    // 2) GET range 0-1024 二次验证（只读 1KB，省流量）
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const resp = await fetch(url, { method: 'GET', signal: controller.signal, headers: { Range: 'bytes=0-1024' } });
      clearTimeout(timer);
      if (resp.ok || resp.status === 206) return { ok: true };
      return { ok: false, error: `HTTP ${resp.status}（HEAD/GET 都失败）` };
    } catch (e) {
      return {
        ok: false,
        error: e.name === 'AbortError'
          ? `图片加载超时（${Math.round(timeoutMs / 1000)}s）`
          : `网络错误（HEAD=${headStatus}）`,
      };
    }
  }

  async function pMapLimit(arr, limit, iter) {
    const ret = new Array(arr.length);
    let i = 0;
    const workers = Array.from({ length: limit }, async () => {
      while (i < arr.length) {
        const idx = i++;
        ret[idx] = await iter(arr[idx], idx);
      }
    });
    await Promise.all(workers);
    return ret;
  }

  async function probeBatchAndMarkFailed(mediaList, pgPoolRef) {
    // 探测「实际用于展示的 URL」(ossUrl > fullUrl > thumbnail)，避免 thumbnail 为空但 fullUrl 有图时被误杀
    const pickUrl = (m) => m.ossUrl || m.fullUrl || m.thumbnail;
    const needsProbe = mediaList
      .filter((m) => m.status !== 'failed' && m.source !== 'default' && pickUrl(m))
      .slice(0, PROBE_BATCH);
    if (needsProbe.length === 0) return 0;
    const startedAt = Date.now();
    const probeResults = await pMapLimit(needsProbe, PROBE_CONCURRENCY, async (m) => ({
      id: m.id,
      url: pickUrl(m),
      ...(await probeOneUrl(pickUrl(m))),
    }));
    const failedIds = [];
    for (const pr of probeResults) {
      if (!pr || pr.skipWrite) continue;
      if (!pr.ok) {
        // 外部 http(s) 链接（OSS / 服务商原始链接）由浏览器侧 useImageProbe 判定显示，
        // 服务端探测极易误杀（HEAD 被 CDN 拦、出网受限、签名/Referer 校验、3s 超时等）；
        // 仅对「本地/平台专有死路径」等确定不可达的链接永久标失败。
        const isExternal = /^https?:\/\//i.test(pr.url || '');
        if (isExternal) continue;
        failedIds.push({ id: pr.id, error: pr.error });
        // 内存中直接修改，前端立即看到 failed 占位
        const target = mediaList.find((m) => m.id === pr.id);
        if (target) {
          target.status = 'failed';
          target.errorMessage = pr.error;
          target.failedAt = new Date().toISOString();
        }
      }
    }
    // 批量写库
    if (failedIds.length > 0 && pgPoolRef) {
      for (const f of failedIds) {
        await pgPoolRef.query(
          'UPDATE media SET status=$1, error_message=$2, failed_at=$3 WHERE id=$4',
          ['failed', f.error, new Date().toISOString(), f.id],
        );
      }
    }
    const elapsed = Date.now() - startedAt;
    console.log(`[Probe] 预扫 ${needsProbe.length} 张 → 标 ${failedIds.length} 张失败（${elapsed}ms）`);
    return failedIds.length;
  }

  if (url === '/api/media' && method === 'GET') {
    if (pgPool) {
      let mediaSql = 'SELECT * FROM media WHERE is_deleted=FALSE';
      const mediaParams = [];
      if (realUser) { mediaSql += ' AND (user_id=$1 OR user_id IS NULL)'; mediaParams.push(realUser.id); } // G2 owner 隔离；历史 NULL 行全员可见
      mediaSql += ' ORDER BY created_at DESC';
      const r = await pgPool.query(mediaSql, mediaParams);
      const list = r.rows.map(fromSnake);
      // 破图根治（成功即存 OSS 配套）：读路径按 oss_object_key 重签 GET URL。
      // 存量 oss_url 是上传时签发的 7 天预签名链，过期即 403 → 破图；此处每次读取重签
      // （纯 HMAC、无网络、不碰二进制，守"业务服务器零二进制"铁律），OSS 链接永久可用。
      try {
        const oss = await ossMod.loadOssConfigs(pgPool);
        const ac = oss.list.find((c) => c.id === oss.activeId);
        if (oss.enabled && ac) {
          const OSS_HOST = /aliyuncs\.com|myqcloud\.com/;
          const nowSec = Math.floor(Date.now() / 1000);
          for (const m of list) {
            if (!m.ossObjectKey) continue;
            // 仅当存储的签名链已过期 / 临期(<1 天)才重签；有效期内保持原 URL，
            // 避免每次读取都换签名导致 <img> 反复重载闪烁（破图观感）。
            const cur = (m.ossUrl && m.ossUrl.match(/Expires=(\d+)/)) || (m.ossUrl && m.ossUrl.match(/q-sign-time=(\d+)/)) || [];
            const exp = cur[1] ? +cur[1] : 0;
            if (exp && exp > nowSec + 24 * 3600) continue; // 还有 >1 天有效期，不动
            try {
              const fresh = ossMod.buildOssGetUrl(ac, m.ossObjectKey).getUrl;
              m.ossUrl = fresh;
              // thumbnail/fullUrl 若也是该 OSS 签名链，一并刷新（详情面板/查看器/下载用的是 fullUrl）
              if (m.thumbnail && OSS_HOST.test(m.thumbnail)) m.thumbnail = fresh;
              if (m.fullUrl && OSS_HOST.test(m.fullUrl)) m.fullUrl = fresh;
            } catch (_) { /* 单个重签失败保留原值 */ }
          }
        }
      } catch (_) { /* OSS 未配置则跳过重签，返回原值 */ }
      // 同步预扫：只阻塞这一批，超出部分由前端 useImageProbe 异步兜底
      await probeBatchAndMarkFailed(list, pgPool);
      return sendJSON(res, 200, list);
    }
    return sendJSON(res, 200, readJSON('media'));
  }
  // 媒体数量统计（按 type / category 分组，给侧边栏角标用）
  if (url === '/api/media/counts' && method === 'GET') {
    if (pgPool) {
      // 与 /api/media 列表一致：登录用户只统计「自己 + 公共(NULL)」，不泄露他人私有素材数量
      let countsWhere = 'NOT is_deleted';
      const countsParams = [];
      if (realUser) { countsWhere += ' AND (user_id=$1 OR user_id IS NULL)'; countsParams.push(realUser.id); }
      else { countsWhere += ' AND user_id IS NULL'; }
      const r = await pgPool.query(`
        SELECT
          COUNT(*) FILTER (WHERE type='image')                       AS image,
          COUNT(*) FILTER (WHERE type='video')                       AS video,
          COUNT(*) FILTER (WHERE category='character')               AS character,
          COUNT(*) FILTER (WHERE category='scene')                   AS scene,
          COUNT(*) FILTER (WHERE category='prop')                     AS prop,
          COUNT(*) FILTER (WHERE category='other')                    AS other,
          COUNT(*) FILTER (WHERE category='upload')                   AS upload,
          COUNT(*)                                                    AS total
        FROM media
        WHERE ${countsWhere}
      `, countsParams);
      const row = r.rows[0];
      return sendJSON(res, 200, {
        total: parseInt(row.total, 10) || 0,
        image: parseInt(row.image, 10) || 0,
        video: parseInt(row.video, 10) || 0,
        character: parseInt(row.character, 10) || 0,
        scene: parseInt(row.scene, 10) || 0,
        prop: parseInt(row.prop, 10) || 0,
        other: parseInt(row.other, 10) || 0,
        upload: parseInt(row.upload, 10) || 0,
      });
    }
    const list = readJSON('media').filter((m) => !m.isDeleted && !m.is_deleted);
    return sendJSON(res, 200, {
      total: list.length,
      image: list.filter((m) => m.type === 'image').length,
      video: list.filter((m) => m.type === 'video').length,
      character: list.filter((m) => m.category === 'character').length,
      scene: list.filter((m) => m.category === 'scene').length,
      prop: list.filter((m) => m.category === 'prop').length,
      other: list.filter((m) => m.category === 'other').length,
      upload: list.filter((m) => m.category === 'upload').length,
    });
  }
  if (url === '/api/media' && method === 'POST') {
    const items = await parseBody(req);
    if (!items) return sendJSON(res, 400, { error: 'Invalid JSON' });
    const arr = Array.isArray(items) ? items : [items];
    if (pgPool) {
      // OSS 命名空间隔离：加载 active 配置，用于校验 objectKey 归属 + 服务端重签下载 URL
      const oss = await ossMod.loadOssConfigs(pgPool);
      const activeCfg = oss.list.find(c => c.id === oss.activeId);
      for (const it of arr) {
        const s = toSnake(it);
        const ownerId = realUser ? realUser.id : null; // G2 owner 归属：登录用户写入自己的素材
        // ── OSS 命名空间隔离校验（防越权登记 / 防伪造下载 URL）──
        if (s.oss_object_key) {
          if (!realUser || !activeCfg || !oss.enabled) {
            return sendJSON(res, 403, { error: 'OSS 资产登记需登录且 OSS 已启用并配置' });
          }
          const ns = ossMod.userOssNamespace(activeCfg, realUser.id);
          if (!s.oss_object_key.startsWith(ns)) {
            ossLogger.warn('sign', `OSS 越权登记被拒：${s.oss_object_key} 不属于 ${ns}`, { userId: realUser.id });
            return sendJSON(res, 403, { error: 'OSS 对象键越权：不属于当前用户命名空间' });
          }
          // 服务端重签下载 URL：不信任客户端传来的 oss_url，杜绝伪造/过期链接
          try {
            const { getUrl } = ossMod.buildOssGetUrl(activeCfg, s.oss_object_key);
            s.oss_url = getUrl;
          } catch (e) {
            return sendJSON(res, 200, { success: false, message: `OSS 下载签名失败：${String(e.message || '').slice(0, 80)}` });
          }
        }
        // 防御性兜底：拒绝把无 URL 的占位项落库/覆盖（典型如 GenerationBar failed 占位）
        // 注意：oss_object_key 已在上方重签为 oss_url，所以此处判空包含 oss_url 即可
        if (!s.full_url && !s.thumbnail && !s.oss_url) {
          continue;
        }
        // 真实文件大小：前端已带则直接用；否则落库后由服务端异步回探（不受浏览器缓存/CORS 影响）
        const fileSize = (typeof it.fileSize === 'number' && it.fileSize > 0) ? it.fileSize : null;
        await pgPool.query(
          `INSERT INTO media (id,title,type,thumbnail,full_url,prompt,model,ratio,source,is_favorite,is_deleted,oss_url,oss_object_key,oss_uploaded,category,status,error_message,failed_at,file_size,created_at,user_id,character_id,reference_style_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,full_url=EXCLUDED.full_url,thumbnail=EXCLUDED.thumbnail,oss_url=EXCLUDED.oss_url,oss_object_key=EXCLUDED.oss_object_key,oss_uploaded=EXCLUDED.oss_uploaded,is_deleted=EXCLUDED.is_deleted,status=EXCLUDED.status,error_message=EXCLUDED.error_message,failed_at=EXCLUDED.failed_at,file_size=COALESCE(EXCLUDED.file_size, media.file_size),user_id=EXCLUDED.user_id,character_id=EXCLUDED.character_id,reference_style_id=EXCLUDED.reference_style_id`,
          [s.id, s.title, s.type, s.thumbnail, s.full_url, s.prompt, s.model, s.ratio, s.source, s.is_favorite || false, s.is_deleted || false, s.oss_url, s.oss_object_key, s.oss_uploaded || false, s.category || 'generated', s.status || 'success', s.error_message || '', s.failed_at || null, fileSize, s.created_at || new Date().toISOString(), ownerId, s.character_id || null, s.reference_style_id || null]
        );
        // 参考样式分成：客户用样式生图 → 返积分给设计者（奖励池）；幂等且不阻塞主链路
        const chargeCredits = Number(s.credit_cost) || 0;
        if (s.reference_style_id) {
          creditStyleDesigner(pgPool, { referenceStyleId: s.reference_style_id, customerId: ownerId, mediaId: s.id, chargeCredits }).catch(() => {});
        }
        // 异步回探真实字节数（仅当本次没有显式 fileSize 时）
        if (!fileSize) {
          const probeUrl = it.ossUrl || it.fullUrl || s.oss_url || s.full_url;
          if (probeUrl && !probeUrl.startsWith('/') && !probeUrl.startsWith('data:')) {
            enrichMediaFileSize(pgPool, s.id, probeUrl).catch(() => {});
          }
        }
      }
      return sendJSON(res, 200, { ok: true, count: arr.length });
    }
    const list = readJSON('media');
    for (const it of arr) { const idx = list.findIndex(m => m.id === it.id); if (idx >= 0) list[idx] = it; else list.push(it); }
    writeJSON('media', list);
    return sendJSON(res, 200, { ok: true, count: arr.length });
  }
  if (url.startsWith('/api/media/') && method === 'DELETE') {
    const id = url.split('/api/media/')[1];
    if (pgPool) {
      // 仅允许删除「自己的」素材：公共资产(user_id IS NULL)与他人的行受保护，不会被误删
      let deleted = 0;
      if (realUser) {
        const r = await pgPool.query('DELETE FROM media WHERE id=$1 AND user_id=$2', [id, realUser.id]);
        deleted = r.rowCount || 0;
      }
      return sendJSON(res, 200, { ok: true, deleted });
    }
    writeJSON('media', readJSON('media').filter(m => m.id !== id));
    return sendJSON(res, 200, { ok: true });
  }
  // 单条部分更新：用于探测失败后回写 status/errorMessage/failed_at
  // 安全加固：必须登录 + 仅能改自己的素材（admin 可改全部）；字段白名单禁止更新 user_id，杜绝 IDOR 把他人素材改成自己的
  if (url.startsWith('/api/media/') && method === 'PUT') {
    const id = url.split('/api/media/')[1];
    const body = await parseBody(req);
    if (!body || !id) return sendJSON(res, 400, { error: 'Invalid request' });
    if (!realUser) return sendJSON(res, 401, { error: '未登录' });
    if (pgPool) {
      const exist = await pgPool.query('SELECT user_id FROM media WHERE id=$1', [id]);
      if (exist.rows.length === 0) return sendJSON(res, 404, { error: '素材不存在' });
      const owner = exist.rows[0].user_id;
      if (owner !== realUser.id && realUser.role !== 'admin') {
        return sendJSON(res, 403, { error: '无权修改该素材' });
      }
      // 字段白名单：只允许更新业务字段，绝不许篡改 user_id 等归属字段（防偷素材）
      const ALLOWED = new Set([
        'title', 'status', 'error_message', 'failed_at', 'is_favorite', 'prompt',
        'ratio', 'model', 'category', 'thumbnail', 'full_url', 'oss_url',
        'oss_object_key', 'oss_uploaded', 'source', 'type',
        'is_default', 'default_key',
      ]);
      const s = toSnake(body);
      // ── OSS 命名空间隔离：非 admin 更新 objectKey 时校验归属 + 服务端重签下载 URL ──
      if (s.oss_object_key && realUser.role !== 'admin') {
        const oss = await ossMod.loadOssConfigs(pgPool);
        const ac = oss.list.find(c => c.id === oss.activeId);
        if (!ac || !oss.enabled) return sendJSON(res, 403, { error: 'OSS 未配置' });
        const ns = ossMod.userOssNamespace(ac, realUser.id);
        if (!s.oss_object_key.startsWith(ns)) {
          ossLogger.warn('sign', `OSS 越权更新被拒：${s.oss_object_key} 不属于 ${ns}`, { userId: realUser.id });
          return sendJSON(res, 403, { error: 'OSS 对象键越权：不属于当前用户命名空间' });
        }
        try {
          const { getUrl } = ossMod.buildOssGetUrl(ac, s.oss_object_key);
          s.oss_url = getUrl;
        } catch (e) {
          return sendJSON(res, 200, { success: false, message: `OSS 下载签名失败：${String(e.message || '').slice(0, 80)}` });
        }
      }
      const fields = [];
      const vals = [];
      let i = 1;
      for (const [k, v] of Object.entries(s)) {
        if (v === undefined || !ALLOWED.has(k)) continue;
        fields.push(`${k}=$${i}`);
        vals.push(v);
        i++;
      }
      if (fields.length === 0) return sendJSON(res, 200, { ok: true, noop: true });
      vals.push(id);
      await pgPool.query(`UPDATE media SET ${fields.join(',')} WHERE id=$${i}`, vals);

      // ── 管理员「设为示例」时同步到全局示例模板库 default_assets；取消时移除 ──
      // 示例库（/api/admin/samples）查询 default_assets，只有写入该表才会出现在后台示例列表。
      if (realUser.role === 'admin' && s.is_default !== undefined) {
        const sampleKey = s.default_key || `admin_${id}`;
        if (s.is_default) {
          const m = await pgPool.query(
            'SELECT title,type,thumbnail,full_url,prompt,model,ratio,category,tags FROM media WHERE id=$1',
            [id]
          );
          if (m.rows.length) {
            const row = m.rows[0];
            const tagsJson = Array.isArray(row.tags) ? JSON.stringify(row.tags) : (row.tags || '[]');
            await pgPool.query(
              `INSERT INTO default_assets (id,key,title,type,thumbnail,full_url,prompt,model,ratio,source,category,status,sort,tags)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'default',$10,'success',0,$11::jsonb)
               ON CONFLICT (key) DO UPDATE SET
                 title=EXCLUDED.title, type=EXCLUDED.type, thumbnail=EXCLUDED.thumbnail,
                 full_url=EXCLUDED.full_url, prompt=EXCLUDED.prompt, model=EXCLUDED.model,
                 ratio=EXCLUDED.ratio, category=EXCLUDED.category, tags=EXCLUDED.tags`,
              ['da-' + crypto.randomUUID(), sampleKey,
               row.title || '', row.type || 'image',
               row.thumbnail || row.full_url || '', row.full_url || row.thumbnail || '',
               row.prompt || '', row.model || '', row.ratio || '1:1',
               row.category || 'generated', tagsJson]
            );
          }
        } else {
          await pgPool.query('DELETE FROM default_assets WHERE key=$1', [sampleKey]);
        }
      }

      return sendJSON(res, 200, { ok: true });
    }
    // 非 PG 兜底（JSON 文件模式）
    const list = readJSON('media');
    const idx = list.findIndex(m => m.id === id);
    if (idx >= 0) {
      const ownerId = list[idx] && (list[idx].user_id || list[idx].userId);
      if (ownerId && ownerId !== realUser.id && realUser.role !== 'admin') {
        return sendJSON(res, 403, { error: '无权修改该素材' });
      }
      list[idx] = { ...list[idx], ...body };
      writeJSON('media', list);
    }
    return sendJSON(res, 200, { ok: true });
  }

  // ── 角色一致性系统：全局角色库（characters 表，无 user_id，全员共享的创作预设）──
  if (url === '/api/characters' && method === 'GET') {
    if (!realUser) return sendJSON(res, 401, { error: '未登录' });
    if (pgPool) {
      const r = await pgPool.query(
        `SELECT id, name, avatar_url, gender, age, tags, style, description, reference_images, base_model, source, created_at
         FROM characters ORDER BY created_at DESC`);
      return sendJSON(res, 200, r.rows.map(fromSnake));
    }
    return sendJSON(res, 200, readJSON('characters') || []);
  }
  if (url === '/api/characters' && method === 'POST') {
    if (!realUser) return sendJSON(res, 401, { error: '未登录' });
    const body = await parseBody(req);
    const arr = Array.isArray(body) ? body : [body];
    if (pgPool) {
      for (const it of arr) {
        const id = it.id || ('ch-' + crypto.randomUUID());
        const s = toSnake(it);
        await pgPool.query(
          `INSERT INTO characters (id, name, avatar_url, gender, age, tags, style, description, reference_images, base_model, source, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
           ON CONFLICT (id) DO UPDATE SET
             name=$2, avatar_url=$3, gender=$4, age=$5, tags=$6, style=$7,
             description=$8, reference_images=$9, base_model=$10, source=$11`,
          [id, s.name || '', s.avatar_url || '', s.gender || '', s.age || 0, s.tags || [], s.style || {},
           s.description || '', s.reference_images || [], s.base_model || '', s.source || 'user'],
        );
      }
      return sendJSON(res, 200, { ok: true, count: arr.length });
    }
    const list = readJSON('characters') || [];
    for (const it of arr) { const id = it.id || ('ch-' + crypto.randomUUID()); const idx = list.findIndex(x => x.id === id); const rec = { ...it, id }; if (idx >= 0) list[idx] = rec; else list.push(rec); }
    writeJSON('characters', list);
    return sendJSON(res, 200, { ok: true, count: arr.length });
  }
  // ── 角色删除（单条）：幂等 DELETE，关联素材保留（已生成作品不删），仅解绑 ──
  if (url.startsWith('/api/characters/') && method === 'DELETE') {
    if (!realUser) return sendJSON(res, 401, { error: '未登录' });
    const id = decodeURIComponent(url.split('/api/characters/')[1]);
    if (pgPool) {
      await pgPool.query('DELETE FROM characters WHERE id=$1', [id]);
      await pgPool.query('UPDATE media SET character_id=NULL WHERE character_id=$1', [id]);
    } else {
      const list = readJSON('characters') || [];
      writeJSON('characters', list.filter((c) => c.id !== id));
    }
    return sendJSON(res, 200, { ok: true });
  }
  // ── 角色生成统计（实时聚合 media，按当前用户归属，杜绝写死数字）──
  if (url.match(/^\/api\/characters\/.+\/stats$/) && method === 'GET') {
    if (!realUser) return sendJSON(res, 401, { error: '未登录' });
    const id = decodeURIComponent(url.slice(0, -'/stats'.length).split('/api/characters/')[1]);
    if (pgPool) {
      const r = await pgPool.query(
        `SELECT
           COUNT(*) FILTER (WHERE is_deleted=false) AS total,
           COUNT(*) FILTER (WHERE is_favorite=true AND is_deleted=false) AS fav
         FROM media WHERE character_id=$1 AND user_id=$2`,
        [id, realUser.id],
      );
      const row = r.rows[0] || { total: 0, fav: 0 };
      return sendJSON(res, 200, { totalGenerations: Number(row.total) || 0, favorites: Number(row.fav) || 0 });
    }
    return sendJSON(res, 200, { totalGenerations: 0, favorites: 0 });
  }

  // ── 创作工作室项目（M5 流水线 · Phase 4/5）──
  // GET /api/studio/projects  按 owner_id + updated_at 降序列出当前用户项目
  if (url === '/api/studio/projects' && method === 'GET') {
    if (!realUser) return sendJSON(res, 401, { error: '未登录' });
    if (pgPool) {
      const r = await pgPool.query(
        `SELECT * FROM studio_projects WHERE owner_id=$1 ORDER BY updated_at DESC`,
        [realUser.id],
      );
      return sendJSON(res, 200, r.rows.map(fromSnake));
    }
    return sendJSON(res, 200, []);
  }
  // POST /api/studio/projects  创建项目
  if (url === '/api/studio/projects' && method === 'POST') {
    if (!realUser) return sendJSON(res, 401, { error: '未登录' });
    const body = await parseBody(req);
    const s = toSnake(body);
    const id = 'proj-' + crypto.randomUUID();
    const title = String(s.title || '').trim().slice(0, 120) || '未命名项目';
    const type = ['story', 'commerce', 'custom'].includes(s.type) ? s.type : 'story';
    const status = ['planning', 'building', 'ready', 'live'].includes(s.status) ? s.status : 'planning';
    const currentStage = ['idea', 'script', 'storyboard', 'video', 'episode'].includes(s.current_stage) ? s.current_stage : 'idea';
    const description = String(s.description || '').slice(0, 2000);
    const coverUrl = String(s.cover_url || '').slice(0, 1000);
    const meta = typeof s.meta === 'object' && s.meta ? s.meta : {};
    if (pgPool) {
      await pgPool.query(
        `INSERT INTO studio_projects (id, owner_id, title, type, status, current_stage, description, cover_url, meta, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())`,
        [id, realUser.id, title, type, status, currentStage, description, coverUrl, JSON.stringify(meta)],
      );
      const r = await pgPool.query('SELECT * FROM studio_projects WHERE id=$1', [id]);
      return sendJSON(res, 200, { ok: true, project: fromSnake(r.rows[0]) });
    }
    return sendJSON(res, 200, { ok: true, project: { id, title, type, status, currentStage, description, coverUrl, meta, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
  }
  // GET /api/studio/projects/:id  单项目详情（仅所有者）
  if (url.match(/^\/api\/studio\/projects\/[^/]+$/) && method === 'GET') {
    if (!realUser) return sendJSON(res, 401, { error: '未登录' });
    const id = decodeURIComponent(url.split('/api/studio/projects/')[1]);
    if (pgPool) {
      const r = await pgPool.query('SELECT * FROM studio_projects WHERE id=$1 AND owner_id=$2', [id, realUser.id]);
      if (!r.rows[0]) return sendJSON(res, 404, { error: '项目不存在或无权限' });
      return sendJSON(res, 200, { project: fromSnake(r.rows[0]) });
    }
    return sendJSON(res, 404, { error: '项目不存在' });
  }
  // PATCH /api/studio/projects/:id  部分更新（仅所有者）
  if (url.match(/^\/api\/studio\/projects\/[^/]+$/) && method === 'PATCH') {
    if (!realUser) return sendJSON(res, 401, { error: '未登录' });
    const id = decodeURIComponent(url.split('/api/studio/projects/')[1]);
    const body = await parseBody(req);
    const s = toSnake(body);
    const allowed = { title: true, type: true, status: true, current_stage: true, description: true, cover_url: true, meta: true };
    const updates = {};
    for (const k of Object.keys(allowed)) {
      if (s[k] === undefined) continue;
      if (k === 'title') updates[k] = String(s[k] || '').trim().slice(0, 120) || '未命名项目';
      else if (k === 'description') updates[k] = String(s[k] || '').slice(0, 2000);
      else if (k === 'cover_url') updates[k] = String(s[k] || '').slice(0, 1000);
      else if (k === 'meta') updates[k] = JSON.stringify(s[k] || {});
      else if (k === 'type') updates[k] = ['story', 'commerce', 'custom'].includes(s[k]) ? s[k] : 'story';
      else if (k === 'status') updates[k] = ['planning', 'building', 'ready', 'live'].includes(s[k]) ? s[k] : 'planning';
      else if (k === 'current_stage') updates[k] = ['idea', 'script', 'storyboard', 'video', 'episode'].includes(s[k]) ? s[k] : 'idea';
    }
    const keys = Object.keys(updates);
    if (keys.length === 0) return sendJSON(res, 200, { ok: true, noop: true });
    const setFields = keys.map((k, idx) => `${k}=$${idx + 1}`);
    setFields.push('updated_at=NOW()');
    const idParam = keys.length + 1;
    const ownerParam = keys.length + 2;
    if (pgPool) {
      const r = await pgPool.query(
        `UPDATE studio_projects SET ${setFields.join(',')} WHERE id=$${idParam} AND owner_id=$${ownerParam} RETURNING *`,
        [...Object.values(updates), id, realUser.id],
      );
      if (!r.rows[0]) return sendJSON(res, 404, { error: '项目不存在或无权限' });
      return sendJSON(res, 200, { ok: true, project: fromSnake(r.rows[0]) });
    }
    return sendJSON(res, 200, { ok: true });
  }
  // DELETE /api/studio/projects/:id  删除项目（仅所有者，幂等）
  if (url.match(/^\/api\/studio\/projects\/[^/]+$/) && method === 'DELETE') {
    if (!realUser) return sendJSON(res, 401, { error: '未登录' });
    const id = decodeURIComponent(url.split('/api/studio/projects/')[1]);
    if (pgPool) {
      await pgPool.query('DELETE FROM studio_projects WHERE id=$1 AND owner_id=$2', [id, realUser.id]);
    }
    return sendJSON(res, 200, { ok: true });
  }

  // ── Providers ──
  // ── 代理下载图片（绕过浏览器 CORS）──
  // SECURITY: SSRF protection — require user auth, block private/internal IPs
  if (url === '/api/proxy-fetch' && method === 'POST') {
    const user = session.getUserFromCookie(req);
    if (!user) return sendJSON(res, 401, { error: '请先登录' });
    const body = await parseBody(req);
    if (!body?.imageUrl) return sendJSON(res, 400, { success: false, message: '缺少 imageUrl' });
    // SSRF check
    const { asyncCheckUrl } = require('./ssrf.cjs');
    const ssrf = await asyncCheckUrl(body.imageUrl);
    if (!ssrf.ok) return sendJSON(res, 400, { success: false, message: `URL 不安全：${ssrf.reason}` });
    try {
      const r = await fetch(body.imageUrl, {
        headers: body.headers || {},
        redirect: 'follow',
      });
      if (!r.ok) return sendJSON(res, 200, { success: false, message: `HTTP ${r.status}`, status: r.status });
      const arrayBuf = await r.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      return sendJSON(res, 200, {
        success: true,
        base64: buf.toString('base64'),
        contentType: r.headers.get('content-type') || 'image/jpeg',
        size: buf.length,
      });
    } catch (e) {
      return sendJSON(res, 200, { success: false, message: `代理失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  if (url === '/api/providers' && method === 'GET') {
    const maskKey = (p) => ({ ...p, apiKey: p.apiKey ? '***' + p.apiKey.slice(-4) : '' });
    if (pgPool) {
      const r = await pgPool.query('SELECT * FROM providers ORDER BY created_at');
      const list = r.rows.map(fromSnake).map(maskKey);
      // 附 apiKeys 供前端密钥池展示（与普通 providers 端点一致）
      try {
        const kr = await pgPool.query('SELECT provider_id, id, api_key, label, status, weight, created_at FROM api_keys ORDER BY provider_id, created_at');
        const byProv = {};
        for (const row of kr.rows) {
          if (!byProv[row.provider_id]) byProv[row.provider_id] = [];
          byProv[row.provider_id].push({
            id: row.id, provider_id: row.provider_id, masked: row.api_key ? '***' + row.api_key.slice(-4) : '***',
            label: row.label || 'key', status: row.status, weight: row.weight,
            createdAt: row.created_at,
          });
        }
        for (const p of list) p.apiKeys = byProv[p.id] || [];
      } catch { for (const p of list) if (!p.apiKeys) p.apiKeys = []; }
      return sendJSON(res, 200, list);
    }
    return sendJSON(res, 200, readJSON('providers').map(maskKey));
  }
  // ── POST /api/providers：单条创建（RESTful，不再是破坏性全量同步）──
  // 破坏性行为（删除列表外项）已移除：删除请走 DELETE /api/providers/:id。
  if (url === '/api/providers' && method === 'POST') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const body = await parseBody(req); if (!body || typeof body !== 'object') return sendJSON(res, 400, { error: 'Invalid JSON' });
    if (Array.isArray(body)) return sendJSON(res, 400, { error: 'POST /api/providers 仅支持单条创建；批量请逐条调用或改用 PATCH /api/providers/:id' });
    const s = toSnake(body);
    if (!s.id) return sendJSON(res, 400, { error: '缺少 id' });
    if (pgPool) {
      try {
        // 容量上限校验：设了 bucket_max 则 B 不得超过
        const rl = (s.rate_limits && typeof s.rate_limits === 'object') ? s.rate_limits : {};
        if (typeof rl.bucket_units_per_min === 'number' && s.bucket_max != null && rl.bucket_units_per_min > Number(s.bucket_max)) {
          return sendJSON(res, 400, { error: `B(${rl.bucket_units_per_min}) 超过粒度上限 bucket_max(${s.bucket_max})` });
        }
        // 安全：创建时若 api_key 是占位（含 '*' 或 <6 字符）则落空，不写入伪密钥
        let apiKey = s.api_key || '';
        if (apiKey.includes('*') || apiKey.length < 6) apiKey = '';
        const exists = await pgPool.query('SELECT id FROM providers WHERE id=$1', [s.id]);
        if (exists.rows[0]) return sendJSON(res, 409, { error: '服务商已存在', id: s.id });
        await pgPool.query(
          `INSERT INTO providers (id,name,type,base_url,api_key,supported_types,enabled,protocol,remark,default_endpoint,max_concurrent,rate_limits,capacity_model,bucket_max,cooldown_ms,revision,updated_at,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,1,NOW(),$16)`,
          [s.id, s.name, s.type, s.base_url, apiKey, s.supported_types || [], s.enabled !== false, s.protocol || 'openai-compatible', s.remark || '', JSON.stringify(s.default_endpoint || {}), Number(s.max_concurrent) || 2, JSON.stringify(s.rate_limits || {}), s.capacity_model || 'limited', s.bucket_max != null ? Number(s.bucket_max) : null, Number(s.cooldown_ms) || 60000, (realUser && realUser.id) || '']
        );
        return sendJSON(res, 201, { ok: true, id: s.id, revision: 1 });
      } catch (e) {
        console.error('[providers] POST 失败', e.message);
        return sendJSON(res, 400, { error: '创建失败：' + e.message });
      }
    }
    // 无 PG 时 JSON 兜底（本地开发）
    const list = readJSON('providers');
    if (list.some(p => p.id === s.id)) return sendJSON(res, 409, { error: '服务商已存在', id: s.id });
    list.push({ ...body, revision: 1, updatedAt: new Date().toISOString(), updatedBy: '' });
    writeJSON('providers', list);
    return sendJSON(res, 201, { ok: true, id: s.id, revision: 1 });
  }
  // ── PATCH /api/providers/:id：单条局部更新 + 乐观锁（revision 不匹配 → 409）──
  if (url.startsWith('/api/providers/') && method === 'PATCH') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    if (!realUser) return sendJSON(res, 401, { error: '未登录' });
    const id = url.split('/api/providers/')[1];
    const patch = await parseBody(req); if (!patch || typeof patch !== 'object') return sendJSON(res, 400, { error: 'Invalid JSON' });
    const expectedRevision = Number(patch.revision);
    if (!Number.isInteger(expectedRevision)) return sendJSON(res, 400, { error: '缺少或非整数 revision（乐观锁基线）' });
    if (!pgPool) return sendJSON(res, 501, { error: 'JSON 兜底模式不支持 PATCH' });
    // 字段白名单：snake 列名 → camel 前端字段名（仅这些列可被更新）
    const allowed = {
      name: 'name', type: 'type', base_url: 'baseUrl', api_key: 'apiKey',
      supported_types: 'supportedTypes', enabled: 'enabled', protocol: 'protocol',
      remark: 'remark', default_endpoint: 'defaultEndpoint', max_concurrent: 'maxConcurrent',
      rate_limits: 'rateLimits', capacity_model: 'capacityModel', bucket_max: 'bucketMax',
      cooldown_ms: 'cooldownMs',
    };
    const cols = []; const vals = [];
    for (const [col, camel] of Object.entries(allowed)) {
      if (!(camel in patch)) continue;
      let v = patch[camel];
      if (col === 'enabled') v = v !== false;
      else if (col === 'max_concurrent') v = (v == null || v === '') ? null : Math.max(0, Math.floor(Number(v)));
      else if (col === 'bucket_max') v = (v == null || v === '') ? null : Number(v);
      else if (col === 'cooldown_ms') v = (v == null || v === '') ? 60000 : Number(v);
      else if (col === 'supported_types') v = Array.isArray(v) ? v : (v ? [v] : []);
      else if (col === 'rate_limits') v = JSON.stringify((v && typeof v === 'object') ? v : {});
      else if (col === 'default_endpoint') v = JSON.stringify((v && typeof v === 'object') ? v : {});
      else if (col === 'api_key') v = String(v || '');
      else if (col === 'name') v = String(v || '');
      else if (col === 'type') v = String(v || 'official');
      else if (col === 'base_url') v = String(v || '');
      else if (col === 'protocol') v = String(v || 'openai-compatible');
      else if (col === 'remark') v = String(v || '');
      else if (col === 'capacity_model') v = String(v || 'limited');
      cols.push(col); vals.push(v);
    }
    // api_key 占位保护：传入 '*'/短串则沿用 DB 现有值（避免误覆盖真实密钥）
    if ('apiKey' in patch) {
      const ak = patch.apiKey || '';
      if (ak.includes('*') || ak.length < 6) {
        const ex = await pgPool.query('SELECT api_key FROM providers WHERE id=$1', [id]);
        if (ex.rows[0]?.api_key) { const idx = cols.lastIndexOf('api_key'); if (idx >= 0) vals[idx] = ex.rows[0].api_key; }
      }
    }
    // 容量上限校验（仅当本次改动涉及 B / bucket_max 时）
    if ('rateLimits' in patch || 'bucketMax' in patch) {
      const rl = (patch.rateLimits && typeof patch.rateLimits === 'object') ? patch.rateLimits : {};
      const bmax = ('bucketMax' in patch) ? Number(patch.bucketMax) : null;
      if (typeof rl.bucket_units_per_min === 'number' && bmax != null && rl.bucket_units_per_min > bmax) {
        return sendJSON(res, 400, { error: `B(${rl.bucket_units_per_min}) 超过粒度上限 bucket_max(${bmax})` });
      }
    }
    if (cols.length === 0) return sendJSON(res, 400, { error: '无可更新字段' });
    const r = await optimisticUpdate(pgPool, { table: 'providers', id, expectedRevision, columns: cols, values: vals, actor: realUser.id });
    if (r.status === 'notFound') return sendJSON(res, 404, { error: '服务商不存在' });
    if (r.status === 'conflict') return sendJSON(res, 409, { error: '数据已被其他管理员修改（revision 不匹配），请刷新后重试', currentRevision: r.currentRevision });
    const row = await pgPool.query('SELECT * FROM providers WHERE id=$1', [id]);
    if (!row.rows[0]) return sendJSON(res, 404, { error: '服务商不存在' });
    return sendJSON(res, 200, { ok: true, provider: fromSnake(row.rows[0]), revision: r.revision });
  }
  // 账号冷热状态快照（内存态，供管理面板展示 + 手动强切）
  if (url === '/api/providers/states' && method === 'GET') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    return sendJSON(res, 200, { states: dispatcher.getAccountStates() });
  }
  // 手动强切账号冷热：{ state:'hot'|'cold'|null, cooldownMs? }（持久化到 rate_limits.manual_state / cooldown_ms 列）
  if (url.match(/^\/api\/providers\/[^/]+\/cooldown$/) && method === 'POST') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const id = url.split('/api/providers/')[1].split('/')[0];
    const body = await parseBody(req); if (!body) return sendJSON(res, 400, { error: 'Invalid JSON' });
    const r = dispatcher.setManualState(id, body.state || null, Number(body.cooldownMs) || null, pgPool);
    return sendJSON(res, r.ok ? 200 : 400, r);
  }
  if (url.startsWith('/api/providers/') && method === 'DELETE') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const id = url.split('/api/providers/')[1];
    if (pgPool) { try { await pgPool.query('DELETE FROM models WHERE provider_id=$1', [id]); await pgPool.query('DELETE FROM providers WHERE id=$1', [id]); return sendJSON(res, 200, { ok: true }); } catch (e) { console.error('[providers] DELETE 失败', e.message); return sendJSON(res, 400, { error: '删除失败：' + e.message }); } }
    writeJSON('providers', readJSON('providers').filter(p => p.id !== id));
    return sendJSON(res, 200, { ok: true });
  }

  // ── API Key 池管理 ──
  // GET /api/providers/:id/keys - 列出key池
  if (url.startsWith('/api/providers/') && url.endsWith('/keys') && method === 'GET') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const id = url.split('/api/providers/')[1].split('/')[0];
    const rows = await pgPool.query('SELECT id, provider_id, api_key, label, status, weight, created_at FROM api_keys WHERE provider_id = $1 ORDER BY created_at', [id]);
    return sendJSON(res, 200, { keys: rows.rows.map(r => ({
      id: r.id, provider_id: r.provider_id, masked: r.api_key.length > 4 ? '***' + r.api_key.slice(-4) : '***',
      label: r.label, status: r.status, weight: r.weight, createdAt: r.created_at
    }))});
  }
  // POST /api/providers/:id/keys - 批量添加（支持 {apiKeys: string[]} 或 {keys: string}）
  if (url.startsWith('/api/providers/') && url.endsWith('/keys') && method === 'POST') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const id = url.split('/api/providers/')[1].split('/')[0];
    const body = await parseBody(req);
    if (!body) return sendJSON(res, 400, { error: 'Invalid JSON' });
    // 支持两种格式：{apiKeys: [...]} 或 {keys: "line1\nline2"}
    let lines = [];
    if (Array.isArray(body.apiKeys)) lines = body.apiKeys.filter(k => k && k.length >= 6);
    else if (typeof body.keys === 'string') lines = body.keys.trim().split(/\n/).map(s => s.trim()).filter(s => s.length >= 6);
    if (lines.length === 0) return sendJSON(res, 400, { error: '没有有效的 key（至少6位）' });
    let added = 0;
    for (const key of lines) {
      const keyId = require('crypto').randomUUID();
      try {
        await pgPool.query(`INSERT INTO api_keys (id, provider_id, api_key, label, status, weight, created_at) VALUES ($1, $2, $3, $4, 'active', 100, NOW()) ON CONFLICT (provider_id, api_key) DO NOTHING`, [keyId, id, key, 'user-key']);
        added++;
      } catch(e) { console.error('[keys] insert failed:', e.message); }
    }
    // Sync dispatcher
    const keys = await pgPool.query('SELECT id, provider_id, api_key, label, status, weight FROM api_keys WHERE provider_id = $1', [id]);
    dispatcher.syncKeyPool(id, keys.rows);
    console.log(`[keys] Added ${added} keys for provider ${id}, total: ${keys.rows.length}`);
    return sendJSON(res, 200, { ok: true, added, total: keys.rows.length });
  }
  // PATCH /api/providers/:id/keys/:keyId - 更新key状态/备注
  if (url.match(/^\/api\/providers\/[^\/]+\/keys\/[^\/]+$/) && method === 'PATCH') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const parts = url.split('/');
    const id = parts[3];
    const keyId = parts[5];
    const body = await parseBody(req);
    if (!body) return sendJSON(res, 400, { error: 'Invalid JSON' });
    const allowed = { status: 'status', label: 'label' };
    const cols = [], vals = [];
    for (const [col, key] of Object.entries(allowed)) {
      if (!(key in body)) continue;
      cols.push(col); vals.push(body[key]);
    }
    if (cols.length === 0) return sendJSON(res, 400, { error: '无可更新字段' });
    const setClause = cols.map((c, i) => `${c}=$${i+2}`).join(', ');
    await pgPool.query(`UPDATE api_keys SET ${setClause} WHERE id=$1 AND provider_id=$2`, [...vals, keyId, id]);
    // Sync dispatcher
    const keys = await pgPool.query('SELECT id, provider_id, api_key, label, status, weight FROM api_keys WHERE provider_id = $1', [id]);
    dispatcher.syncKeyPool(id, keys.rows);
    return sendJSON(res, 200, { ok: true });
  }
  // DELETE /api/providers/:id/keys/:keyId - 删除key
  if (url.match(/^\/api\/providers\/[^\/]+\/keys\/[^\/]+$/) && method === 'DELETE') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const parts = url.split('/');
    const id = parts[3];
    const keyId = parts[5];
    await pgPool.query('DELETE FROM api_keys WHERE id=$1 AND provider_id=$2', [keyId, id]);
    // Sync dispatcher
    const keys = await pgPool.query('SELECT id, provider_id, api_key, label, status, weight FROM api_keys WHERE provider_id = $1', [id]);
    dispatcher.syncKeyPool(id, keys.rows);
    console.log(`[keys] Deleted key ${keyId} from provider ${id}, remaining: ${keys.rows.length}`);
    return sendJSON(res, 200, { ok: true });
  }

  // ── 服务端生成分发（同模型多供应商动态均衡）──
  // POST /api/generate：异步模式（默认）。立即返回 taskId，前端轮询 /api/generate/status/:taskId 拿结果。
  if (url === '/api/generate' && method === 'POST') {
    // 生成限流（应用层，按 IP）：参数来自后台「系统设置 → 生成限流」，默认每 IP 60s 内 30 次
    const genRl = await resolveGenRateLimit();
    const rlGen = await rateLimit({ key: 'rl:gen:' + clientIp(req), limit: genRl.limit, windowSec: genRl.windowSec });
    if (!rlGen.allowed) {
      res.setHeader('Retry-After', String(rlGen.retryAfter));
      return sendJSON(res, 429, { error: '生成请求过于频繁，请稍后再试' });
    }
    if (!pgPool) return sendJSON(res, 200, { status: 'failed', error: '数据库不可用，无法分发生成任务' });
    const body = await parseBody(req);
    if (!body || (!body.model && !body.modelId) || !body.prompt) return sendJSON(res, 400, { error: '缺少 model 或 prompt' });
    // 身份：必须是真实登录用户（cookie 会话），否则无法归属计费/owner（G1/G2）
    if (!realUser) return sendJSON(res, 401, { error: '未登录' });
    // 幂等键（G4）：前端每次生成请求生成一个 UUID，重试复用，防止网络抖动双扣
    const idemKey = (body.idempotencyKey || '').toString().trim();
    if (!idemKey) return sendJSON(res, 400, { error: '缺少 idempotencyKey' });

    // 幂等：已存在同键任务？
    const ex = await pgPool.query(
      'SELECT task_id, status, cost FROM generation_tasks WHERE idempotency_key=$1', [idemKey]);
    if (ex.rows.length) {
      const row = ex.rows[0];
      if (row.status === 'failed') {
        // 失败的可复用同一键重试：先释放旧 held（按原池），再删行腾出唯一约束
        await billing.releaseCredits(pgPool, realUser.id, row.cost || 0, idemKey, row.cost_pool || 'recharge').catch(() => {});
        await pgPool.query('DELETE FROM generation_tasks WHERE idempotency_key=$1', [idemKey]);
      } else {
        // running/done：直接返回原 taskId，绝不重复 reserve（防双扣）
        return sendJSON(res, 200, {
          status: row.status === 'done' ? 'done' : 'pending',
          taskId: row.task_id, idempotent: true,
        });
      }
    }

    // 模型身份解析（Phase 1）：优先 modelId，回退 model（displayName / 遗留字符串）→ canonical model_id
    const rawModel = body.modelId || body.model;
    const resolvedIds = await modelHubResolver.resolveModelIdentity(pgPool, rawModel);
    if (resolvedIds.length === 0) {
      return sendJSON(res, 400, { status: 'failed', error: `未找到模型：${rawModel}` });
    }
    const canonicalModel = resolvedIds[0];

    // 成本解析（L5）：按 canonical model_id 查计费维度（充值价 + 是否支持奖励 + 奖励价），再解析实际扣费池
    // 价格走 accounting 双读链（model_pricing → history → models 回退），保证与价格页统一；奖励价也优先读 model_pricing。
    const priceInfo = await accounting.getModelPrice(pgPool, canonicalModel);
    const unitCreditCost = priceInfo.creditPrice;
    const unitRewardRequired = priceInfo.rewardPrice;
    // 图片按实际张数计费；视频固定 1。与 dispatcher 的 count 归一规则保持一致，防止 count=4 仍只扣单张价。
    const billingCount = (body.contentType || 'image') === 'video'
      ? 1
      : Math.max(1, Math.min(4, Number(body.count) || 1));
    const creditCost = unitCreditCost * billingCount;
    const rewardRequired = unitRewardRequired * billingCount;
    const costRes = await pgPool.query(
      'SELECT supports_reward_balance FROM models WHERE model_id=$1 LIMIT 1', [canonicalModel]);
    const mrow = costRes.rows[0];
    // 仅当显式支持奖励余额且奖励价大于 0 时才启用奖励池；否则按普通积分价从充值池扣。
    const supportsReward = mrow ? (mrow.supports_reward_balance === true || mrow.supports_reward_balance === 't' || mrow.supports_reward_balance === 'true') && rewardRequired > 0 : false;
    // 解析实际扣费池（奖励优先；不足回退充值；都不够拦截）。双池账务核心。
    let pay;
    try {
      pay = await billing.resolvePayment(pgPool, realUser.id, { supportsReward, rewardRequired, creditCost });
    } catch (e) {
      const code = (e && e.code) || 'NEED_RECHARGE';
      return sendJSON(res, 402, { status: 'failed', error: e.message || '余额不足', code });
    }
    const cost = pay.amount;

    // 套餐等级（供 dispatcher 等待区做会员优先调度；缺省 free）
    const planRes = await pgPool.query('SELECT plan FROM users WHERE id=$1', [realUser.id]);
    const userPlan = (planRes.rows[0] && planRes.rows[0].plan) || 'free';

    // reserve（G3 时序：仅在此扣，结算留给 dispatcher 后台回调）—— 扣到解析出的池
    try {
      await billing.reserveCredits(pgPool, realUser.id, cost, idemKey, pay.pool);
    } catch (e) {
      return sendJSON(res, 402, { status: 'failed', error: '余额不足', code: 'NEED_RECHARGE' });
    }

    const genOpts = {
      model: canonicalModel,                 // canonical model_id（dispatcher 优先据此路由）
      modelId: canonicalModel,               // 显式冗余，便于调试 / 下游消费
      displayModelName: body.model || rawModel, // 原始展示名（displayName 优先），落 generation_tasks.model 列供展示
      prompt: body.prompt,
      ratio: body.ratio || '1:1',
      resolution: body.resolution || '1k',
      count: body.count || 1,
      contentType: body.contentType || 'image',
      referenceImages: body.referenceImages || [],
      pendingIds: body.pendingIds || [],
      negative: (body.negative || '').toString().trim(),
      durationSec: Number(body.duration) || 6,
      videoMode: body.videoMode || undefined,
      user_id: realUser.id,
      idempotencyKey: idemKey,
      cost,
      costPool: pay.pool,
      userPlan,
      clientMeta: {
        ratio: body.ratio || '1:1',
        resolution: body.resolution || '1k',
        contentType: body.contentType || 'image',
        duration: Number(body.duration) || 6,
        negative: (body.negative || '').toString().trim(),
      },
    };
    // [Phase 1 主流化 已删] 原兼容 if (body.sync) 同步通道已废弃：
    //   - 旧注释「用于一次性同步测试/老客户端」已无任何调用方
    //   - 与全异步主流范式（done 回调里服务端最终化资产 + 前端 waitForTask + SSE）相悖
    //   - 维护双通道容易引发双写/双扣/单边结算等隐蔽 bug
    //   旧的 sync 路径曾在 commitCredits / recordConsumption 走自己的计费副本，
    //   现在唯一通道就是异步生成 + 前端轮询/SSE。

    // 异步：插入任务表，后台跑，前端轮询（完成回调里 commit/release + 服务端最终化）
    try {
      const { taskId, error } = await dispatcher.generateAsync(pgPool, genOpts);
      if (error) {
        await billing.releaseCredits(pgPool, realUser.id, cost, idemKey, pay.pool).catch(() => {});
        // CPU 自适应降级：dispatcher 检测到本 worker CPU 超阈值 → 返 503 + Retry-After（前端可重试）
        if (typeof error === 'string' && error.startsWith('CPU_OVERLOAD')) {
          res.setHeader('Retry-After', '5');
          return sendJSON(res, 503, { status: 'overloaded', error, retryAfterSec: 5 });
        }
        return sendJSON(res, 200, { status: 'failed', error });
      }
      // V2影子双写：默认关闭；开启后仅镜像任务结构，不执行V2 worker、不影响旧链路。
      // 失败必须隔离，旧任务已经接单成功，不能因影子链路回滚或向用户报错。
      await generationV2Shadow.writeShadowBatch(pgPool, {
        taskId,
        userId: realUser.id,
        idempotencyKey: idemKey,
        modelId: canonicalModel,
        contentType: body.contentType || 'image',
        count: billingCount,
        unitPrice: pay.pool === 'reward' ? unitRewardRequired : unitCreditCost,
        pool: pay.pool,
        requestPayload: genOpts,
      }).then((shadow) => {
        if (shadow.enabled && !shadow.written) console.warn('[generation-v2] shadow write failed:', shadow.error);
      }).catch((e) => console.warn('[generation-v2] shadow write exception:', e.message));
      return sendJSON(res, 200, { status: 'pending', taskId });
    } catch (e) {
      await billing.releaseCredits(pgPool, realUser.id, cost, idemKey, pay.pool).catch(() => {});
      return sendJSON(res, 200, { status: 'failed', error: `分发异常：${(e && e.message) || String(e)}` });
    }
  }

  // POST /api/generate/cancel/:taskId — 取消在途生成任务
  // 行为：释放 held 积分 + 停止轮询 + 标记 canceled + 推送 SSE canceled。终态（done/failed/canceled）不可取消。
  if (url.startsWith('/api/generate/cancel/') && method === 'POST') {
    if (!pgPool) return sendJSON(res, 503, { ok: false, error: '数据库不可用' });
    if (!realUser) return sendJSON(res, 401, { ok: false, error: '未登录' });
    const taskId = decodeURIComponent(url.slice('/api/generate/cancel/'.length));
    if (!taskId) return sendJSON(res, 400, { ok: false, error: '缺少 taskId' });
    const r = await dispatcher.cancelTask(pgPool, realUser.id, taskId);
    // r.code: 404 不存在 / 403 越权 / 409 已结束 / 500 内部 / 503 无 DB；ok:true 成功
    return sendJSON(res, r.ok ? 200 : (r.code || 400), r);
  }

  // GET /api/generate/status/:taskId — 查询单个任务状态
  if (url.startsWith('/api/generate/status/') && method === 'GET') {
    if (!pgPool) return sendJSON(res, 200, { status: 'unknown', error: '数据库不可用' });
    const taskId = decodeURIComponent(url.slice('/api/generate/status/'.length));
    const r = await dispatcher.getTaskStatus(pgPool, taskId);
    return sendJSON(res, 200, r);
  }

  // GET /api/generate/active — 列出在途任务（用于页面刷新后批量恢复）
  if (url === '/api/generate/active' && method === 'GET') {
    if (!pgPool) return sendJSON(res, 200, { tasks: [], error: '数据库不可用' });
    if (!realUser) return sendJSON(res, 401, { error: '未登录' });
    const r = await dispatcher.listActiveTasks(pgPool, realUser.id);
    return sendJSON(res, 200, r);
  }

  // GET /api/generate/stream — SSE 实时通道（主流异步生成做法）
  // 任务终态切换（done/waiting/failed）由 dispatcher.emitTaskUpdate 推送，替代前端固定 2s 轮询；
  // 连接即回灌在途快照，解决「刷新/连接前」漏事件。前端另有轮询兜底，SSE 异常不影响完成判定。
  if (url === '/api/generate/stream' && method === 'GET') {
    if (!realUser) return sendJSON(res, 401, { error: '未登录' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // 关闭反代缓冲，避免事件被攒批
    });
    res.write('retry: 3000\n\n'); // 断线后客户端（EventSource）自动重连间隔
    const unsub = realtime.subscribe(realUser.id, res);
    // 连接即回灌在途快照：字段形状对齐 getTaskStatus，前端无差别处理
    try {
      const snap = await realtime.snapshotActive(pgPool, realUser.id);
      for (const s of snap) res.write(`data: ${JSON.stringify(s)}\n\n`);
    } catch (_) { /* 快照失败不致命 */ }
    // 心跳：防止代理/中间件因空闲断开长连接
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20000);
    res.on('close', () => { clearInterval(hb); try { unsub(); } catch (_) {} });
    return; // 保持连接打开，不调用 sendJSON
  }

  // ── AI 提示词优化（智能体 skill：调后台启用的 text 类型推理模型）──
  if (url === '/api/agent/optimize-prompt' && method === 'POST') {
    if (!pgPool) return sendJSON(res, 200, { success: false, error: '数据库不可用' });
    const body = await parseBody(req);
    const userPrompt = ((body && body.prompt) || '').toString().trim();
    if (!userPrompt) return sendJSON(res, 200, { success: false, error: '提示词为空' });
    // targetLang: 'en'（英文，默认，生图引擎需要）| 'zh'（中文，用于国内工具/对照）| 'both'（中英都给，主填英文+展示中文对照）
    const targetLang = (body && body.targetLang) || 'en';
    let lastModel = null;
    let lastError = '';
    try {
      // 四层优先级选候选模型列表（统一由 agent-model-resolver 维护）：
      //  1) 后台显式指定 settings.app.promptOptimizeModel
      //  2) 智能体专属 agent_providers(agent_key='prompt_optimizer')
      //  3) 全局兜底模型 settings.app.fallbackModel
      //  4) 回退：所有启用的 type=text 模型（按成本排序）
      const candidates = await agentResolver.resolveTextCandidates(pgPool, 'prompt_optimizer', 'promptOptimizeModel');
      if (candidates.length === 0) {
        return sendJSON(res, 200, {
          success: false,
          code: 'NO_REASONING_MODEL',
          error: '未配置启用的文本推理模型，请到「模型 Hub」添加 type=text 的模型',
        });
      }

      // 提示词优化指令：融合《AI生图提示词优化全落地技能手册》方法论
      // 角色定位 + 四大黄金原则 + 8 段式万能结构 + 避坑红线 + 正负向搭配（刚需），
      // 并要求结构化输出 EN/ZH 两套正向+反向块，供前端按 targetLang 选择展示。
      const systemPrompt = [
        '你是一位顶级 AI 生图提示词优化专家，精通 Midjourney、Stable Diffusion、通义万相等所有主流生图模型的出图逻辑。',
        '你的任务：把用户给的（可能简短、粗糙、含抽象词的）初步描述，改写成精准、具象、可直接出图的结构化提示词，实现「所想即所得」。',
        '',
        '【核心原则】',
        '1) 具象化：彻底剔除“好看/高级/氛围感/治愈”等抽象形容词，全部替换为 AI 可识别的具象描述（如“低饱和莫兰迪色调”“浅景深虚化”“柔和逆光”）。',
        '2) 优先级：画面主体 > 环境场景 > 光影色彩 > 镜头构图 > 画质细节 > 风格定义；关键词顺序即权重，最重要的主体放最前。',
        '3) 紧扣原意：只扩展与强化用户意图，不凭空添加用户未提及的主体或场景。',
        '4) 正负向搭配（刚需）：必须同时给出正向提示词与反向提示词——反向词用于排除畸形、模糊、水印、多余元素等瑕疵。',
        '',
        '【8 段式结构（正向提示词逐段填充，无遗漏不冗余）】',
        '核心主体（唯一主角） + 细节特征（材质/动作/穿搭/神态） + 场景环境（具体地点背景） + 光线氛围（精准光影术语） + 镜头构图（视角/景深/取景） + 色彩色调（固定配色基调） + 画质参数（8K/超清/细节拉满） + 风格定义（写实摄影/插画等）',
        '',
        '【避坑红线】',
        '- 禁止堆砌超过约 18 个核心词（过多导致主体丢失、画面混乱）。',
        '- 禁止任何抽象形容词（高级、治愈、好看、氛围感——AI 无法精准识别）。',
        '- 禁止无构图无光影的随机描述（必须明确镜头与光线）。',
        '- 反向提示词必须针对 SD/通用生图模型语法（逗号分隔短语），剔除：watermark, text, logo, blurry, low quality, deformed, extra limbs, bad anatomy, mutated, duplicate。',
        '',
        '【输出要求——严格使用下方 4 个标记块，块外不要任何解释或前缀】',
        '无论用户原文是中文还是英文，都必须同时输出英文版与中文版（两者同义）：',
        '[EN_POSITIVE]',
        '<英文正向提示词：逗号分隔短语，60–160 词，主体优先，SD/通用生图语法>',
        '[/EN_POSITIVE]',
        '[EN_NEGATIVE]',
        '<英文反向提示词：逗号分隔短语，10–20 词，剔除常见瑕疵>',
        '[/EN_NEGATIVE]',
        '[ZH_POSITIVE]',
        '<中文正向提示词：逗号分隔短语，与英文同义，面向国内生图工具（通义万相/文心一格等）>',
        '[/ZH_POSITIVE]',
        '[ZH_NEGATIVE]',
        '<中文反向提示词：逗号分隔短语，与英文同义>',
        '[/ZH_NEGATIVE]',
        '若用户原文已是完整结构化提示词，则仅补短板（光影/构图/画质/风格/反向词），不做大改。',
      ].join('\n');

      // 顺序尝试候选模型，直到拿到非空提示词
      let successModel = null;
      let blocks = null;
      let usage = null;
      let rawSnapshots = [];
      for (const candidate of candidates.slice(0, 6)) {
        lastModel = candidate;
        const base = (candidate.base_url || '').trim().replace(/\/+$/, '');
        if (!base) { lastError = `模型 ${candidate.display_name || candidate.model_id} 未配置 base_url`; continue; }
        try {
          const r = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${candidate.api_key}` },
            body: JSON.stringify({
              model: candidate.model_id,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
              max_tokens: 2000,
              temperature: 0.7,
            }),
          });
          const raw = await r.text();
          if (!r.ok) {
            lastError = `模型 ${candidate.display_name || candidate.model_id} 返回 HTTP ${r.status}`;
            rawSnapshots.push({ model: candidate.model_id, status: r.status, snippet: raw.slice(0, 200) });
            continue;
          }
          let data; try { data = JSON.parse(raw); } catch {
            lastError = `模型 ${candidate.display_name || candidate.model_id} 返回非 JSON`;
            rawSnapshots.push({ model: candidate.model_id, status: r.status, snippet: raw.slice(0, 200) });
            continue;
          }
          const msg = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
          // 兼容深度思考模型：content 可能为空，正文/结构化块藏在 reasoning_content；两者拼接后提取
          const rawText = `${msg.content || ''}\n${msg.reasoning_content || ''}`.toString().trim();
          const b = extractPromptBlocks(rawText);
          if (!b) {
            lastError = `模型 ${candidate.display_name || candidate.model_id} 未返回结构化提示词`;
            rawSnapshots.push({ model: candidate.model_id, status: r.status, snippet: rawText.slice(0, 400) });
            continue;
          }
          blocks = b;
          successModel = candidate;
          usage = (data && data.usage) || null;
          break;
        } catch (e) {
          lastError = `模型 ${candidate.display_name || candidate.model_id} 调用异常：${e.message}`;
        }
      }

      if (!successModel || !blocks) {
        // 兜底：如果所有推理模型都失败，用简单规则把提示词拆成关键词串，保证可用（中文原文作对照）
        const fallback = buildFallbackPrompt(userPrompt);
        if (fallback) {
          console.warn('[agent/optimize-prompt] 所有推理模型失败，返回兜底翻译。最后错误:', lastError, 'snapshots:', JSON.stringify(rawSnapshots));
          return sendJSON(res, 200, {
            success: true,
            positive: fallback,
            negative: 'watermark, text, logo, blurry, low quality, distorted, extra limbs, deformed, mutated, bad anatomy, duplicate, signature',
            positiveZh: userPrompt,
            negativeZh: '水印, 文字, logo, 模糊, 低质量, 畸形, 多余肢体, 残缺, 比例失调, 重复元素',
            targetLang,
            modelUsed: '本地兜底翻译',
            providerId: '',
            usage: null,
            fallback: true,
            warning: '当前 AI 模型繁忙，已使用本地兜底翻译，建议稍后重试',
          });
        }
        console.error('[agent/optimize-prompt] 全部候选模型失败:', lastError, 'snapshots:', JSON.stringify(rawSnapshots));
        return sendJSON(res, 200, { success: false, error: `优化失败：${lastError || '所有推理模型均不可用'}` });
      }

      // 按 targetLang 选主语言（默认英文，生图引擎需要英文）；中文对照始终带回，前端按选择展示
      const primary = targetLang === 'zh'
        ? { pos: blocks.zhPos || blocks.enPos, neg: blocks.zhNeg || blocks.enNeg }
        : { pos: blocks.enPos || blocks.zhPos, neg: blocks.enNeg || blocks.zhNeg };

      // 双边记账：optimize-prompt 当前对客户免费（customerChargeCredits=0），后台成本照实记录 → 如实显示为平台成本
      try {
        await accounting.recordConsumption(pgPool, {
          scope: 'user', actorId: (realUser && realUser.id) || '', purpose: 'agent:optimize-prompt',
          providerId: successModel.p_id || '', modelId: successModel.model_id || '', modelType: 'text',
          inputUnits: usage && usage.prompt_tokens ? usage.prompt_tokens : 0,
          outputUnits: usage && usage.completion_tokens ? usage.completion_tokens : 0,
          customerChargeCredits: 0,
          idempotencyKey: `opt-${realUser ? realUser.id : 'anon'}-${Date.now()}`,
        });
      } catch (e) { console.warn('[accounting optimize-prompt]', e.message); }
      return sendJSON(res, 200, {
        success: true,
        positive: primary.pos,
        negative: primary.neg || '',
        positiveZh: blocks.zhPos || '',
        negativeZh: blocks.zhNeg || '',
        targetLang,
        modelUsed: successModel.display_name,
        providerId: successModel.p_id,
        usage,
      });
    } catch (e) {
      const cause = e && e.cause;
      const detail = cause ? ` (cause: ${cause.code || cause.name || ''} ${cause.message || ''})` : '';
      console.error('[agent/optimize-prompt] 异常:', e.message, detail, '\n  model:', lastModel && lastModel.model_id, 'base:', lastModel && lastModel.base_url);
      return sendJSON(res, 200, { success: false, error: `优化异常：${e.message}${detail}`.slice(0, 200) });
    }
  }

  // ── 纯翻译提示词智能体：把用户提示词按目标语言翻译（中↔英），不做优化改写 ──
  // 与 optimize-prompt 同套：三层候选模型 + 双边记账（走账）+ 鉴权。
  // 差异：optimize 是「改写增强」，translate 是「忠实翻译」(仅语言转换，不增删内容)。
  if (url === '/api/agent/translate-prompt' && method === 'POST') {
    if (!pgPool) return sendJSON(res, 200, { success: false, error: '数据库不可用' });
    // 鉴权：必须登录（"走扣费鉴权" —— 未登录一律拦截）
    if (!realUser) return sendJSON(res, 401, { success: false, error: '需要登录' });
    const body = await parseBody(req);
    const userPrompt = ((body && body.prompt) || '').toString().trim();
    if (!userPrompt) return sendJSON(res, 200, { success: false, error: '提示词为空' });
    // targetLang: 'en'（译英，默认，生图引擎需要）| 'zh'（译中，国内工具/对照）| 'both'（中英都给，主填英文）
    const targetLang = (body && body.targetLang) || 'en';
    let lastModel = null;
    let lastError = '';
    try {
      // 候选模型四层优先级（与 optimize-prompt 统一由 agent-model-resolver 维护）：
      //  1) 后台显式指定 settings.app.promptTranslateModel
      //  2) 智能体专属 agent_providers(agent_key='prompt_translator')
      //  3) 全局兜底模型 settings.app.fallbackModel
      //  4) 回退：所有启用的 type=text 模型（按成本排序）
      const candidates = await agentResolver.resolveTextCandidates(pgPool, 'prompt_translator', 'promptTranslateModel');
      if (candidates.length === 0) {
        return sendJSON(res, 200, {
          success: false,
          code: 'NO_REASONING_MODEL',
          error: '未配置启用的文本推理模型，请到「模型 Hub」添加 type=text 的模型',
        });
      }

      // 纯翻译指令：忠实语言转换，不做优化/改写；要求同时输出 [ZH]/[EN] 两个标记块
      const systemPrompt = [
        '你是一位专业的 AI 生图提示词翻译专家，精通中英文生图术语（Midjourney / Stable Diffusion / 通义万相等）。',
        '任务：把用户给的提示词，从原文语言精确翻译到目标语言，保持原意、术语、风格与逗号分隔短语结构，不做任何优化、扩充或改写。',
        '',
        '【规则】',
        '- 仅翻译，不增删内容；保留原有的主体、光影、构图、画质等全部关键词。',
        '- 若原文已是目标语言，原样返回，不要改写。',
        '- 直接输出翻译结果（逗号分隔短语），块外不要任何解释或前缀。',
        '',
        '【输出要求——严格使用下方 2 个标记块】',
        '无论用户原文是中文还是英文，都必须同时输出中文版与英文版（两者同义）：',
        '[ZH]',
        '<中文翻译：逗号分隔短语>',
        '[/ZH]',
        '[EN]',
        '<英文翻译：逗号分隔短语>',
        '[/EN]',
      ].join('\n');

      let successModel = null;
      let zh = '';
      let en = '';
      let usage = null;
      const parseBlock = (tag, txt) => {
        const m = txt.match(new RegExp(`\\[${tag}\\][\\s\\S]*?\\[\\/${tag}\\]`, 'i'));
        return m ? m[0].replace(new RegExp(`\\[\\/?${tag}\\]`, 'gi'), '').trim() : '';
      };
      for (const candidate of candidates.slice(0, 6)) {
        lastModel = candidate;
        const base = (candidate.base_url || '').trim().replace(/\/+$/, '');
        if (!base) { lastError = `模型 ${candidate.display_name || candidate.model_id} 未配置 base_url`; continue; }
        try {
          const r = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${candidate.api_key}` },
            body: JSON.stringify({
              model: candidate.model_id,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
              max_tokens: 2000,
              temperature: 0.3,
            }),
          });
          const raw = await r.text();
          if (!r.ok) {
            lastError = `模型 ${candidate.display_name || candidate.model_id} 返回 HTTP ${r.status}`;
            continue;
          }
          let data; try { data = JSON.parse(raw); } catch { lastError = `模型 ${candidate.display_name || candidate.model_id} 返回非 JSON`; continue; }
          const msg = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
          const rawText = `${msg.content || ''}\n${msg.reasoning_content || ''}`.toString().trim();
          const z = parseBlock('ZH', rawText);
          const e2 = parseBlock('EN', rawText);
          if (!z && !e2) {
            lastError = `模型 ${candidate.display_name || candidate.model_id} 未返回翻译块`;
            continue;
          }
          zh = z; en = e2;
          successModel = candidate;
          usage = (data && data.usage) || null;
          break;
        } catch (e) {
          lastError = `模型 ${candidate.display_name || candidate.model_id} 调用异常：${e.message}`;
        }
      }

      if (!successModel) {
        // 兜底：所有推理模型失败 → 原样返回原文（保证可用），标记 fallback
        console.warn('[agent/translate-prompt] 所有推理模型失败，原样返回原文。最后错误:', lastError);
        return sendJSON(res, 200, {
          success: true,
          text: userPrompt,
          textEn: /[\u4e00-\u9fa5]/.test(userPrompt) ? '' : userPrompt,
          textZh: /[\u4e00-\u9fa5]/.test(userPrompt) ? userPrompt : '',
          targetLang,
          modelUsed: '本地兜底',
          providerId: '',
          usage: null,
          fallback: true,
          warning: '当前 AI 模型繁忙，已原样返回原文，建议稍后重试',
        });
      }

      const text = targetLang === 'zh' ? (zh || userPrompt) : (en || userPrompt);
      try {
        await accounting.recordConsumption(pgPool, {
          scope: 'user', actorId: (realUser && realUser.id) || '', purpose: 'agent:translate-prompt',
          providerId: successModel.p_id || '', modelId: successModel.model_id || '', modelType: 'text',
          inputUnits: usage && usage.prompt_tokens ? usage.prompt_tokens : 0,
          outputUnits: usage && usage.completion_tokens ? usage.completion_tokens : 0,
          customerChargeCredits: 0,
          idempotencyKey: `tr-${realUser ? realUser.id : 'anon'}-${Date.now()}`,
        });
      } catch (e) { console.warn('[accounting translate-prompt]', e.message); }
      return sendJSON(res, 200, {
        success: true,
        text,
        textEn: en || '',
        textZh: zh || '',
        targetLang,
        modelUsed: successModel.display_name,
        providerId: successModel.p_id,
        usage,
      });
    } catch (e) {
      const cause = e && e.cause;
      const detail = cause ? ` (cause: ${cause.code || cause.name || ''} ${cause.message || ''})` : '';
      console.error('[agent/translate-prompt] 异常:', e.message, detail, '\n  model:', lastModel && lastModel.model_id, 'base:', lastModel && lastModel.base_url);
      return sendJSON(res, 200, { success: false, error: `翻译异常：${e.message}${detail}`.slice(0, 200) });
    }
  }

  // ── 同步服务商模型列表（后端代理，避免前端持有真实 Key）──
  if (url.match(/^\/api\/providers\/[^/]+\/sync$/) && method === 'POST') {
    const id = url.split('/')[3];
    if (!pgPool) return sendJSON(res, 200, { success: false, message: '数据库不可用' });
    const r = await pgPool.query('SELECT * FROM providers WHERE id=$1', [id]);
    const p = r.rows[0];
    if (!p) return sendJSON(res, 200, { success: false, message: '服务商不存在' });
    if (!p.api_key || p.api_key.length < 6) return sendJSON(res, 200, { success: false, message: '服务商未配置有效 API Key（请在编辑弹窗保存真实密钥）' });
    try {
      const base = (p.base_url || '').trim().replace(/\/+$/, '');
      const proto = p.protocol || 'openai-compatible';
      const defEp = p.default_endpoint || {};
      let models = [];
      if (proto === 'custom' && defEp.listModels) {
        const { status, body } = await dispatcher.callEndpoint(base, defEp.listModels, p.api_key, {});
        if (status >= 400) return sendJSON(res, 200, { success: false, message: `同步失败 HTTP ${status}` });
        const arr = dispatcher.getArrayByPath(body, defEp.listModels.listFieldPath || 'data');
        models = arr.map((m) => ({ id: String(dispatcher.getByPath(m, defEp.listModels.listIdFieldPath || 'id') || ''), name: String(dispatcher.getByPath(m, defEp.listModels.listNameFieldPath || 'name') || '') })).filter((m) => m.id);
      } else {
        const resp = await fetch(`${base}/models`, { method: 'GET', headers: { Authorization: `Bearer ${p.api_key}` } });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) return sendJSON(res, 200, { success: false, message: `同步失败 HTTP ${resp.status}` });
        const arr = Array.isArray(data && data.data) ? data.data : [];
        models = arr.map((m) => ({ id: String(m.id || ''), name: String(m.id || '') })).filter((m) => m.id);
      }
      return sendJSON(res, 200, { success: true, models });
    } catch (e) {
      return sendJSON(res, 200, { success: false, message: `同步异常：${(e && e.message) || String(e)}` });
    }
  }

  // ── 测试服务商端点（后端代理，避免前端持有真实 Key）──
  if (url.match(/^\/api\/providers\/[^/]+\/test-endpoint$/) && method === 'POST') {
    const id = url.split('/')[3];
    const body = await parseBody(req);
    if (!pgPool) return sendJSON(res, 200, { success: false, message: '数据库不可用' });
    const r = await pgPool.query('SELECT * FROM providers WHERE id=$1', [id]);
    const p = r.rows[0];
    if (!p) return sendJSON(res, 200, { success: false, message: '服务商不存在' });
    if (!p.api_key || p.api_key.length < 6) return sendJSON(res, 200, { success: false, message: '服务商未配置有效 API Key' });
    try {
      const ep = body && body.endpoint;
      if (!ep || !ep.path) return sendJSON(res, 200, { success: false, message: '缺少 endpoint 配置' });
      const { status, body: respBody } = await dispatcher.callEndpoint(p.base_url, ep, p.api_key, (body && body.vars) || {});
      return sendJSON(res, 200, { success: true, status, body: respBody });
    } catch (e) {
      return sendJSON(res, 200, { success: false, message: `测试异常：${(e && e.message) || String(e)}` });
    }
  }
  if (url.match(/^\/api\/providers\/[^/]+\/test-default$/) && method === 'POST') {
    const id = url.split('/')[3];
    const body = await parseBody(req);
    if (!pgPool) return sendJSON(res, 200, { success: false, message: '数据库不可用' });
    const r = await pgPool.query('SELECT * FROM providers WHERE id=$1', [id]);
    const p = r.rows[0];
    if (!p) return sendJSON(res, 200, { success: false, message: '服务商不存在' });
    if (!p.api_key || p.api_key.length < 6) return sendJSON(res, 200, { success: false, message: '服务商未配置有效 API Key' });
    try {
      const url2 = `${p.base_url.replace(/\/$/, '')}/chat/completions`;
      const resp = await fetch(url2, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.api_key}` }, body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: (body && body.testInput) || 'hi' }], max_tokens: 50 }) });
      const text = await resp.text();
      return sendJSON(res, 200, { success: true, status: resp.status, body: text.slice(0, 2000) });
    } catch (e) {
      return sendJSON(res, 200, { success: false, message: `测试异常：${(e && e.message) || String(e)}` });
    }
  }

  // ── 预览/列模型（未保存的服务商配置）：后端代理，避免前端持有真实 Key 直连服务商 ──
  // 用于「添加服务商」向导：管理员在表单填 baseUrl+apiKey，后端代为请求 /models（或自定义 listModels）。
  // 浏览器只把 key 发给本站后端（HTTPS），绝不直连服务商 —— 杜绝 Key 直连暴露 + 规避浏览器 CORS 限制。
  if (url === '/api/providers/preview-models' && method === 'POST') {
    if (!pgPool) return sendJSON(res, 200, { success: false, message: '数据库不可用' });
    if (!realUser) return sendJSON(res, 401, { success: false, message: '未登录' });
    const body = await parseBody(req);
    const baseUrl = String((body && body.baseUrl) || '').trim().replace(/\/+$/, '');
    const apiKey = String((body && body.apiKey) || '').trim();
    const protocol = (body && body.protocol) || 'openai-compatible';
    const listModels = body && body.listModels; // 自定义 listModels 端点（可选）
    if (!baseUrl) return sendJSON(res, 200, { success: false, message: '缺少 baseUrl' });
    if (!apiKey || apiKey.length < 6 || apiKey.includes('*')) return sendJSON(res, 200, { success: false, message: '缺少有效 API Key' });
    try {
      let models = [];
      if (protocol === 'custom' && listModels && listModels.path) {
        const { status, body: respBody } = await dispatcher.callEndpoint(baseUrl, listModels, apiKey, {});
        if (status >= 400) return sendJSON(res, 200, { success: false, message: `同步失败 HTTP ${status}` });
        const arr = dispatcher.getArrayByPath(respBody, listModels.listFieldPath || 'data');
        models = arr.map((m) => ({ id: String(dispatcher.getByPath(m, listModels.listIdFieldPath || 'id') || ''), name: String(dispatcher.getByPath(m, listModels.listNameFieldPath || 'name') || '') })).filter((m) => m.id);
      } else {
        const resp = await fetch(`${baseUrl}/models`, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) return sendJSON(res, 200, { success: false, message: `同步失败 HTTP ${resp.status}` });
        const arr = Array.isArray(data && data.data) ? data.data : [];
        models = arr.map((m) => ({ id: String(m.id || ''), name: String(m.id || '') })).filter((m) => m.id);
      }
      return sendJSON(res, 200, { success: true, models });
    } catch (e) {
      return sendJSON(res, 200, { success: false, message: `同步异常：${(e && e.message) || String(e)}` });
    }
  }

  // ── Models ──
  if (url === '/api/models' && method === 'GET') {
    if (pgPool) { const r = await pgPool.query('SELECT * FROM models ORDER BY sort_order ASC, created_at ASC'); return sendJSON(res, 200, r.rows.map(fromSnake)); }
    return sendJSON(res, 200, readJSON('models'));
  }
  // ── POST /api/models：单条创建（RESTful，不再是破坏性全量同步）──
  if (url === '/api/models' && method === 'POST') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const body = await parseBody(req); if (!body || typeof body !== 'object') return sendJSON(res, 400, { error: 'Invalid JSON' });
    if (Array.isArray(body)) return sendJSON(res, 400, { error: 'POST /api/models 仅支持单条创建；批量请逐条调用或改用 PATCH /api/models/:id' });
    const s = toSnake(body);
    if (!s.id) return sendJSON(res, 400, { error: '缺少 id' });
    if (pgPool) {
      try {
        const provRows = await pgPool.query('SELECT id FROM providers');
        const provIds = new Set((provRows.rows || []).map(r => r.id));
        // 外键容错：provider_id 必须引用已存在的服务商，否则置 NULL
        const pid = (s.provider_id && provIds.has(s.provider_id)) ? s.provider_id : null;
        // 奖励校验（仅当显式传入奖励相关字段时，与 PATCH 一致）
        const touchReward = ('supportsRewardBalance' in body) || ('rewardCreditsRequired' in body);
        const willSupportReward = ('supportsRewardBalance' in body) ? (body.supportsRewardBalance === true || body.supportsRewardBalance === 'true' || body.supportsRewardBalance === 1) : true;
        const rewardVal = ('rewardCreditsRequired' in body) ? Math.max(0, Math.floor(Number(body.rewardCreditsRequired) || 0)) : 0;
        if (touchReward && willSupportReward && rewardVal <= 0) {
          return sendJSON(res, 400, { error: '支持奖励余额的模型必须填写奖励积分（且需大于 0）' });
        }
        const exists = await pgPool.query('SELECT id FROM models WHERE id=$1', [s.id]);
        if (exists.rows[0]) return sendJSON(res, 409, { error: '模型已存在', id: s.id });
        const supportReward = (s.supports_reward_balance === true || s.supports_reward_balance === 'true') ? true : (s.supports_reward_balance === false || s.supports_reward_balance === 'false' ? false : true);
        const creditCost = Math.max(0, Number((Number(s.credit_cost) || 0).toFixed(4)));
        const rewardReq = (s.reward_credits_required != null && s.reward_credits_required !== '') ? Math.max(0, Number(Number(s.reward_credits_required).toFixed(4))) : creditCost;
        await pgPool.query(
          `INSERT INTO models (id,model_id,display_name,mapping_name,type,provider_id,enabled,supported_resolutions,capabilities,endpoint,param_template,credit_cost,supports_reward_balance,reward_credits_required,max_concurrent,estimated_seconds,category,commercial_use,creator,revision,updated_at,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,1,NOW(),$20)`,
          [s.id, s.model_id, s.display_name, s.mapping_name || '', s.type, pid, s.enabled !== false, s.supported_resolutions || [], JSON.stringify(s.capabilities || {}), JSON.stringify(s.endpoint || {}), JSON.stringify(s.param_template || {}), creditCost, supportReward, rewardReq, (s.max_concurrent == null ? null : Math.max(0, Math.floor(Number(s.max_concurrent)))), (s.estimated_seconds == null ? null : Math.max(0, Math.floor(Number(s.estimated_seconds)))), (s.category == null ? '' : String(s.category)), (s.commercial_use === true || s.commercial_use === 'true' ? true : (s.commercial_use === false || s.commercial_use === 'false' ? false : null)), (s.creator && typeof s.creator === 'object' ? JSON.stringify(s.creator) : (s.creator == null ? null : JSON.stringify(s.creator))), (realUser && realUser.id) || '']
        );
        // 同步写入 model_pricing 作为逻辑模型统一价；不支持奖励时 reward_price 置 0
        await accounting.upsertModelPrice(pgPool, { modelId: s.model_id, creditPrice: creditCost, rewardPrice: supportReward ? rewardReq : 0, currency: 'CNY' }).catch((e) => console.warn('[models] upsertModelPrice 失败', e.message));
        return sendJSON(res, 201, { ok: true, id: s.id, revision: 1 });
      } catch (e) {
        console.error('[models] POST 失败', e.message);
        return sendJSON(res, 400, { error: '创建失败：' + e.message });
      }
    }
    const list = readJSON('models');
    if (list.some(m => m.id === s.id)) return sendJSON(res, 409, { error: '模型已存在', id: s.id });
    list.push({ ...body, revision: 1, updatedAt: new Date().toISOString(), updatedBy: '' });
    writeJSON('models', list);
    return sendJSON(res, 201, { ok: true, id: s.id, revision: 1 });
  }
  // ── PATCH 单模型局部更新（admin）+ 乐观锁（revision 不匹配 → 409）──
  // 支持 enabled/creditCost/maxConcurrent/estimatedSeconds/category/commercialUse/creator/mappingName/displayName/type 任意子集
  if (url.startsWith('/api/models/') && method === 'PATCH') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    if (!realUser) return sendJSON(res, 401, { error: '未登录' });
    let id = url.split('/api/models/')[1];
    id = id.replace(/\/patch$/, '');
    const patch = await parseBody(req);
    if (!patch || typeof patch !== 'object') return sendJSON(res, 400, { error: 'Invalid JSON' });
    const expectedRevision = Number(patch.revision);
    if (!Number.isInteger(expectedRevision)) return sendJSON(res, 400, { error: '缺少或非整数 revision（乐观锁基线）' });
    // 字段白名单：snake 列名 → camel 前端字段名
    const allowed = {
      display_name: 'displayName', mapping_name: 'mappingName', type: 'type', enabled: 'enabled',
      credit_cost: 'creditCost', supports_reward_balance: 'supportsRewardBalance', reward_credits_required: 'rewardCreditsRequired',
      max_concurrent: 'maxConcurrent', estimated_seconds: 'estimatedSeconds',
      category: 'category', commercial_use: 'commercialUse', creator: 'creator',
      param_template: 'paramTemplate',
      sort_order: 'sortOrder',
    };
    if (!pgPool) return sendJSON(res, 501, { error: 'JSON 兜底模式不支持 PATCH' });
    try {
      // 先读现状，用于「必须填写奖励积分」的校验
      const exist = await pgPool.query('SELECT supports_reward_balance, reward_credits_required FROM models WHERE id=$1', [id]);
      if (!exist.rows[0]) return sendJSON(res, 404, { error: '模型不存在' });
      const cur = exist.rows[0];
      const cols = []; const vals = [];
      for (const [col, camel] of Object.entries(allowed)) {
        if (!(camel in patch)) continue;
        let v = patch[camel];
        if (col === 'enabled') v = v !== false;
        else if (col === 'credit_cost') v = Math.max(0, Number(Number(v).toFixed(4)) || 0);
        else if (col === 'supports_reward_balance') v = (v === true || v === 'true' || v === 1) ? true : (v === false || v === 'false' || v === 0 ? false : true);
        else if (col === 'reward_credits_required') v = (v == null || v === '' || Number.isNaN(Number(v))) ? 0 : Math.max(0, Number(Number(v).toFixed(4)));
        else if (col === 'max_concurrent') v = (v == null || v === '' || Number.isNaN(Number(v))) ? null : Math.max(0, Math.floor(Number(v)));
        else if (col === 'estimated_seconds') v = (v == null || v === '') ? null : Math.max(0, Math.floor(Number(v)));
        else if (col === 'commercial_use') v = (v === true || v === 'true' || v === 1) ? true : (v === false || v === 'false' || v === 0 ? false : null);
        else if (col === 'creator') v = (v == null ? null : JSON.stringify(typeof v === 'object' ? v : { name: String(v) }));
        else if (col === 'category') v = v == null ? '' : String(v);
        else if (col === 'mapping_name') v = v == null ? '' : String(v);
        else if (col === 'type') v = v == null ? 'image' : String(v);
        else if (col === 'display_name') v = String(v);
        else if (col === 'param_template') v = JSON.stringify((v && typeof v === 'object') ? v : (v == null ? {} : v));
        else if (col === 'sort_order') v = (v == null || v === '' || Number.isNaN(Number(v))) ? 0 : Math.floor(Number(v));
        cols.push(col); vals.push(v);
      }
      // 校验：仅当本次 patch 真正改动奖励余额相关字段时，才强制校验「支持奖励余额必须填写奖励积分(>0)」
      // 避免「纯改价 / 改显隐」等无关更新被既有奖励积分配置（seed 默认 supports_reward_balance=true 但 reward_credits_required=0）误拦截
      const touchReward = ('supportsRewardBalance' in patch) || ('rewardCreditsRequired' in patch);
      if (touchReward) {
        const willSupportReward = ('supportsRewardBalance' in patch) ? (patch.supportsRewardBalance === true || patch.supportsRewardBalance === 'true' || patch.supportsRewardBalance === 1) : (cur.supports_reward_balance === true || cur.supports_reward_balance === 't');
        const rewardVal = ('rewardCreditsRequired' in patch) ? Math.max(0, Number((Number(patch.rewardCreditsRequired) || 0).toFixed(4))) : Number(cur.reward_credits_required) || 0;
        if (willSupportReward && rewardVal <= 0) {
          return sendJSON(res, 400, { error: '支持奖励余额的模型必须填写奖励积分（且需大于 0）' });
        }
      }
      if (cols.length === 0) return sendJSON(res, 400, { error: '无可更新字段' });
      const r = await optimisticUpdate(pgPool, { table: 'models', id, expectedRevision, columns: cols, values: vals, actor: realUser.id });
      if (r.status === 'notFound') return sendJSON(res, 404, { error: '模型不存在' });
      if (r.status === 'conflict') return sendJSON(res, 409, { error: '数据已被其他管理员修改（revision 不匹配），请刷新后重试', currentRevision: r.currentRevision });
      // 价格/奖励变更归档：写入 model_price_history，并同步 model_pricing（逻辑模型统一用户价）
      const priceChanged = ('creditCost' in patch) || ('rewardCreditsRequired' in patch) || ('supportsRewardBalance' in patch);
      if (priceChanged) {
        const m = await pgPool.query('SELECT model_id, display_name FROM models WHERE id=$1', [id]);
        if (m.rows[0]) {
          const newCost = Math.max(0, Number((Number(patch.creditCost) || 0).toFixed(4)));
          const newReward = ('rewardCreditsRequired' in patch)
            ? Math.max(0, Number((Number(patch.rewardCreditsRequired) || 0).toFixed(4)))
            : Number(cur.reward_credits_required) || 0;
          const newSupport = ('supportsRewardBalance' in patch)
            ? (patch.supportsRewardBalance === true || patch.supportsRewardBalance === 'true' || patch.supportsRewardBalance === 1)
            : (cur.supports_reward_balance === true || cur.supports_reward_balance === 't');
          await pgPool.query(
            'INSERT INTO model_price_history (model_id, display_name, credit_cost) VALUES ($1,$2,$3)',
            [m.rows[0].model_id, m.rows[0].display_name || '', newCost]
          ).catch(() => {});
          // 同步写入 model_pricing：不支持奖励时 reward_price 置 0，避免生成链路误读
          await accounting.upsertModelPrice(pgPool, {
            modelId: m.rows[0].model_id,
            creditPrice: newCost,
            rewardPrice: newSupport ? newReward : 0,
            currency: 'CNY',
          }).catch((e) => console.warn('[models] upsertModelPrice 失败', e.message));
        }
      }
      const row = await pgPool.query('SELECT * FROM models WHERE id=$1', [id]);
      if (!row.rows[0]) return sendJSON(res, 404, { error: '模型不存在' });
      return sendJSON(res, 200, { ok: true, model: fromSnake(row.rows[0]), revision: r.revision });
    } catch (e) {
      console.error('[models] PATCH 失败', e.message);
      return sendJSON(res, 400, { error: '更新失败：' + e.message });
    }
  }

  // ── 模型批量更新（管理后台一键显隐 / 改价）：管理员专用，不走单条乐观锁，按 id 批量 SET ──
  if (url === '/api/models/batch' && method === 'POST') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    if (!realUser) return sendJSON(res, 401, { error: '未登录' });
    if (!pgPool) return sendJSON(res, 501, { error: 'JSON 兜底模式不支持批量' });
    const body = await parseBody(req);
    if (!body || typeof body !== 'object') return sendJSON(res, 400, { error: 'Invalid JSON' });
    const { ids, patch } = body;
    if (!Array.isArray(ids) || ids.length === 0) return sendJSON(res, 400, { error: 'ids 必须是含至少一个 id 的数组' });
    if (!patch || typeof patch !== 'object') return sendJSON(res, 400, { error: 'patch 必须是对象' });
    const allowed = {
      enabled: 'enabled',
      credit_cost: 'creditCost',
      reward_credits_required: 'rewardCreditsRequired',
    };
    const cols = [];
    const vals = [];
    let priceChanged = false;
    for (const [col, camel] of Object.entries(allowed)) {
      if (!(camel in patch)) continue;
      let v = patch[camel];
      if (col === 'enabled') v = v !== false;
      else if (col === 'credit_cost') { v = Math.max(0, Number(Number(v).toFixed(4)) || 0); priceChanged = true; }
      else if (col === 'reward_credits_required') v = Math.max(0, Number(Number(v).toFixed(4)) || 0);
      cols.push(col); vals.push(v);
    }
    if (cols.length === 0) return sendJSON(res, 400, { error: '无可更新字段' });
    try {
      const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const sql = `UPDATE models SET ${setClause}, revision = revision + 1, updated_at = NOW(), updated_by = $${cols.length + 1} WHERE id = ANY($${cols.length + 2})`;
      const params = [...vals, realUser.id, ids];
      const r = await pgPool.query(sql, params);
      if (priceChanged) {
        const mrows = await pgPool.query('SELECT id, model_id, display_name, credit_cost, reward_credits_required FROM models WHERE id = ANY($1)', [ids]);
        for (const m of mrows.rows) {
          const newCost = ('creditCost' in patch) ? Math.max(0, Number((Number(patch.creditCost) || 0).toFixed(4))) : Number(m.credit_cost) || 0;
          const newReward = ('rewardCreditsRequired' in patch) ? Math.max(0, Number((Number(patch.rewardCreditsRequired) || 0).toFixed(4))) : Number(m.reward_credits_required) || 0;
          await pgPool.query(
            'INSERT INTO model_price_history (model_id, display_name, credit_cost) VALUES ($1,$2,$3)',
            [m.model_id, m.display_name || '', newCost]
          ).catch(() => {});
          await accounting.upsertModelPrice(pgPool, {
            modelId: m.model_id,
            creditPrice: newCost,
            rewardPrice: newReward,
            currency: 'CNY',
          }).catch((e) => console.warn('[models] batch upsertModelPrice 失败', e.message));
        }
      }
      return sendJSON(res, 200, { ok: true, updated: r.rowCount });
    } catch (e) {
      console.error('[models] batch 失败', e.message);
      return sendJSON(res, 400, { error: '批量更新失败：' + e.message });
    }
  }

  if (url.startsWith('/api/models/') && method === 'DELETE') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const id = url.split('/api/models/')[1];
    if (pgPool) {
      try {
        // 删除前归档最后价格到 model_price_history（供再添加提醒沿用）
        const m = await pgPool.query('SELECT model_id, display_name, credit_cost FROM models WHERE id=$1', [id]);
        if (m.rows[0]) {
          await pgPool.query(
            'INSERT INTO model_price_history (model_id, display_name, credit_cost) VALUES ($1,$2,$3)',
            [m.rows[0].model_id, m.rows[0].display_name || '', Number(m.rows[0].credit_cost) || 0]
          ).catch(() => {});
        }
        await pgPool.query('DELETE FROM models WHERE id=$1', [id]);
        return sendJSON(res, 200, { ok: true });
      } catch (e) { console.error('[models] DELETE 失败', e.message); return sendJSON(res, 400, { error: '删除失败：' + e.message }); }
    }
    writeJSON('models', readJSON('models').filter(m => m.id !== id));
    return sendJSON(res, 200, { ok: true });
  }

  // ── Settings ──
  if (url === '/api/settings' && method === 'GET') {
    if (pgPool) { const r = await pgPool.query("SELECT value FROM settings WHERE key='app'"); return sendJSON(res, 200, (r.rows[0]?.value) || {}); }
    try { return sendJSON(res, 200, JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf-8'))); }
    catch { return sendJSON(res, 200, {}); }
  }
  if (url === '/api/settings' && method === 'PUT') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const data = await parseBody(req) || {};
    // 合并写入：只更新传入字段，保留 settings.app 中其它键（如 signupBonusCredits / maxThreads /
    // promptOptimizeModel），避免前端局部保存（生成默认参数等）整值覆盖把后台配置误删。
    if (pgPool) {
      const existing = (await pgPool.query("SELECT value FROM settings WHERE key='app'")).rows[0]?.value || {};
      const merged = { ...existing, ...data };
      await pgPool.query("INSERT INTO settings (key,value) VALUES ('app',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(merged)]);
      return sendJSON(res, 200, { ok: true });
    }
    let cur = {};
    try { cur = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf-8')); } catch {}
    writeJSON('settings', { ...cur, ...data });
    return sendJSON(res, 200, { ok: true });
  }

  // ── OSS 多槽位签名 / loadOssConfigs / diagnoseOssError / logger 已全部抽到 server/oss.cjs（Phase 1 主流化）
  //   此处仅保留路由分发，签名/上传调用走 ossMod.* ──
  const adminId = (req) => req.user?.id || req.user?.email || 'guest';

  // ── OSS 总览（enabled + active + configs 列表）── 仅限 admin ──
  if (url === '/api/oss' && method === 'GET') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const t0 = Date.now();
    const { enabled, activeId, list } = await ossMod.loadOssConfigs(pgPool);
    const active = list.find(c => c.id === activeId) || null;
    ossMod.log('info', 'list', `读取 OSS 总览：${list.length} 个槽位，活跃 ${active?.bucket || '无'}`, { durationMs: Date.now() - t0, slotCount: list.length, activeBucket: active?.bucket });
    return sendJSON(res, 200, {
      enabled,
      activeId,
      active,
      configs: list,
      // 兼容旧字段：把 active 当成"主配置"暴露（保持前端上一版兼容）
      provider: active?.providerType || 'aliyun-oss',
      bucket: active?.bucket || '',
      region: active?.region || '',
      regionLabel: active?.regionLabel || '',
      appId: active?.appId || '',
      accessKeyId: active?.accessKeyId || '',
      accessKeySecret: active?.accessKeySecret || '',
      endpointExternal: active?.endpointExternal || '',
      pathPrefix: active?.pathPrefix || 'images/',
      customDomain: active?.customDomain || '',
    });
  }

  // ── OSS 总开关 PUT ──
  if (url === '/api/oss' && method === 'PUT') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const body = await parseBody(req) || {};
    const next = body.enabled !== false;
    if (pgPool) {
      await pgPool.query("UPDATE oss_config SET enabled=$1 WHERE id=1", [next]);
    } else {
      const settings = readJSON('oss_settings') || {};
      settings.enabled = next;
      writeJSON('oss_settings', settings);
    }
    ossMod.log('success', 'toggle', `OSS 总开关 → ${next ? '开' : '关'}（操作员 ${adminId(req)}）`, { enabled: next });
    return sendJSON(res, 200, { ok: true });
  }

  // ── OSS 槽位 CRUD ──
  const cfgMatch = url.match(/^\/api\/oss\/configs\/([^/]+)$/);
  if (cfgMatch && method === 'PUT') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const id = decodeURIComponent(cfgMatch[1]);
    const body = await parseBody(req) || {};
    if (!body.providerType || !['aliyun-oss', 'tencent-cos'].includes(body.providerType)) {
      ossMod.log('warn', 'save', `保存槽位 ${id} 失败：providerType 非法`, { id });
      return sendJSON(res, 200, { ok: false, error: 'providerType 必须为 aliyun-oss 或 tencent-cos' });
    }
    const row = {
      id,
      providerType: body.providerType,
      displayName: body.displayName || '',
      bucket: body.bucket || '',
      region: body.region || '',
      regionLabel: body.regionLabel || '',
      appId: body.appId || '',
      accessKeyId: body.accessKeyId || '',
      accessKeySecret: body.accessKeySecret || '',
      endpointExternal: body.endpointExternal || '',
      pathPrefix: body.pathPrefix || 'images/',
      customDomain: body.customDomain || '',
      enabled: body.enabled !== false,
    };
    if (pgPool) {
      await pgPool.query(
        `INSERT INTO oss_configs (id, provider_type, display_name, bucket, region, region_label, app_id, access_key_id, access_key_secret, endpoint_external, path_prefix, custom_domain, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO UPDATE SET provider_type=EXCLUDED.provider_type, display_name=EXCLUDED.display_name, bucket=EXCLUDED.bucket, region=EXCLUDED.region, region_label=EXCLUDED.region_label, app_id=EXCLUDED.app_id, access_key_id=EXCLUDED.access_key_id, access_key_secret=EXCLUDED.access_key_secret, endpoint_external=EXCLUDED.endpoint_external, path_prefix=EXCLUDED.path_prefix, custom_domain=EXCLUDED.custom_domain, enabled=EXCLUDED.enabled`,
        [id, row.providerType, row.displayName, row.bucket, row.region, row.regionLabel, row.appId, row.accessKeyId, row.accessKeySecret, row.endpointExternal, row.pathPrefix, row.customDomain, row.enabled],
      );
    } else {
      const arr = Array.isArray(readJSON('oss_configs')) ? readJSON('oss_configs') : [];
      const idx = arr.findIndex(c => c.id === id);
      if (idx >= 0) arr[idx] = row; else arr.push(row);
      writeJSON('oss_configs', arr);
    }
    ossMod.log('success', 'save', `保存槽位 ${id}（${row.providerType}, bucket=${row.bucket}）`, { id, providerType: row.providerType, bucket: row.bucket, displayName: row.displayName });
    return sendJSON(res, 200, { ok: true, id });
  }
  if (cfgMatch && method === 'DELETE') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const id = decodeURIComponent(cfgMatch[1]);
    if (pgPool) {
      await pgPool.query('DELETE FROM oss_configs WHERE id=$1', [id]);
      await pgPool.query('UPDATE oss_config SET active_id=$1 WHERE id=1', ['']);
    } else {
      const arr = Array.isArray(readJSON('oss_configs')) ? readJSON('oss_configs') : [];
      writeJSON('oss_configs', arr.filter(c => c.id !== id));
    }
    ossMod.log('success', 'delete', `删除槽位 ${id}`, { id });
    return sendJSON(res, 200, { ok: true });
  }
  const newCfgMatch = url === '/api/oss/configs' && method === 'POST';
  if (newCfgMatch) {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const body = await parseBody(req) || {};
    const id = body.id || `oss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const row = { id, providerType: body.providerType || 'aliyun-oss', displayName: body.displayName || `新${body.providerType === 'tencent-cos' ? '腾讯云' : '阿里云'}账号`, bucket: body.bucket || '', region: body.region || '', regionLabel: body.regionLabel || '', appId: body.appId || '', accessKeyId: body.accessKeyId || '', accessKeySecret: body.accessKeySecret || '', endpointExternal: body.endpointExternal || '', pathPrefix: body.pathPrefix || 'images/', customDomain: body.customDomain || '', enabled: body.enabled !== false };
    if (pgPool) {
      await pgPool.query(
        `INSERT INTO oss_configs (id, provider_type, display_name, bucket, region, region_label, app_id, access_key_id, access_key_secret, endpoint_external, path_prefix, custom_domain, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [row.id, row.providerType, row.displayName, row.bucket, row.region, row.regionLabel, row.appId, row.accessKeyId, row.accessKeySecret, row.endpointExternal, row.pathPrefix, row.customDomain, row.enabled],
      );
    } else {
      const arr = Array.isArray(readJSON('oss_configs')) ? readJSON('oss_configs') : [];
      arr.push(row);
      writeJSON('oss_configs', arr);
    }
    ossMod.log('success', 'create', `创建槽位 ${id}（${row.providerType}）`, { id, providerType: row.providerType, displayName: row.displayName });
    return sendJSON(res, 200, { ok: true, ...row });
  }

  // ── 设为 active ──
  const actMatch = url.match(/^\/api\/oss\/configs\/([^/]+)\/activate$/);
  if (actMatch && method === 'POST') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const id = decodeURIComponent(actMatch[1]);
    const { list } = await ossMod.loadOssConfigs(pgPool);
    if (!list.find(c => c.id === id)) {
      ossMod.log('warn', 'activate', `切活失败：槽位 ${id} 不存在`, { id });
      return sendJSON(res, 200, { ok: false, error: '槽位不存在' });
    }
    if (pgPool) {
      await pgPool.query('UPDATE oss_config SET active_id=$1 WHERE id=1', [id]);
    } else {
      const settings = readJSON('oss_settings') || {};
      settings.activeId = id;
      writeJSON('oss_settings', settings);
    }
    ossMod.log('success', 'activate', `切活 → ${id}`, { id });
    return sendJSON(res, 200, { ok: true, activeId: id });
  }

  // ── OSS 测试（真探活：把 'a'-'a'-'a' 1KB 立即上传后立刻删；或仅做权限 HEAD）──
  // 阿里云 OSS 探活：通过 GetBucket (ListObjects 简化) 或 PutBucketLifecycle 试错。最轻量：
  //   HEAD / 一个不存在的 objectKey —— 401/403/404 都说明 AK 通了；200 → 说明有该 key（普通用户不会撞上）
  // 腾讯云 COS 探活：类似 HEAD / 桶
  const testMatch = url === '/api/oss/test' && method === 'POST';
  const cfgTestMatch = url.match(/^\/api\/oss\/configs\/([^/]+)\/test$/);
  let cfg = null;
  if (testMatch || cfgTestMatch) {
    const paramCfg = await parseBody(req) || {};
    if (testMatch && (cfgMatch || cfgTestMatch)) {/* not here */}
    let testSlotId = null;
    if (testMatch) {
      if (!paramCfg?.accessKeyId || !paramCfg?.accessKeySecret || !paramCfg?.bucket) {
        ossMod.log('warn', 'test', '试连失败：AccessKey/AccessKeySecret/Bucket 不能为空', { providerType: paramCfg.providerType });
        return sendJSON(res, 200, { success: false, message: 'AccessKey/AccessKeySecret/Bucket 不能为空' });
      }
      cfg = { providerType: paramCfg.providerType || 'aliyun-oss', bucket: paramCfg.bucket, region: paramCfg.region, appId: paramCfg.appId, accessKeyId: paramCfg.accessKeyId, accessKeySecret: paramCfg.accessKeySecret, endpointExternal: paramCfg.endpointExternal };
    } else {
      if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
      testSlotId = decodeURIComponent(cfgTestMatch[1]);
      const { list } = await ossMod.loadOssConfigs(pgPool);
      cfg = list.find(c => c.id === testSlotId);
      if (!cfg) {
        ossMod.log('warn', 'test', `试连失败：槽位 ${testSlotId} 不存在`, { id: testSlotId });
        return sendJSON(res, 200, { success: false, message: '槽位不存在' });
      }
    }
    const t0 = Date.now();
    try {
      let url2put, headers;
      if (cfg.providerType === 'tencent-cos') {
        cfg._hostName = `${cfg.bucket}${cfg.appId ? '-' + cfg.appId : ''}.cos.${cfg.region || 'ap-shanghai'}.myqcloud.com`;
        url2put = `https://${cfg._hostName}/__probe_${Date.now()}`;
        const h = ossMod.tencentCosPutHeaders(cfg, `__probe_${Date.now()}.bin`, Buffer.alloc(1), 'application/octet-stream');
        headers = h.headers;
      } else {
        const host = cfg.endpointExternal?.includes(cfg.bucket) ? cfg.endpointExternal : `${cfg.bucket}.${cfg.endpointExternal}`;
        url2put = `https://${host}/__probe_${Date.now()}`;
        const h = ossMod.aliyunPutHeaders(cfg, `__probe_${Date.now()}`, Buffer.alloc(1), 'application/octet-stream');
        headers = h.headers;
      }
      const r = await fetch(url2put, { method: 'PUT', headers, body: Buffer.alloc(1) });
      const dur = Date.now() - t0;
      // 200 = 写到了；403/401/400 = 鉴权/权限错，但说明能连上；404 = 不该发生的；200 + 403 各自含义不同
      if (r.status === 200) {
        ossMod.log('success', 'test', `试连成功：${cfg.providerType} ${cfg.bucket}（${dur}ms）`, { id: testSlotId, providerType: cfg.providerType, bucket: cfg.bucket, status: 200, durationMs: dur });
        return sendJSON(res, 200, { success: true, message: `连接成功，${cfg.providerType} Bucket "${cfg.bucket}" 可写`, status: 200 });
      }
      const msg = ossMod.diagnoseOssError(cfg.providerType, r.status, await r.text());
      ossMod.log('error', 'test', `试连失败：${cfg.providerType} ${cfg.bucket} → HTTP ${r.status}`, { id: testSlotId, providerType: cfg.providerType, bucket: cfg.bucket, status: r.status, durationMs: dur, error: msg });
      if (r.status === 403) return sendJSON(res, 200, { success: false, message: msg, status: 403 });
      if (r.status === 404) return sendJSON(res, 200, { success: false, message: msg, status: 404 });
      return sendJSON(res, 200, { success: false, message: msg, status: r.status });
    } catch (e) {
      const msg = `网络异常：${e.message.slice(0, 100)}`;
      ossMod.log('error', 'test', `试连异常：${cfg.providerType} ${cfg.bucket}`, { id: testSlotId, providerType: cfg.providerType, bucket: cfg.bucket, error: msg });
      return sendJSON(res, 200, { success: false, message: msg });
    }
  }

  // ── OSS 预签名直传（后端零字节：只鉴权 + 锁 userId 前缀 + 签发 PUT/GET 预签名） ──
  // 浏览器拿到 putUrl 后直接 fetch PUT 到 OSS；getUrl 是 7 天有效访问签名。
  if (url === '/api/oss/sign-upload' && method === 'POST') {
    const t0 = Date.now();
    const body = await parseBody(req);
    const { enabled, activeId, list } = await ossMod.loadOssConfigs(pgPool);
    if (!enabled) {
      ossMod.log('warn', 'sign', '签发失败：OSS 总开关未启用', { userId: req.user?.id });
      return sendJSON(res, 200, { success: false, message: 'OSS 总开关未启用' });
    }
    const activeCfg = list.find(c => c.id === activeId);
    if (!activeCfg) {
      ossMod.log('warn', 'sign', '签发失败：未配置 active OSS 槽位', { userId: req.user?.id });
      return sendJSON(res, 200, { success: false, message: '未配置 active OSS 槽位' });
    }
    if (!activeCfg.enabled) {
      ossMod.log('warn', 'sign', '签发失败：active OSS 槽位已停用', { userId: req.user?.id, activeId });
      return sendJSON(res, 200, { success: false, message: 'active OSS 槽位已停用' });
    }
    if (!activeCfg.accessKeyId || !activeCfg.accessKeySecret || !activeCfg.bucket) {
      ossMod.log('warn', 'sign', '签发失败：active 配置不完整（缺 AccessKey 或 Bucket）', { userId: req.user?.id, activeId });
      return sendJSON(res, 200, { success: false, message: 'active 配置不完整（缺 AccessKey 或 Bucket）' });
    }
    // 锁前缀：images/{userId}/，防止越权写他人目录
    // 防御：appGateway 已全局鉴权（line 983），此处再显式拦截，杜绝落入共享命名空间
    const userId = req.user?.id;
    if (!userId) return sendJSON(res, 401, { success: false, message: '请先登录后再上传' });
    const p = (activeCfg.pathPrefix || 'images/').replace(/^\/+|\/+$/g, '');
    const rawName = (body?.fileName || 'file').includes('/') ? body.fileName.split('/').pop() : body.fileName;
    const safeName = String(rawName || 'file').replace(/[^A-Za-z0-9._-]/g, '_');
    const objectKey = `${p}/${userId}/${Date.now()}_${safeName}`;
    const contentType = body?.contentType || 'image/jpeg';
    const providerTag = activeCfg.providerType === 'tencent-cos' ? 'COS' : 'OSS';

    try {
      let signed;
      if (activeCfg.providerType === 'tencent-cos') {
        cfg = { ...activeCfg };
        cfg._hostName = `${cfg.bucket}${cfg.appId ? '-' + cfg.appId : ''}.cos.${cfg.region || 'ap-shanghai'}.myqcloud.com`;
        signed = ossMod.tencentCosPutSignUrl(cfg, objectKey, contentType);
      } else {
        signed = ossMod.aliyunPutSignUrl(activeCfg, objectKey, contentType);
      }
      const dur = Date.now() - t0;
      ossMod.log('success', 'sign', `[${providerTag}] 🔏 签发直传 ${objectKey} → PUT 1h / GET 7d（${dur}ms）`, {
        userId,
        providerType: activeCfg.providerType,
        bucket: activeCfg.bucket,
        objectKey,
        fileName: body?.fileName,
        contentType,
        putExpires: signed.putExpires,
        expires: signed.expires,
        durationMs: dur,
      });
      return sendJSON(res, 200, {
        success: true,
        objectKey,
        putUrl: signed.putUrl,
        getUrl: signed.getUrl,
        putExpires: signed.putExpires,
        expires: signed.expires,
        providerType: activeCfg.providerType,
      });
    } catch (e) {
      const msg = `签名签发失败：${e.message.slice(0, 100)}`;
      ossMod.log('error', 'sign', `签发异常：${activeCfg.providerType} ${activeCfg.bucket}`, { userId, providerType: activeCfg.providerType, bucket: activeCfg.bucket, objectKey, error: msg });
      return sendJSON(res, 200, { success: false, message: msg });
    }
  }

  // ── OSS 后端接管上传（业务服务器拉字节 + PUT 到 OSS） ──
  // 仅用于「外部 URL 入库」：浏览器无法对第三方 URL 做 SSRF 安全拉取，故由后端中继。
  // 本地文件 / 生成结果（data:）一律走主流「前端预签名直传」(/api/oss/sign-upload)，不再经后端 base64 中继。
  // 入参：{ sourceUrl, fileName?, contentType? }
  // 返回 { ok, ossUrl(GET 7d), ossObjectKey, providerType } 或 { ok:false, message }
  if (url === '/api/oss/ingest' && method === 'POST') {
    const t0 = Date.now();
    const userId = req.user?.id;
    if (!userId) return sendJSON(res, 401, { ok: false, message: '请先登录后再上传' });
    const body = await parseBody(req) || {};
    const { enabled, activeId, list } = await ossMod.loadOssConfigs(pgPool);
    if (!enabled) {
      ossMod.log('warn', 'ingest', '接管上传失败：OSS 总开关未启用', { userId });
      return sendJSON(res, 200, { ok: false, message: 'OSS 总开关未启用' });
    }
    const activeCfg = list.find(c => c.id === activeId);
    if (!activeCfg) return sendJSON(res, 200, { ok: false, message: '未配置 active OSS 槽位' });
    if (!activeCfg.enabled) return sendJSON(res, 200, { ok: false, message: 'active OSS 槽位已停用' });
    if (!activeCfg.accessKeyId || !activeCfg.accessKeySecret || !activeCfg.bucket) {
      return sendJSON(res, 200, { ok: false, message: 'active 配置不完整（缺 AccessKey 或 Bucket）' });
    }

    // ── 取得字节 + contentType ──
    let buffer = null;
    let contentType = body?.contentType || 'image/jpeg';
    let srcLabel = '';
    const MAX = 50 * 1024 * 1024;
    try {
      if (body?.sourceUrl && typeof body.sourceUrl === 'string') {
        let u;
        try { u = new URL(String(body.sourceUrl)); } catch { return sendJSON(res, 200, { ok: false, message: 'sourceUrl 非法' }); }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return sendJSON(res, 200, { ok: false, message: 'sourceUrl 协议不支持' });
        const host = u.hostname.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]' ||
            host.startsWith('10.') || host.startsWith('192.168.') || host.endsWith('.internal') ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
          return sendJSON(res, 200, { ok: false, message: 'sourceUrl 指向内网地址，已拒绝' });
        }
        srcLabel = String(body.sourceUrl).slice(0, 80);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30000);
        let r;
        try { r = await fetch(String(body.sourceUrl), { signal: controller.signal, redirect: 'follow' }); }
        finally { clearTimeout(timer); }
        if (!r.ok) return sendJSON(res, 200, { ok: false, message: `拉取源图失败 HTTP ${r.status}` });
        const cl = r.headers.get('content-length');
        if (cl && parseInt(cl, 10) > MAX) return sendJSON(res, 200, { ok: false, message: '源图超过 50MB 上限' });
        buffer = Buffer.from(await r.arrayBuffer());
        if (buffer.length === 0) return sendJSON(res, 200, { ok: false, message: '空文件' });
        if (buffer.length > MAX) return sendJSON(res, 200, { ok: false, message: '源图超过 50MB 上限' });
        const ct = r.headers.get('content-type');
        if (ct) contentType = ct.split(';')[0].trim();
      } else {
        // 本地文件上传已改为「浏览器预签名直传 OSS」，不再经后端 base64 中继（见 /api/oss/sign-upload）
        return sendJSON(res, 200, { ok: false, message: '仅支持 sourceUrl（外部 URL 入库），本地文件请走预签名直传' });
      }
    } catch (e) {
      return sendJSON(res, 200, { ok: false, message: `取字节失败：${(e instanceof Error ? e.message : String(e)).slice(0, 100)}` });
    }

    // ── 构造 objectKey（锁 userId 前缀，防越权写他人目录） ──
    const p = (activeCfg.pathPrefix || 'images/').replace(/^\/+|\/+$/g, '');
    const rawName = (body?.fileName && String(body.fileName).includes('/')) ? String(body.fileName).split('/').pop() : (body?.fileName || `${Date.now()}.jpg`);
    const safeName = String(rawName || 'file').replace(/[^A-Za-z0-9._-]/g, '_');
    const objectKey = `${p}/${userId}/${Date.now()}_${safeName}`;
    const providerTag = activeCfg.providerType === 'tencent-cos' ? 'COS' : 'OSS';

    try {
      let signed;
      if (activeCfg.providerType === 'tencent-cos') {
        const cfg = { ...activeCfg };
        cfg._hostName = `${cfg.bucket}${cfg.appId ? '-' + cfg.appId : ''}.cos.${cfg.region || 'ap-shanghai'}.myqcloud.com`;
        signed = ossMod.tencentCosPutSignUrl(cfg, objectKey, contentType);
      } else {
        signed = ossMod.aliyunPutSignUrl(activeCfg, objectKey, contentType);
      }
      const putRes = await fetch(signed.putUrl, { method: 'PUT', body: buffer, headers: { 'Content-Type': contentType } });
      if (!putRes.ok) {
        const msg = ossMod.diagnoseOssError(activeCfg.providerType, putRes.status, await putRes.text().catch(() => ''));
        ossMod.log('error', 'ingest', `上传失败：${activeCfg.providerType} ${activeCfg.bucket} → ${msg}`, { userId, providerType: activeCfg.providerType, bucket: activeCfg.bucket, objectKey, srcLabel });
        return sendJSON(res, 200, { ok: false, message: msg });
      }
      const getUrl = signed.getUrl || '';
      ossMod.log('success', 'ingest', `[${providerTag}] ✅ 后端接管上传 ${objectKey} → GET 7d（${Date.now() - t0}ms）`, { userId, providerType: activeCfg.providerType, bucket: activeCfg.bucket, objectKey, srcLabel, durationMs: Date.now() - t0 });
      return sendJSON(res, 200, { ok: true, ossUrl: getUrl, ossObjectKey: objectKey, providerType: activeCfg.providerType });
    } catch (e) {
      const msg = `上传异常：${(e instanceof Error ? e.message : String(e)).slice(0, 100)}`;
      ossMod.log('error', 'ingest', `上传异常：${activeCfg.providerType} ${activeCfg.bucket}`, { userId, providerType: activeCfg.providerType, bucket: activeCfg.bucket, objectKey, srcLabel, error: msg });
      return sendJSON(res, 200, { ok: false, message: msg });
    }
  }

  // ── OSS 实时日志：拉历史 + SSE 订阅（仅 admin） ──
  if (url === '/api/oss/logs/recent' && method === 'GET') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    const limit = Math.min(parseInt((new URL(req.url, 'http://x').searchParams.get('limit') || '100'), 10) || 100, 500);
    return sendJSON(res, 200, { records: ossLogger.getRecent(limit) });
  }
  if (url === '/api/oss/logs/stream' && method === 'GET') {
    if (!admin.requireAdmin(req)) return sendJSON(res, 403, { error: '需要管理员权限' });
    return ossLogger.stream(req, res);
  }

  return sendJSON(res, 404, { error: 'Not Found' });
}

// ─── 启动 ────────────────────────────────────────
// ─── Express 应用（框架化：HTTP 服务 + 中间件 + 路由由 Express 承载；/api 分发暂保留 handleAPI，后续逐步迁为 Express 路由）───
const app = express();

// 全局请求监控：覆盖 API + 静态资产(/assets/*、/samples/*、SPA 前端路由)，
// 驱动后台「实时监控 · API 活动流」大屏。monitor 模块内部已过滤 /api/admin/monitor/* 自身防反馈。
app.use((req, res, next) => {
  const monitorT0 = Date.now();
  res.on('finish', () => {
    monitor.record(req.method, (req.url || '').split('?')[0], res.statusCode, Date.now() - monitorT0);
  });
  next();
});

// CORS 预检
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    const corsOrigin = process.env.CORS_ORIGIN;
    const origin = corsOrigin || (!isProduction ? '*' : '');
    res.writeHead(204, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS' });
    return res.end();
  }
  next();
});

// API token（网关探针）
app.get('/api/token', (req, res) => sendJSON(res, 200, { token: API_TOKEN }));

// API 路由 → handleAPI（含流量采样）
app.use((req, res, next) => {
  if (!req.url.startsWith('/api/')) return next();
  const t0 = Date.now();
  res.on('finish', () => {
    traffic.record(req.method, (req.url || '').split('?')[0], res.statusCode, req.user, Date.now() - t0);
  });
  return handleAPI(req, res).catch((err) => next(err));
});

// 本地静态文件路由（/media/ 上传 & /samples/ 公共示例）必须早于 SPA fallback，否则会被 index.html 吞掉
app.use((req, res, next) => {
  if (req.url.startsWith('/media/') || req.url.startsWith('/samples/')) return serveLocalFiles(req, res);
  next();
});

// SPA 静态回退
app.use((req, res) => {
  if (fs.existsSync(CLIENT_DIR)) return serveStatic(req, res);
  sendJSON(res, 404, { error: 'Not Found' });
});

// Express error handler (catches unhandled rejections from async middleware)
app.use((err, req, res, next) => {
  console.error('[ERROR] Unhandled middleware error:', err && err.message || err);
  console.error('[ERROR] Stack:', err && err.stack);
  if (!res.headersSent) {
    sendJSON(res, 500, { error: 'Internal Server Error' });
  }
});

const server = http.createServer(app);

// ─── Node cluster（多 worker 用满多核；#360 限流已迁 Redis，多实例/多 worker 安全）───
// 仅当 ENABLE_CLUSTER !== 'false' 且为多核时启用；env WEB_CONCURRENCY 可指定 worker 数，默认 = CPU 核数。
// 主进程只负责 fork/管理 worker 并转发信号；worker 才运行 app（initDB/listen/SIGTERM）。
const CLUSTER_ENABLED = process.env.ENABLE_CLUSTER !== 'false';
const NUM_WORKERS = process.env.WEB_CONCURRENCY
  ? Math.max(1, parseInt(process.env.WEB_CONCURRENCY, 10) || 1)
  : Math.max(1, os.cpus().length);

if (CLUSTER_ENABLED && cluster.isPrimary) {
  console.log(`[cluster] 主进程 pid=${process.pid} 启动 ${NUM_WORKERS} 个 worker（共 ${os.cpus().length} 核）`);
  let clusterShuttingDown = false;
  for (let i = 0; i < NUM_WORKERS; i++) cluster.fork();
  cluster.on('exit', (worker, code, signal) => {
    if (clusterShuttingDown) {
      console.log(`[cluster] worker ${worker.process.pid} 退出(${signal || code})，关闭中不重启`);
      return;
    }
    console.error(`[cluster] worker ${worker.process.pid} 退出(${signal || code})，自动重启`);
    cluster.fork();
  });
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      if (clusterShuttingDown) return;
      clusterShuttingDown = true;
      console.log(`[cluster] 主进程收到 ${sig}，转发给所有 worker`);
      for (const id of Object.keys(cluster.workers || {})) cluster.workers[id].kill(sig);
      setTimeout(() => process.exit(0), 8000).unref();
    });
  }
  // 主进程到此为止，不运行 app（下方 bootstrap 仅在 worker 执行）
}

// cluster 模式：仅 worker 运行 app；单进程模式(ENABLE_CLUSTER=false)：主进程即运行 app（否则 app 完全不启动）
if (cluster.isWorker || !CLUSTER_ENABLED) {
// leader worker（id=1）独跑周期性调度/崩溃恢复；单进程模式下 IS_LEADER 恒 true 亦运行，避免多 worker 重复扫 DB / 重复续轮询
const IS_LEADER = !CLUSTER_ENABLED || cluster.worker?.id === 1;
await initDB();
await initRedis();
cpuMonitor.start(); // 启动 CPU 自适应负载降级监控（每 worker 独立）

// ─── 崩溃恢复：启动即扫描在途视频任务，续轮询崩溃前已提交但本进程未完成的任务 ───
// 必须在 PG 就绪后、且 pgPool 全局已赋值后调用（resumeRunningTasks 内部用 pgPool 重新加载 provider/model）。
// 只恢复已持久化 provider_task_id 的 running 任务；提交前崩溃的任务无 provider task id，
// 由 billing.cjs 的 running>30min 兜底释放 held 积分，不会泄漏（此处仅负责"拿回那一笔生成结果"）。
if (pgPool && IS_LEADER) {
  dispatcher.resumeRunningTasks(pgPool)
    .then((r) => { if (r && r.resumed) console.log(`[startup] 崩溃恢复：续轮询 ${r.resumed} 个在途视频任务`); })
    .catch((e) => console.warn('[startup] 崩溃恢复扫描失败（不影响启动）:', e.message));
  // 孤儿 running 任务看门狗：兜底回收崩溃/未捕获导致的永久 running（进程崩溃/未知竞态下积分与 pending 卡片无法自愈）。
  dispatcher.startStuckTaskWatchdog(pgPool);
  // 等待区崩溃恢复：重启后内存 WAITING_AREA 队列丢失，重新入队仍处于等待区的孤儿任务并启动泵重试。
  dispatcher.resumeWaitingArea(pgPool)
    .then((r) => { if (r && r.resumed) console.log(`[startup] 等待区恢复：重试 ${r.resumed} 个排队任务`); })
    .catch((e) => console.warn('[startup] 等待区恢复扫描失败（不影响启动）:', e.message));
  // 搬运与 API 解耦：启动后台上传队列 worker（建表 + 崩溃恢复 + 起 worker），仅 leader worker 跑
  dispatcher.startUploadQueue(pgPool)
    .then(() => console.log('[startup] 上传队列 worker 已启动'))
    .catch((e) => console.warn('[startup] 上传队列启动失败（不影响启动）:', e.message));
}

// ─── 核心错误持久化 + 进程级异常兜底（#449/#450）───
// 注入连接池（供 insertError 落库）；注册 uncaughtException/unhandledRejection 兜底，
// 确保「任何未捕获的致命错误」也进入 system_error_logs 并被记录。
if (pgPool) syslogMod.initSyslog(pgPool);
syslogMod.installGlobalHandlers();

// ─── 日志总线事件源 ───
//   PG：连接/错误；Redis：ready/error/reconnecting/end；
//   业务流(注册/登录/生成/计费等)可在未来手动 logbus.emit('INFO', 'app', ...) 接入
if (pgPool) {
  pgPool.on('error', (err) => {
    logbus.emit('ERROR', 'pg', `连接池错误: ${err.message}`, { code: err.code });
  });
  pgPool.on('connect', () => {
    // 后续新建连接才记 INFO；首次连接由下方显式补发（避免连接早于 handler 挂载而丢失）
    if (pgPool._loggedFirstConnect) {
      logbus.emit('INFO', 'pg', 'PostgreSQL 新连接建立');
    }
  });
  pgPool.on('remove', () => { /* 客户端归还，不记 */ });
  // 显式首发 INFO：initDB 成功即代表已连通，确保启动期事件不丢失（与 Redis 修复同思路）
  if (!pgPool._loggedFirstConnect) {
    pgPool._loggedFirstConnect = true;
    logbus.emit('INFO', 'pg', 'PostgreSQL 已连接（启动）');
  }
} else {
  logbus.emit('WARN', 'pg', 'PostgreSQL 不可用，已降级 JSON 存储');
}

const redisClient = redisStore.getRedis && redisStore.getRedis();
if (redisClient) {
  redisClient.on('error', (err) => {
    logbus.emit('ERROR', 'redis', `连接错误: ${err.message}`);
  });
  redisClient.on('ready', () => {
    if (!redisClient._loggedFirstReady) {
      redisClient._loggedFirstReady = true;
      logbus.emit('INFO', 'redis', 'Redis ready');
    }
  });
  redisClient.on('reconnecting', (delay) => {
    logbus.emit('WARN', 'redis', `Redis 正在重连（${delay}ms 后）`);
  });
  redisClient.on('end', () => {
    logbus.emit('WARN', 'redis', 'Redis 连接已断开');
  });
  // 修复：若连接已在挂载 .on('ready') 之前建立（ioredis 'ready' 一次性事件），
  // 这里补发一条 INFO，避免启动期 Redis 事件永远丢失。
  if (redisClient.status === 'ready' && !redisClient._loggedFirstReady) {
    redisClient._loggedFirstReady = true;
    logbus.emit('INFO', 'redis', 'Redis ready');
  }
} else {
  logbus.emit('WARN', 'redis', 'Redis 客户端未初始化，使用内存兜底');
}

// ─── 生产安全自检（仅 production）───
if (isProduction) {
  const unsafeJwt = !process.env.JWT_SECRET
    || process.env.JWT_SECRET === 'dev-only-change-me'
    || process.env.JWT_SECRET === 'change-me-to-a-long-random-string';
  if (unsafeJwt) {
    console.error('[SECURITY] JWT_SECRET 未设置或使用默认值，生产环境拒绝启动（会话令牌可被伪造）。请设置强随机值后重试。');
    process.exit(1);
  }
  // SIGN_SECRET 保护充值订单 HMAC 完整性标记。生产环境若配置了支付通道，缺失该密钥会导致订单签名缺失（本地防篡改失效）。
  // Webhook 验签由支付平台签名独立保障（fail closed），但 SIGN_SECRET 是本地防篡改的纵深防御层。
  {
    const signSecret = process.env.PAYMENT_MASTER_KEY || process.env.PAYMENT_SIGN_SECRET || null;
    // 仅当 PAYMENT_MASTER_KEY 或 PAYMENT_SIGN_SECRET 任一被显式设置时，才要求 SIGN_SECRET 不为空（避免误报）
    // 如果两者都未设置，说明支付功能未启用，跳过
    if (process.env.PAYMENT_MASTER_KEY !== undefined || process.env.PAYMENT_SIGN_SECRET !== undefined) {
      if (!signSecret) {
        console.error('[SECURITY] 生产环境检测到支付环境变量已声明但值为空，SIGN_SECRET 缺失将导致订单完整性标记为空。请设置 PAYMENT_MASTER_KEY 或 PAYMENT_SIGN_SECRET 后重试。');
        process.exit(1);
      }
    }
  }
  if (process.env.ADMIN_SEED_PASSWORD && process.env.ADMIN_SEED_PASSWORD === 'Admin@123456') {
    console.warn('[SECURITY] ⚠️ ADMIN_SEED_PASSWORD 仍为默认密码，公开部署前必须覆盖为强密码。');
  }
  if (!devTokenEnabled) {
    console.warn('[SECURITY] 已禁用自动生成的 dev 系统令牌（NODE_ENV=production 且未显式提供 API_TOKEN 环境变量）。');
  }
}

// ─── HTTP 连接/超时调优（CPU 优化：b 方案，零依赖）───
// 作用：延长入站 keep-alive + 收紧请求/socket 超时 → 前端复用 TCP 连接、减少握手，
// 快速回收半开/慢连接，降低 sys CPU。等效覆盖「a：连接复用」的精神（出站 fetch 因
// Node22 内置 undici 已默认 keepAlive，且容器内缺 undici 包无法改 per-host 上限，故不出包）。
// 注意：headersTimeout 必须 > keepAliveTimeout（Node 硬性约束），否则启动报错。
server.keepAliveTimeout = 30000;        // 入站连接 keep-alive 30s（默认 5s），前端/代理复用连接
server.headersTimeout = 35000;          // 必须 > keepAliveTimeout
server.requestTimeout = 60000;          // 单个请求处理上限 60s，超时即断，防慢请求占连接
server.timeout = 65000;                 // socket 空闲超时 65s
server.maxHeadersCount = 200;           // 放宽头部上限，避免大 headers 请求被拒

server.listen(PORT, '0.0.0.0', async () => {
  const addrPort = server.address() ? (server.address().port || PORT) : PORT;
  console.log(`🚀 [${NODE_ID}] 服务: http://localhost:${addrPort} | 📁 ${DATA_DIR} | 🐘 PG:connected(强制·唯一数据源) | 🔴 Redis:${isRedisUp() ? 'up' : 'memory-fallback(仅缓存)'}`);
  // Test harness port probe via IPC
  if (process.env.NODE_ENV === 'test' && process.send) {
    process.on('message', (msg) => {
      if (msg && msg.type === 'ping') process.send({ type: 'port', port: addrPort });
    });
  }
  if (IS_LEADER) orderExpiry.start(); // 调度器仅 leader worker 跑（避免多实例重复扫 DB）

  // 启动时加载 key 池到 dispatcher 内存态
  try {
    const provs = await pgPool.query('SELECT id FROM providers WHERE enabled = true AND api_key IS NOT NULL AND api_key != \'\'');
    for (const pr of provs.rows) {
      const keys = await pgPool.query('SELECT id, provider_id, api_key, label, status, weight FROM api_keys WHERE provider_id = $1', [pr.id]);
      dispatcher.syncKeyPool(pr.id, keys.rows);
      console.log(`[startup] Loaded ${keys.rows.length} keys for provider ${pr.id}`);
    }
  } catch(e) {
    console.warn('[startup] Key pool init failed:', e.message);
  }
});

// ─── 优雅关闭（SIGTERM/SIGINT）──
// PM2/容器发 SIGTERM：停 worker → 关闭 HTTP（不再接新连接，等在途完成）→ 关 Redis/PG → 退出。
// 部署基线（#360）：ecosystem.config.cjs 已是单实例 fork（dispatcher RPM 令牌桶为进程内态，
// 多实例会重复计数导致厂商 429 风暴）；此处负责进程内资源的有序释放。
let shuttingDown = false;
function gracefulShutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] 收到 ${sig}，开始优雅关闭...`);
  orderExpiry.stop();

  // 兜底：10s 内未自然退出则强制退出，避免 PM2 kill_timeout 前残留
  const forceExit = setTimeout(() => {
    console.error('[shutdown] 等待超时，强制退出');
    process.exit(1);
  }, 10000);
  if (forceExit.unref) forceExit.unref();

  const done = (label) => {
    console.log(`[shutdown] ${label}`);
    clearTimeout(forceExit);
    process.exit(0);
  };

  // 1) 停止接受新连接，等待在途请求自然完成
  server.close((err) => {
    if (err) console.error('[shutdown] server.close 错误:', err.message);
    // 2) 关闭 Redis（ioredis quit）
    const r = redisStore.getRedis && redisStore.getRedis();
    const afterRedis = () => {
      // 3) 关闭 PG 连接池
      if (pgPool && typeof pgPool.end === 'function') {
        pgPool.end(() => done('PG 连接池已关闭，进程退出')).catch(() => done('PG 关闭异常，进程退出'));
      } else {
        done('进程退出');
      }
    };
    if (r && typeof r.quit === 'function') {
      r.quit().then(afterRedis).catch(afterRedis);
    } else {
      afterRedis();
    }
  });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
} // end if (cluster.isWorker || !CLUSTER_ENABLED)