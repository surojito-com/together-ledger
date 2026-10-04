import { createServer } from 'node:net';
import { defineConfig } from '@playwright/test';

// Each run serves this checkout on a port it owns, so a dev server left
// running in another checkout or worktree can never answer for it (#170).
// The runner picks the port once; workers inherit it through the environment.
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

if (!process.env.QA_BASE_URL && !process.env.PLAYWRIGHT_PORT) {
  process.env.PLAYWRIGHT_PORT = String(await freePort());
}
const localURL = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT}`;

export default defineConfig({
  testDir: './tests',
  testMatch: 'browser-*.spec.js',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: process.env.QA_BASE_URL || localURL,
    browserName: 'chromium',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: process.env.QA_BASE_URL ? undefined : {
    command: 'npm run dev',
    url: localURL,
    env: { PORT: process.env.PLAYWRIGHT_PORT },
    reuseExistingServer: false,
  },
});
