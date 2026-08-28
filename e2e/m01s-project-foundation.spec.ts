/**
 * V2 M01-S — Project / Workspace Foundation (Playwright).
 *
 * Runs against the LOCAL TEST DATABASE with a LOCAL TEST ACCOUNT created by
 * global-setup.cjs. No production credentials, no production data.
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

test.describe('M01-S Project Foundation E2E', () => {
  test.beforeEach(async ({ page }) => {
    // Real login flow through legacy auth page (V2 reuses production session).
    await page.goto('/login');
    await page.getByPlaceholder('\u90ae\u7bb1').fill(E2E_EMAIL);
    await page.getByPlaceholder('\u5bc6\u7801').fill(E2E_PASSWORD);
    const [loginRes] = await Promise.all([
      page.waitForResponse(/api\/auth\/login/),
      page.getByRole('button', { name: '\u767b\u5f55', exact: true }).click(),
    ]);
    expect(loginRes.ok()).toBe(true);
    try {
      await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });
    } catch (e) {
      await page.waitForTimeout(1000);
      throw e;
    }
  });

  test('open projects page, create project, open overview, reload, archive', async ({ page }) => {
    // Projects list
    await page.goto('/__v2/projects');
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible({ timeout: 15_000 });

    // Create project
    await page.getByTestId('create-project').click();
    await expect(page).toHaveURL(/\/__v2\/projects\/new/);
    const projectName = `E2E Project ${Date.now()}`;
    await page.getByTestId('project-name-input').fill(projectName);
    await page.getByTestId('submit-project').click();

    // Project overview
    await expect(page).toHaveURL(/\/__v2\/projects\/[^/]+$/);
    await expect(page.getByTestId('project-overview')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('project-overview').getByText(projectName)).toBeVisible();

    // Reload and verify persistence
    await page.reload();
    await expect(page.getByTestId('project-overview')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('project-overview').getByText(projectName)).toBeVisible();

    // Studio entry contract (M05-A: placeholder replaced by the real Studio shell)
    await page.getByRole('button', { name: 'Open Studio' }).click();
    await expect(page).toHaveURL(/\/__v2\/projects\/[^/]+\/studio/);
    await expect(page.getByTestId('studio-page')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('studio-canvas')).toBeVisible();
    await expect(page.getByTestId('studio-persistence-flag')).toBeVisible();

    // Back to overview and archive
    await page.goto('/__v2/projects');
    await page.getByTestId('project-card').getByText(projectName).click();
    await page.getByRole('button', { name: '归档项目' }).click();

    // Verify archived behavior: status badge changes and restore button appears
    await expect(page.getByTestId('project-overview').getByText('archived')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: '恢复项目' })).toBeVisible();
  });
});
