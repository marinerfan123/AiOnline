/**
 * V2 M04-S — Asset Foundation (Playwright).
 *
 * Runs against LOCAL TEST DB + local account from global setup. Uses only
 * local/test-safe URLs and verifies the project Assets UI reads the durable
 * /api/v2/assets authority; no production credentials or external network.
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

test.describe('M04-S Asset Foundation E2E', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('\u90ae\u7bb1').fill(E2E_EMAIL);
    await page.getByPlaceholder('\u5bc6\u7801').fill(E2E_PASSWORD);
    const [loginRes] = await Promise.all([
      page.waitForResponse(/api\/auth\/login/),
      page.getByRole('button', { name: '\u767b\u5f55', exact: true }).click(),
    ]);
    expect(loginRes.ok()).toBe(true);
    await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });
  });

  test('create local fixture asset through V2 API and view it on project assets page', async ({ page }) => {
    await page.goto('/__v2/projects/new');
    const projectName = `M04S Assets E2E ${Date.now()}`;
    await page.getByTestId('project-name-input').fill(projectName);
    const [projectRes] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/v2/projects') && res.request().method() === 'POST'),
      page.getByTestId('submit-project').click(),
    ]);
    expect(projectRes.status()).toBe(201);
    const projectBody = await projectRes.json();
    await expect(page).toHaveURL(/\/__v2\/projects\/[^/]+$/);
    const projectId = projectBody.project?.id as string | undefined;
    expect(projectId).toBeTruthy();

    const createResult = await page.evaluate(async (pid) => {
      const res = await fetch('/api/v2/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          projectId: pid,
          url: 'http://127.0.0.1/test-fixtures/m04s-e2e.png',
          title: 'M04S local asset',
          assetType: 'IMAGE',
          mimeType: 'image/png',
          width: 320,
          height: 180,
          sizeBytes: 2048,
        }),
      });
      return { status: res.status, body: await res.json() };
    }, projectId!);
    expect(createResult.status, JSON.stringify(createResult.body)).toBe(201);
    expect(createResult.body.asset.assetId).toMatch(/^m-/);
    expect(createResult.body.asset.url).toContain('/test-fixtures/m04s-e2e.png');

    await page.goto(`/__v2/projects/${projectId}/assets`);
    await expect(page.getByTestId('project-assets')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('M04S local asset')).toBeVisible();
    await page.getByTestId(`asset-card-${createResult.body.asset.assetId}`).click();
    await expect(page.getByText('资产详情')).toBeVisible();
    await expect(page.getByText('320 × 180')).toBeVisible();
    await expect(page.getByText('UPLOAD')).toBeVisible();
  });
});
