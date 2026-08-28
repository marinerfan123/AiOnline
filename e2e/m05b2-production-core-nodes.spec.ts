/**
 * V2 M05-B2 — Production Core Nodes E2E.
 * Local test DB/account only. Model catalog is a test-safe M02 API fixture;
 * no provider/generation/credits calls are made (hard-blocked routes).
 *
 * Connection strategy (M05-B2 learned): add all nodes, canvas-fit ONCE to bring
 * everything into the visible viewport (onlyRenderVisibleElements culls the rest),
 * then connect. After Inspector editing (fill/blur) a residual focus state can
 * make a React Flow connection drag no-op, so each connect does Escape →
 * click the target card → drag. No per-connect canvas-fit (the toolbar button
 * leaves bad pointer state for the following drag).
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const credsPath = path.resolve(__dirname, '.e2e-credentials.json');
let E2E_EMAIL = process.env.E2E_EMAIL || '';
let E2E_PASSWORD = process.env.E2E_PASSWORD || '';
if (fs.existsSync(credsPath)) {
  const file = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
  E2E_EMAIL = file.email || E2E_EMAIL;
  E2E_PASSWORD = file.password || E2E_PASSWORD;
}

const modelFixture = [
  {
    model_id: 'm05b2-img-model',
    display_name: 'M05B2 Image Gen Fixture',
    type: 'image',
    enabled: true,
    capabilities: { type: 'text_to_image', input_modalities: ['text'], output_modalities: ['image'], version: 1 },
    capability_version: 1,
    parameter_schema: { fields: { seed: { min: 0, max: 9999 } } },
    credit_cost: 1,
    bindings: [{ binding_id: 'masked-route-count-only', provider_id: 'fixture-provider', enabled: true }],
  },
  {
    model_id: 'm05b2-i2v-model',
    display_name: 'M05B2 I2V Fixture',
    type: 'video',
    enabled: true,
    capabilities: { type: 'image_to_video', input_modalities: ['image'], output_modalities: ['video'], version: 1 },
    capability_version: 1,
    parameter_schema: { fields: { duration: { min: 2, max: 10 } } },
    credit_cost: 3,
    bindings: [],
  },
  {
    model_id: 'm05b2-t2v-model',
    display_name: 'M05B2 T2V Fixture',
    type: 'video',
    enabled: true,
    capabilities: { type: 'text_to_video', input_modalities: ['text'], output_modalities: ['video'], version: 1 },
    capability_version: 1,
    parameter_schema: {},
    credit_cost: 2,
    bindings: [],
  },
];

test.describe('M05-B2 Production Core Nodes E2E', () => {
  let projectId: string;

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v2/ai-control/models', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(modelFixture) });
    });
    await page.route('**/api/generate**', (route) => route.abort('blockedbyclient'));
    await page.route('**/api/v2/generation**', (route) => route.abort('blockedbyclient'));

    await page.goto('/login');
    await page.getByPlaceholder('邮箱').fill(E2E_EMAIL);
    await page.getByPlaceholder('密码').fill(E2E_PASSWORD);
    const [loginRes] = await Promise.all([
      page.waitForResponse(/api\/auth\/login/),
      page.getByRole('button', { name: '登录', exact: true }).click(),
    ]);
    expect(loginRes.ok()).toBe(true);
    await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });
  });

  async function createProject(page: import('@playwright/test').Page): Promise<string> {
    await page.goto('/__v2/projects/new');
    await page.getByTestId('project-name-input').fill(`M05B2 Nodes E2E ${Date.now()}`);
    const [projectRes] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/v2/projects') && res.request().method() === 'POST'),
      page.getByTestId('submit-project').click(),
    ]);
    expect(projectRes.status()).toBe(201);
    const body = await projectRes.json();
    return body.project.id as string;
  }

  const cardOf = (page: import('@playwright/test').Page, kind: string) =>
    page.locator(`[data-test="studio-node-card"][data-node-kind="${kind}"]`);

  /**
   * Connect source card's first output handle → target card's input handle.
   * Robust against the residual-focus no-op: Escape (drop selection/focus) →
   * click the target card (canvas pointer reset + it stays selected) → drag.
   * Returns 'connected' | 'rejected' (type gate) | 'failed'.
   */
  async function connect(
    page: import('@playwright/test').Page,
    fromKind: string,
    toKind: string,
    targetHandle = 'text',
  ): Promise<'connected' | 'rejected' | 'failed'> {
    const fromCard = cardOf(page, fromKind).first();
    const toCard = cardOf(page, toKind).first();
    const before = await page.locator('.react-flow__edge').count();
    for (let attempt = 1; attempt <= 4; attempt++) {
      await page.keyboard.press('Escape');
      await toCard.click({ position: { x: 8, y: 8 } });
      await page.waitForTimeout(250);
      const from = await fromCard.locator('.react-flow__handle.source').first().boundingBox();
      const to = await toCard.locator(`.react-flow__handle.target[data-handleid="${targetHandle}"]`).boundingBox();
      if (!from || !to) return 'failed';
      const fp = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
      const tp = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
      await page.mouse.move(fp.x, fp.y);
      await page.mouse.down();
      for (let i = 1; i <= 15; i++) {
        await page.mouse.move(fp.x + ((tp.x - fp.x) * i) / 15, fp.y + ((tp.y - fp.y) * i) / 15);
      }
      await page.mouse.move(tp.x, tp.y);
      await page.mouse.up();
      await page.waitForTimeout(300);
      if ((await page.locator('.react-flow__edge').count()) > before) return 'connected';
      if ((await page.locator('[data-test="invalid-connection-toast"]').count()) > 0) return 'rejected';
    }
    return 'failed';
  }

  test('production core nodes: connect, model, params, READY/INVALID, reference, i2v, t2v, output, library', async ({ page }) => {
    const forbiddenCalls: string[] = [];
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('/api/generate') || u.includes('/api/v2/generation')) forbiddenCalls.push(u);
    });

    projectId = await createProject(page);
    await page.goto(`/__v2/projects/${projectId}/studio`);
    await expect(page.getByTestId('studio-page')).toBeVisible({ timeout: 15_000 });

    // ── Node Library: production sections derived from registry ──
    for (const sec of ['INPUT', 'CREATIVE', 'GENERATE', 'MEDIA', 'OUTPUT', 'STRUCTURE']) {
      await expect(page.getByTestId(`node-library-category-${sec}`)).toBeVisible();
    }
    await expect(page.getByTestId('node-library-item-image-generation')).toBeVisible();
    await expect(page.getByTestId('node-library-item-image-to-video')).toBeVisible();
    await expect(page.getByTestId('node-library-item-text-to-video')).toBeVisible();
    await expect(page.getByTestId('node-library-item-video')).toBeVisible();
    await expect(page.getByTestId('node-library-item-character')).toBeVisible();

    // ── add the full node set, then one canvas-fit to bring all into view ──
    await page.getByTestId('node-library-item-prompt').click();
    await page.getByTestId('node-library-item-image-generation').click();
    await page.getByTestId('node-library-item-reference').click();
    await page.getByTestId('node-library-item-image-to-video').click();
    await page.getByTestId('node-library-item-text-to-video').click();
    await page.getByTestId('node-library-item-video').click();
    await page.getByTestId('node-library-item-output').click();
    await page.getByTestId('canvas-fit').click();
    await page.waitForTimeout(700);

    // ── Prompt: fill (select the prompt card first) ──
    await cardOf(page, 'prompt').first().click();
    await page.getByTestId('inspector-prompt').fill('a production prompt node');
    await page.getByTestId('inspector-prompt').blur();
    await expect(page.getByTestId('inspector-validation')).toContainText('valid');

    // ── Image Generation: honest placeholder, capability-filtered model ──
    await cardOf(page, 'image-generation').first().click();
    await expect(cardOf(page, 'image-generation').first().getByTestId('generation-placeholder')).toBeVisible();
    const modelSelect = page.getByLabel('Logical Model');
    await expect(modelSelect).toContainText('M05B2 Image Gen Fixture');
    await expect(modelSelect).not.toContainText('M05B2 I2V Fixture');
    await expect(page.getByTestId('inspector-validation')).toContainText('Logical Model is required');

    // ── connect Prompt → Image Generation, select model → READY ──
    expect(await connect(page, 'prompt', 'image-generation', 'text')).toBe('connected');
    await expect(page.locator('.react-flow__edge').first()).toBeVisible({ timeout: 5_000 });
    await modelSelect.selectOption('m05b2-img-model');
    await page.getByTestId('param-aspectRatio').selectOption('16:9');
    await expect(page.getByTestId('port-summary-text')).toContainText('CONNECTED');
    await expect(page.getByTestId('inspector-validation')).toContainText('valid');
    await expect(page.getByTestId('inspector-status')).toContainText('Ready to run');

    // ── disconnect required input → INVALID; reconnect → READY ──
    const edgeCount = await page.locator('.react-flow__edge').count();
    await page.locator('.react-flow__edge').first().click({ force: true });
    await page.keyboard.press('Delete');
    await expect(page.locator('.react-flow__edge')).toHaveCount(edgeCount - 1, { timeout: 5_000 });
    await cardOf(page, 'image-generation').first().click();
    await expect(page.getByTestId('inspector-status')).toContainText('Invalid configuration');
    await expect(page.getByTestId('port-summary-text')).toContainText('MISSING');

    expect(await connect(page, 'prompt', 'image-generation', 'text')).toBe('connected');
    await expect(page.locator('.react-flow__edge')).toHaveCount(edgeCount, { timeout: 5_000 });
    await cardOf(page, 'image-generation').first().click();
    await expect(page.getByTestId('inspector-status')).toContainText('Ready to run');

    // ── Reference: pick asset, connect to image-generation reference port ──
    const created = await page.evaluate(async (pid) => {
      const res = await fetch('/api/v2/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          projectId: pid,
          url: 'http://127.0.0.1/test-fixtures/m05b2-ref.png',
          title: 'M05B2 ref fixture',
          assetType: 'IMAGE',
          mimeType: 'image/png',
          width: 100,
          height: 100,
          sizeBytes: 1000,
        }),
      });
      return { status: res.status, body: await res.json() };
    }, projectId);
    expect(created.status).toBe(201);
    const assetId = created.body.asset.assetId as string;

    await cardOf(page, 'reference').first().click();
    await page.getByTestId('inspector-open-asset-picker').click();
    await expect(page.getByTestId('asset-picker')).toBeVisible();
    await page.getByTestId(`asset-picker-item-${assetId}`).click();
    await page.getByTestId('asset-picker-confirm').click();
    await expect(page.getByTestId('studio-inspector')).toContainText(assetId);
    await expect(page.getByTestId('inspector-validation')).toContainText('valid');

    expect(await connect(page, 'reference', 'image-generation', 'reference')).toBe('connected');
    await cardOf(page, 'image-generation').first().click();
    await expect(page.getByTestId('inspector-status')).toContainText('Ready to run');

    // editing the prompt AFTER connection marks the downstream generation node STALE
    await cardOf(page, 'prompt').first().click();
    await page.getByTestId('inspector-prompt').fill('a changed production prompt');
    await page.getByTestId('inspector-prompt').blur();
    await cardOf(page, 'image-generation').first().click();
    await expect(page.getByTestId('inspector-status')).toContainText('Stale');

    // ── I2V: capability-specific model selector (only the i2v fixture) ──
    await cardOf(page, 'image-to-video').first().click();
    const i2vModel = page.getByLabel('Logical Model');
    await expect(i2vModel).toContainText('M05B2 I2V Fixture');
    await expect(i2vModel).not.toContainText('M05B2 Image Gen Fixture');
    await i2vModel.selectOption('m05b2-i2v-model');
    await page.getByTestId('param-duration').fill('5');
    await expect(page.getByTestId('inspector-validation')).toContainText('图像 is not connected');

    expect(await connect(page, 'image-generation', 'image-to-video', 'image')).toBe('connected');
    await cardOf(page, 'image-to-video').first().click();
    await expect(page.getByTestId('inspector-validation')).not.toContainText('图像 is not connected');

    // ── T2V: capability-specific selector (only the t2v fixture) ──
    await cardOf(page, 'text-to-video').first().click();
    const t2vModel = page.getByLabel('Logical Model');
    await expect(t2vModel).toContainText('M05B2 T2V Fixture');
    await expect(t2vModel).not.toContainText('M05B2 I2V Fixture');
    await t2vModel.selectOption('m05b2-t2v-model');
    await page.getByTestId('param-duration').fill('6');
    await expect(page.getByTestId('inspector-validation')).toContainText('文本 is not connected');

    expect(await connect(page, 'prompt', 'text-to-video', 'text')).toBe('connected');
    await cardOf(page, 'text-to-video').first().click();
    await expect(page.getByTestId('inspector-validation')).not.toContainText('文本 is not connected');

    // ── Video Asset: no generation model params; illegal TEXT→Video Asset rejected ──
    await cardOf(page, 'video').first().click();
    expect(await page.getByTestId('inspector-validation').textContent()).not.toContain('Logical Model');
    expect(await connect(page, 'prompt', 'video', 'video')).toBe('rejected');

    // ── Output: connect the t2v VIDEO result → Output boundary ──
    await cardOf(page, 'output').first().click();
    expect(await page.getByTestId('inspector-validation').textContent()).toContain('Output requires at least one connected input');
    expect(await connect(page, 'text-to-video', 'output', 'video')).toBe('connected');
    await cardOf(page, 'output').first().click();
    await expect(page.getByTestId('inspector-validation')).toContainText('valid');
    await expect(page.getByTestId('inspector-output-type')).toContainText('none');

    // no real generation was invoked anywhere in this whole flow
    expect(forbiddenCalls).toEqual([]);
  });
});
