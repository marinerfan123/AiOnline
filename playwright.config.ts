import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// M00/M01-S E2E — global setup spins up a backend pointing at the local test
// database (port 3002), then registers a local-only test account. The Vite dev
// server proxies /api to that backend so all tests run against test data only.
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: path.resolve(__dirname, 'e2e', 'global-setup.cjs'),
  use: {
    baseURL: 'http://localhost:5199',
    trace: 'retain-on-failure',
    testIdAttribute: 'data-test',
  },
});
