'use strict';
const crypto = require('crypto');
const session = require('../../auth.cjs');

/**
 * Test fixture factory for deterministic test data.
 */

function makeUser(overrides = {}) {
  return {
    id: `u-${crypto.randomUUID()}`,
    email: `test-${crypto.randomUUID().slice(0, 8)}@example.com`,
    displayName: 'Test User',
    password: 'TestPass123!',
    role: 'user',
    rewardCredits: 0,
    rechargeCredits: 50,
    ...overrides,
  };
}

function makeAdmin(overrides = {}) {
  return {
    ...makeUser({
      email: `admin-${crypto.randomUUID().slice(0, 8)}@example.com`,
      displayName: 'Test Admin',
      role: 'admin',
      rechargeCredits: 1000,
      ...overrides,
    }),
  };
}

function makeProvider(overrides = {}) {
  return {
    id: `prov-${crypto.randomUUID()}`,
    name: `Test Provider ${crypto.randomUUID().slice(0, 6)}`,
    type: 'official',
    baseUrl: 'https://api.test-provider.example.com/v1',
    apiKey: 'fake-test-only-key-' + crypto.randomUUID().slice(0, 8),
    supportedTypes: ['image'],
    enabled: true,
    protocol: 'openai-compatible',
    ...overrides,
  };
}

function makeModel(provider, overrides = {}) {
  return {
    id: `mdl-${crypto.randomUUID()}`,
    modelId: `test-model-${crypto.randomUUID().slice(0, 6)}`,
    displayName: `Test Model ${crypto.randomUUID().slice(0, 6)}`,
    type: 'image',
    providerId: provider.id,
    enabled: true,
    supportedResolutions: ['1k', '2k'],
    creditCost: 1,
    rewardCreditsRequired: 0,
    category: 'image',
    ...overrides,
  };
}

/**
 * Insert a user into the test DB and return the user object with hashed password.
 */
async function createUser(pg, userDef) {
  const u = { ...userDef };
  const passwordHash = session.hashPassword(u.password || 'TestPass123!');
  const result = await pg.query(
    `INSERT INTO users (id, email, display_name, password_hash, reward_credits, recharge_credits, credits, role, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', NOW())
     RETURNING id, email, display_name, role`,
    [
      u.id || crypto.randomUUID(),
      u.email || `fx${crypto.randomUUID().slice(0, 8)}@example.com`,
      u.displayName || 'Test User',
      passwordHash,
      u.rewardCredits || 0,
      u.rechargeCredits || 50,
      (u.rewardCredits || 0) + (u.rechargeCredits || 50),
      u.role || 'user',
    ]
  );
  return { ...u, ...result.rows[0] };
}

/**
 * Insert a provider into the test DB.
 */
async function createProvider(pg, providerDef) {
  const p = { ...providerDef };
  await pg.query(
    `INSERT INTO providers (id, name, type, base_url, api_key, supported_types, enabled, protocol, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
    [
      p.id,
      p.name,
      p.type || 'official',
      p.baseUrl || p.base_url || '',
      p.apiKey || p.api_key || 'fake-test-only-key',
      `{${(p.supportedTypes || p.supported_types || ['image']).join(',')}}`,
      p.enabled !== false,
      p.protocol || 'openai-compatible',
    ]
  );
  return p;
}

/**
 * Insert a model into the test DB.
 */
async function createModel(pg, modelDef, providerId) {
  const m = { ...modelDef };
  await pg.query(
    `INSERT INTO models (id, model_id, display_name, type, provider_id, enabled, supported_resolutions, credit_cost, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
    [
      m.id,
      m.modelId || m.model_id,
      m.displayName || m.display_name,
      m.type || 'image',
      providerId,
      m.enabled !== false,
      `{${(m.supportedResolutions || m.supported_resolutions || ['1k']).join(',')}}`,
      m.creditCost || m.credit_cost || 1,
    ]
  );
  return m;
}

module.exports = {
  makeUser,
  makeAdmin,
  makeProvider,
  makeModel,
  createUser,
  createProvider,
  createModel,
};
