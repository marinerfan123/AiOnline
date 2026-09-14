/**
 * V2 M05-A — Infinite Canvas Foundation (Playwright).
 *
 * LOCAL TEST DB + local test account (global setup). No production
 * credentials, no external network (asset URLs are local test fixtures).
 *
 * Verifies the real M05-A contract:
 *  - Studio route through ProjectShell/ProjectContext (authorization)
 *  - Studio layout (library / canvas / inspector / dock), canvas as subject
 *  - empty state + adding a Prompt node from the library
 *  - inspector prompt editing (ephemeral session state, no backend call)
 *  - Reference node + AssetPicker selecting a test asset → node stores assetId
 *  - legal typed connection (TEXT→TEXT) and illegal connection feedback
 *  - duplicate / multi-select / delete
 *  - undo / redo
 *  - reload behavior: honest (session canvas is NOT persisted in M05-A)
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

test.describe('M05-A Infinite Canvas E2E', () => {
  let projectId: string;

  test.beforeEach(async ({ page }) => {
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
    const projectName = `M05A Canvas E2E ${Date.now()}`;
    await page.getByTestId('project-name-input').fill(projectName);
    const [projectRes] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/v2/projects') && res.request().method() === 'POST'),
      page.getByTestId('submit-project').click(),
    ]);
    expect(projectRes.status()).toBe(201);
    const body = await projectRes.json();
    return body.project.id as string;
  }

  test('studio shell, nodes, typed connections, asset ref, undo/redo, reload honesty', async ({ page }) => {
    projectId = await createProject(page);
    await page.goto(`/__v2/projects/${projectId}/studio`);

    // ── ProjectShell + ProjectContext: studio page is the real shell ──
    await expect(page.getByTestId('studio-page')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('project-shell-nav')).toBeVisible();
    await expect(page.getByTestId('studio-canvas')).toBeVisible();
    await expect(page.getByTestId('studio-node-library')).toBeVisible();
    await expect(page.getByTestId('studio-inspector')).toBeVisible();
    await expect(page.getByTestId('studio-bottom-dock')).toBeVisible();
    await expect(page.getByTestId('studio-save-status')).toBeVisible();

    // ── empty state ──
    await expect(page.getByTestId('studio-empty-state')).toBeVisible();

    // ── add Prompt node from library (click-to-add) ──
    await page.getByTestId('node-library-item-prompt').click();
    await expect(page.getByTestId('studio-empty-state')).toHaveCount(0);
    const cardOf = (kind: string) => page.locator(`[data-test="studio-node-card"][data-node-kind="${kind}"]`);
    const promptCard = cardOf('prompt').first();
    await expect(promptCard).toBeVisible();
    expect(await promptCard.getAttribute('data-node-kind')).toBe('prompt');

    // ── edit prompt in inspector (ephemeral — assert no backend traffic) ──
    await promptCard.click();
    const apiHits: string[] = [];
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('/api/v2/assets') || u.includes('/api/generate') || u.includes('/api/v2/generation')) apiHits.push(u);
    });
    await page.getByTestId('inspector-prompt').fill('a cinematic lighthouse at dusk');
    await page.getByTestId('inspector-prompt').pressSequentially(' frame', { delay: 20 }); // extra keystrokes
    await page.getByTestId('inspector-prompt').blur();
    // text editing is client-session only: zero backend generation/asset traffic
    expect(apiHits, `unexpected backend calls while editing: ${apiHits.join(', ')}`).toHaveLength(0);
    await expect(page.getByTestId('inspector-prompt')).toHaveValue('a cinematic lighthouse at dusk frame');

    // ── add Reference node and select a test asset via AssetPicker ──
    // Create the fixture asset FIRST so the picker's query (enabled on open)
    // can list it; the picker does not auto-refetch while open.
    const created = await page.evaluate(async (pid) => {
      const res = await fetch('/api/v2/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          projectId: pid,
          url: 'http://127.0.0.1/test-fixtures/m05a-e2e-ref.png',
          title: 'M05A E2E ref fixture',
          assetType: 'IMAGE',
          mimeType: 'image/png',
          width: 160,
          height: 90,
          sizeBytes: 1024,
        }),
      });
      return { status: res.status, body: await res.json() };
    }, projectId);
    expect(created.status).toBe(201);
    const assetId = created.body.asset.assetId as string;
    expect(assetId).toMatch(/^m-/);

    await page.getByTestId('node-library-item-reference').click();
    const refCard = cardOf('reference').first();
    await expect(refCard).toBeVisible();
    await refCard.click();
    await page.getByTestId('inspector-open-asset-picker').click();

    await expect(page.getByTestId('asset-picker')).toBeVisible();
    await page.getByTestId(`asset-picker-item-${assetId}`).click();
    await page.getByTestId('asset-picker-confirm').click();
    // node now references the asset by assetId only (permanent identity)
    await expect(page.getByTestId('studio-inspector')).toContainText(assetId);

    // ── typed connection: prompt(TEXT out) → reference has no input ports, so
    //    connect prompt → script(TEXT in) is legal; prompt(TEXT) → video(VIDEO) is illegal ──
    await page.getByTestId('node-library-item-script').click();
    await page.getByTestId('node-library-item-video').click();
    const scriptCard = cardOf('script').first();
    const videoCard = cardOf('video').first();

    // Zoom to fit the whole graph so all connection endpoints are in the
    // visible viewport (onlyRenderVisibleElements culls off-screen nodes).
    await page.getByTestId('canvas-fit').click();
    await page.waitForTimeout(400); // fitView animation (200ms) settles

    // positions via bounding boxes
    const pBox = await promptCard.boundingBox();
    const sBox = await scriptCard.boundingBox();
    const vBox = await videoCard.boundingBox();
    expect(pBox && sBox && vBox).toBeTruthy();

    // Connect by dragging from the source node's OUTPUT handle to the target
    // node's INPUT handle (real element coords — robust to node size/overlap).
    const handlePoint = async (card: import('@playwright/test').Locator, type: 'source' | 'target') => {
      const h = card.locator(`.react-flow__handle.${type}`).first();
      const b = await h.boundingBox();
      if (!b) throw new Error(`handle ${type} not found`);
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const connect = async (fromCard: import('@playwright/test').Locator, toCard: import('@playwright/test').Locator) => {
      const from = await handlePoint(fromCard, 'source');
      const to = await handlePoint(toCard, 'target');
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await page.mouse.up();
    };
    // prompt source handle = right edge, ~vertical center; target = left edge
    await connect(promptCard, scriptCard);
    // legal TEXT→TEXT: edge appears
    await expect(page.locator('.react-flow__edge').first()).toBeVisible({ timeout: 5000 });
    const edgeCount = await page.locator('.react-flow__edge').count();

    // illegal TEXT→VIDEO(REFERENCE): rejected with UI feedback, no new edge
    await connect(promptCard, videoCard);
    await expect(page.getByTestId('invalid-connection-toast')).toBeVisible({ timeout: 5000 });
    expect(await page.locator('.react-flow__edge').count()).toBe(edgeCount);

    // ── duplicate (Ctrl+D) mints a new node ──
    await scriptCard.click();
    const nodesBefore = await page.getByTestId('studio-node-card').count();
    await page.keyboard.press('Control+KeyD');
    expect(await page.getByTestId('studio-node-card').count()).toBe(nodesBefore + 1);

    // ── multi-select + delete: select all (Ctrl+A) then Delete ──
    await page.locator('.react-flow__pane').click({ position: { x: 10, y: 10 } });
    await page.keyboard.press('Control+KeyA');
    expect(await page.locator('.react-flow__node.selected').count()).toBeGreaterThan(1);
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('studio-node-card')).toHaveCount(0, { timeout: 5000 });
    await expect(page.getByTestId('studio-empty-state')).toBeVisible();

    // ── undo restores the deleted graph ──
    await page.getByTestId('canvas-undo').click();
    const restored = await page.getByTestId('studio-node-card').count();
    expect(restored).toBeGreaterThan(0);
    // redo removes again
    await page.getByTestId('canvas-redo').click();
    await expect(page.getByTestId('studio-node-card')).toHaveCount(0);

    // ── M05-C persistence: created prompt survives reload after server ACK ──
    await page.getByTestId('node-library-item-prompt').click();
    expect(await page.getByTestId('studio-node-card').count()).toBe(1);
    await expect(page.getByTestId('studio-save-status')).toContainText('Saved', { timeout: 10_000 });
    await page.reload();
    await expect(page.getByTestId('studio-page')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('studio-node-card').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('studio-save-status')).toBeVisible();
  });

  test('bottom dock tabs are reserved placeholders, not fake features', async ({ page }) => {
    projectId = await createProject(page);
    await page.goto(`/__v2/projects/${projectId}/studio`);
    await expect(page.getByTestId('studio-bottom-dock')).toBeVisible({ timeout: 15_000 });
    for (const t of ['shots', 'timeline', 'runs']) {
      await page.getByTestId(`dock-tab-${t}`).click();
      await expect(page.getByTestId('studio-bottom-dock')).toContainText('M05');
      await page.getByTestId('dock-close').click();
    }
    await page.getByTestId('dock-tab-versions').click();
    await expect(page.getByTestId('studio-versions-panel')).toBeVisible();
    await page.getByTestId('dock-close').click();
  });

  test('studio layout keeps canvas primary across commercial desktop viewports', async ({ page }) => {
    projectId = await createProject(page);
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 1440, height: 900 },
      { width: 1366, height: 768 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`/__v2/projects/${projectId}/studio`);
      await expect(page.getByTestId('studio-page')).toBeVisible({ timeout: 15_000 });

      const layout = await page.evaluate(() => {
        const box = (selector: string) => {
          const el = document.querySelector(selector) as HTMLElement | null;
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          canvas: box('[data-test="studio-canvas"]'),
          library: box('[data-test="studio-node-library"]'),
          inspector: box('[data-test="studio-inspector"]'),
          dock: box('[data-test="studio-bottom-dock"]'),
          toolbar: box('[data-test="studio-top-toolbar"]'),
          doc: { scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight },
        };
      });

      expect(layout.canvas, `${viewport.width} canvas missing`).toBeTruthy();
      expect(layout.library, `${viewport.width} library missing`).toBeTruthy();
      expect(layout.inspector, `${viewport.width} inspector missing`).toBeTruthy();
      expect(layout.dock, `${viewport.width} dock missing`).toBeTruthy();
      expect(layout.toolbar, `${viewport.width} toolbar missing`).toBeTruthy();
      expect(layout.canvas!.width, `${viewport.width} canvas width`).toBeGreaterThan(650);
      expect(layout.canvas!.height, `${viewport.width} canvas height`).toBeGreaterThan(520);
      expect(layout.library!.right, `${viewport.width} library must not overlay canvas`).toBeLessThanOrEqual(layout.canvas!.left + 1);
      expect(layout.inspector!.left, `${viewport.width} inspector must not overlay canvas`).toBeGreaterThanOrEqual(layout.canvas!.right - 1);
      expect(layout.dock!.height, `${viewport.width} dock controlled height`).toBeLessThanOrEqual(100);
      expect(layout.toolbar!.height, `${viewport.width} toolbar controlled height`).toBeLessThanOrEqual(52);
      expect(layout.doc.scrollWidth, `${viewport.width} no horizontal overflow`).toBeLessThanOrEqual(layout.viewport.width + 1);
    }
  });
});
