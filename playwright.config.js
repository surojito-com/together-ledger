import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'browser-pr0003.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: process.env.QA_BASE_URL || 'http://127.0.0.1:4174',
    browserName: 'chromium',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
