/** V2 M05-C — Canvas persistence + versioning E2E. Local test DB/account only. */
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

test.describe('M05-C Canvas Persistence E2E', () => {
  test.beforeEach(async ({ page }) => {
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
    await page.getByTestId('project-name-input').fill(`M05C Canvas E2E ${Date.now()}`);
    const [projectRes] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/v2/projects') && res.request().method() === 'POST'),
      page.getByTestId('submit-project').click(),
    ]);
    expect(projectRes.status()).toBe(201);
    const body = await projectRes.json();
    return body.project.id as string;
  }

  test('autosave persists nodes, versions restore, stale patch conflicts, no generation', async ({ page }) => {
    const forbiddenCalls: string[] = [];
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('/api/generate') || u.includes('/api/v2/generation')) forbiddenCalls.push(u);
    });
    const projectId = await createProject(page);
    const canvasResponses: string[] = [];
    page.on('response', async (res) => {
      if (res.url().includes('/studio/canvas')) canvasResponses.push(`${res.request().method()} ${res.status()} ${await res.text().catch(() => '')}`);
    });
    page.on('pageerror', (err) => canvasResponses.push(`PAGEERROR ${err.message}`));
    page.on('console', (msg) => { if (msg.type() === 'error') canvasResponses.push(`CONSOLE ${msg.text()}`); });
    await page.goto(`/__v2/projects/${projectId}/studio`);
    await expect(page.getByTestId('studio-page')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('studio-save-status'), canvasResponses.join('\n')).toContainText('Saved', { timeout: 15_000 });

    await page.getByTestId('node-library-item-prompt').click();
    await page.locator('[data-test="studio-node-card"][data-node-kind="prompt"]').first().click();
    await page.getByTestId('inspector-prompt').fill('m05c persisted prompt');
    await page.getByTestId('inspector-prompt').blur();
    await expect(page.getByTestId('studio-save-status')).toContainText('Saved', { timeout: 15_000 });

    const loaded = await page.evaluate(async (pid) => {
      const r = await fetch(`/api/v2/projects/${pid}/studio/canvas`, { credentials: 'include' });
      return { status: r.status, body: await r.json() };
    }, projectId);
    expect(loaded.status).toBe(200);
    expect(loaded.body.nodes).toHaveLength(1);
    expect(JSON.stringify(loaded.body.nodes[0])).toContain('m05c persisted prompt');
    const baseRevision = loaded.body.canvas.revision as number;

    await page.reload();
    await expect(page.getByTestId('studio-node-card')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.getByTestId('inspector-prompt')).toHaveCount(0);
    await page.locator('[data-test="studio-node-card"][data-node-kind="prompt"]').first().click();
    await expect(page.getByTestId('inspector-prompt')).toHaveValue('m05c persisted prompt');

    const version = await page.evaluate(async (pid) => {
      const r = await fetch(`/api/v2/projects/${pid}/studio/canvas/versions`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'E2E checkpoint' }) });
      return { status: r.status, body: await r.json() };
    }, projectId);
    expect(version.status).toBe(201);

    await page.getByTestId('inspector-prompt').fill('m05c changed prompt');
    await page.getByTestId('inspector-prompt').blur();
    await expect(page.getByTestId('studio-save-status')).toContainText('Saved', { timeout: 15_000 });
    const changed = await page.evaluate(async (pid) => (await (await fetch(`/api/v2/projects/${pid}/studio/canvas`, { credentials: 'include' })).json()), projectId);
    expect(changed.canvas.revision).toBeGreaterThan(baseRevision);

    const stale = await page.evaluate(async ({ pid, base }) => {
      const r = await fetch(`/api/v2/projects/${pid}/studio/canvas`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseRevision: base, clientMutationId: crypto.randomUUID(), viewport: { x: 1, y: 2, zoom: 1 } }) });
      return { status: r.status, body: await r.json() };
    }, { pid: projectId, base: baseRevision });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('CONFLICT');

    const restore = await page.evaluate(async ({ pid, vid, base }) => {
      const r = await fetch(`/api/v2/projects/${pid}/studio/canvas/versions/${vid}/restore`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseRevision: base }) });
      return { status: r.status, body: await r.json() };
    }, { pid: projectId, vid: version.body.version.id, base: changed.canvas.revision });
    expect(restore.status).toBe(200);
    expect(restore.body.canvas.revision).toBe(changed.canvas.revision + 1);
    await page.reload();
    await page.locator('[data-test="studio-node-card"][data-node-kind="prompt"]').first().click();
    await expect(page.getByTestId('inspector-prompt')).toHaveValue('m05c persisted prompt');
    expect(forbiddenCalls).toEqual([]);
  });
});
