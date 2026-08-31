'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('1.0 product lock and out-of-scope defaults are explicit', () => {
  const flags = read('src/shared/config/featureFlags.ts');
  for (const flag of ['SHOP_ENABLED','AGENT_LAB_ENABLED','GENERIC_WORKFLOW_ENABLED']) assert.match(flags, new RegExp(`case FF\\.${flag}`));
  assert.match(read('docs/scope/S1-0-product-scope-manifest.md'), /AI-Native Commercial Video Production OS/);
});

test('core video-production routes remain reachable', () => {
  const app = read('src/App.tsx');
  for (const route of ['workspace','library/:category?','characters','/studio']) assert.ok(app.includes(`path="${route}"`), `missing ${route}`);
});

test('out-of-scope direct routes and navigation are guarded', () => {
  const app = read('src/App.tsx');
  assert.match(app, /isFeatureEnabled\(FF\.SHOP_ENABLED\).*ShopLayout/s);
  assert.match(app, /path="agents" element=\{isFeatureEnabled\(FF\.AGENT_LAB_ENABLED\)/);
  assert.match(app, /path="routing" element=\{isFeatureEnabled\(FF\.GENERIC_WORKFLOW_ENABLED\)/);
  assert.match(app, /path="skills" element=\{isFeatureEnabled\(FF\.GENERIC_WORKFLOW_ENABLED\)/);
  const registry = read('src/config/adminRegistry.ts');
  for (const pair of ["'admin-agents': FF.AGENT_LAB_ENABLED", "'admin-routing': FF.GENERIC_WORKFLOW_ENABLED", "'admin-skills': FF.GENERIC_WORKFLOW_ENABLED", "'admin-ecommerce': FF.SHOP_ENABLED"]) assert.ok(registry.includes(pair));
  assert.match(read('src/components/navigationDockConfigs.ts'), /isFeatureEnabled\(FF\.SHOP_ENABLED\)/);
  assert.match(read('src/pages/LandingPage/LandingPage.tsx'), /isFeatureEnabled\(FF\.SHOP_ENABLED\)/);
});
