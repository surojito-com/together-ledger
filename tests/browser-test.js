// The browser suite runs against the local dev server, but the page it serves still names the
// production API (index.html, together-api-origin). A test fakes the calls it cares about; any call
// it does not fake used to go to production. How that turned out depended on the machine: from this
// container it failed at once, from a GitHub runner production (or Cloudflare refusing automated
// traffic) answered at its own speed. The page shows "Private sync is temporarily unreachable." when
// such a call fails, and whether that banner arrived before or after an assertion decided which
// tests failed, so CI failed a different set on every run.
//
// So every test takes `test` from here. Before the test body runs, every request to
// *.together-ledger.com is cut off, the same on every machine; routes a test adds afterwards take
// precedence (Playwright runs the most recently added matching route first), so its own fakes still
// answer. A run aimed at a real deployment (QA_BASE_URL) is meant to reach it and is left alone.
//
// tests/browser-isolation.test.js fails if a browser spec imports Playwright's own `test` instead.

import { test as base, expect } from '@playwright/test';

const PRODUCTION = /^https?:\/\/(?:[a-z0-9-]+\.)*together-ledger\.com(?:[:/]|$)/i;

export const test = base.extend({
  page: async ({ page }, use) => {
    if (!process.env.QA_BASE_URL) await page.route(PRODUCTION, (route) => route.abort('internetdisconnected'));
    await use(page);
  },
});

export { expect };
