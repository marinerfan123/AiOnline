/**
 * V2 M00 — platform smoke (Playwright).
 *
 * Scope: /__v2 preview shell only. Verifies:
 *   - unauthenticated /__v2 → login redirect (RequireAuthV2 UX guard)
 *   - authenticated: App Shell renders, sidebar nav works, sidebar collapse,
 *     health contract card reaches a resolved state (not stuck loading).
 *
 * Auth credentials come from E2E_EMAIL / E2E_PASSWORD env vars. When absent,
 * the authenticated scenario is skipped (the unauthenticated guard still runs),
 * so the smoke never hard-fails on a machine without a local account.
 *
 * NOTE: V2 shell components use the `data-test` attribute (not `data-testid`);
 * playwright.config.ts sets testIdAttribute: 'data-test' globally.
 */
import { test, expect } from '@playwright/test';

const E2E_EMAIL = process.env.E2E_EMAIL;
const E2E_PASSWORD = process.env.E2E_PASSWORD;

const byTest = (page: any, id: string) => page.getByTestId(id);

test.describe('M00 /__v2 preview shell', () => {
  test('unauthenticated /__v2 redirects to /login (UX guard)', async ({ page }) => {
    await page.goto('/__v2');
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  });

  test('authenticated: shell + nav + health contract resolve', async ({ page }) => {
    test.skip(!E2E_EMAIL || !E2E_PASSWORD, 'E2E_EMAIL/E2E_PASSWORD not set');

    // Login on the legacy auth page (V2 reuses the production session).
    await page.goto('/login');
    await page.getByPlaceholder('邮箱').fill(E2E_EMAIL);
    await page.getByPlaceholder('密码').fill(E2E_PASSWORD);
    await page.getByRole('button', { name: '登录', exact: true }).click();

    // Session established → legacy landing reachable.
    await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });

    await page.goto('/__v2');
    // App shell
    await expect(page.getByText('Moling V2')).toBeVisible();
    await expect(byTest(page, 'v2-content')).toBeVisible();
    // Dashboard
    await expect(page.getByText('V2 平台基础预览 · 无业务模块')).toBeVisible();

    // Health contract card must reach a resolved state (not stuck on 检测中) —
    // backend on the dev proxy target answers /api/healthz.
    const healthCard = page.locator('h3', { hasText: '健康检查 (contract proof)' }).locator('..');
    await expect(healthCard.getByText('检测中')).toHaveCount(0, { timeout: 20_000 });
    await expect(healthCard.getByText(/^(健康|ok|down|后端未连接)/)).toBeVisible();

    // Nav: Projects placeholder
    await page.getByRole('link', { name: 'Projects' }).click();
    await expect(page).toHaveURL(/\/__v2\/projects/);
    await expect(page.getByText('项目模块（Phase C）')).toBeVisible();

    // Back to dashboard
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(/\/__v2$/);

    // Sidebar collapse toggle (Zustand appStore). Width animates via CSS
    // transition, so poll until it settles below the expanded width.
    const sidebar = page.locator('aside');
    const widthBefore = await sidebar.evaluate((el) => el.getBoundingClientRect().width);
    await page.getByRole('button', { name: '折叠侧栏' }).click();
    await expect
      .poll(
        async () => sidebar.evaluate((el) => el.getBoundingClientRect().width),
        { timeout: 5000 },
      )
      .toBeLessThan(widthBefore);
    await page.getByRole('button', { name: '展开侧栏' }).click();
    await expect
      .poll(
        async () => sidebar.evaluate((el) => el.getBoundingClientRect().width),
        { timeout: 5000 },
      )
      .toBeGreaterThanOrEqual(widthBefore);
  });
});
