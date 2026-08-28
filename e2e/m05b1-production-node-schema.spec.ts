/**
 * V2 M05-B1 — Production Node Schema + Parameter Inspector E2E.
 * Local test DB/account only. Model catalog is a test-safe M02 API fixture;
 * no provider/generation/credits calls are made.
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
    model_id: 'm05b1-image-model',
    display_name: 'M05B1 Image Fixture',
    type: 'image',
    enabled: true,
    capabilities: { type: 'text_to_image', input_modalities: ['text'], output_modalities: ['image'], version: 1 },
    capability_version: 1,
    parameter_schema: { fields: { seed: { min: 0, max: 9999 } } },
    credit_cost: 1,
    bindings: [{ binding_id: 'masked-route-count-only', provider_id: 'fixture-provider', enabled: true }],
  },
  {
    model_id: 'm05b1-video-model',
    display_name: 'M05B1 Video Fixture',
    type: 'video',
    enabled: true,
    capabilities: { type: 'text_to_video', input_modalities: ['text'], output_modalities: ['video'], version: 1 },
    capability_version: 1,
    parameter_schema: {},
    credit_cost: 2,
    bindings: [],
  },
];

test.describe('M05-B1 Production Node Schema E2E', () => {
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
    await page.getByTestId('project-name-input').fill(`M05B1 Schema E2E ${Date.now()}`);
    const [projectRes] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/v2/projects') && res.request().method() === 'POST'),
      page.getByTestId('submit-project').click(),
    ]);
    expect(projectRes.status()).toBe(201);
    const body = await projectRes.json();
    return body.project.id as string;
  }

  test('schema-driven inspector edits parameters, filters models, validates, preserves AssetPicker and no persistence', async ({ page }) => {
    const forbiddenCalls: string[] = [];
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('/api/generate') || u.includes('/api/v2/generation')) forbiddenCalls.push(u);
    });

    projectId = await createProject(page);
    await page.goto(`/__v2/projects/${projectId}/studio`);
    await expect(page.getByTestId('studio-page')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('node-library-item-prompt').click();
    await expect(page.getByTestId('schema-parameter-inspector')).toBeVisible();
    await expect(page.getByTestId('inspector-validation')).toContainText('Prompt Text is required');
    await page.getByTestId('inspector-prompt').fill('a production schema prompt');
    await page.getByTestId('inspector-prompt').blur();
    await expect(page.getByTestId('inspector-validation')).toContainText('valid');

    await page.getByTestId('node-library-item-image-generation').click();
    await expect(page.getByTestId('schema-parameter-inspector')).toBeVisible();
    await expect(page.getByTestId('inspector-validation')).toContainText('Logical Model is required');
    const modelSelect = page.getByLabel('Logical Model');
    await expect(modelSelect).toContainText('M05B1 Image Fixture');
    await expect(modelSelect).not.toContainText('M05B1 Video Fixture');
    await modelSelect.selectOption('m05b1-image-model');
    await page.getByTestId('param-aspectRatio').selectOption('16:9');
    await page.getByTestId('param-resolution').selectOption('1280x720');
    await page.getByTestId('inspector-advanced-toggle').click();
    await page.getByTestId('param-seed').fill('1234');
    await expect(page.getByTestId('inspector-validation')).toContainText('valid');

    const created = await page.evaluate(async (pid) => {
      const res = await fetch('/api/v2/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          projectId: pid,
          url: 'http://127.0.0.1/test-fixtures/m05b1-ref.png',
          title: 'M05B1 ref fixture',
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

    await page.getByTestId('node-library-item-reference').click();
    await page.getByTestId('inspector-open-asset-picker').click();
    await expect(page.getByTestId('asset-picker')).toBeVisible();
    await page.getByTestId(`asset-picker-item-${assetId}`).click();
    await page.getByTestId('asset-picker-confirm').click();
    await expect(page.getByTestId('studio-inspector')).toContainText(assetId);

    expect(forbiddenCalls).toEqual([]);
    await page.reload();
    await expect(page.getByTestId('studio-empty-state')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('studio-persistence-flag')).toBeVisible();
  });
});
