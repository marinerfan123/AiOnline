import { defineConfig } from '@playwright/test';

// M00 smoke — drives the Vite dev server (5199) against the local backend
// (default 3001, overridable via API_PROXY_TARGET). Playwright manages the
// dev server lifecycle via webServer; nothing is deployed anywhere.
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5199',
    trace: 'retain-on-failure',
    // V2 M00 shell components use the `data-test` attribute (legacy pages use
    // none), so test-id locators resolve against it.
    testIdAttribute: 'data-test',
  },
  webServer: {
    command: 'npx vite --port 5199 --strictPort',
    url: 'http://localhost:5199',
    timeout: 60_000,
    reuseExistingServer: false,
    env: {
      API_PROXY_TARGET: process.env.API_PROXY_TARGET || 'http://127.0.0.1:3001',
    },
  },
});
