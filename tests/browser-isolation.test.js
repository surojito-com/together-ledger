import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

// The browser suite must never reach production (tests/browser-test.js). A spec that imports
// Playwright's own `test` skips the cut-off, and the calls it does not fake go to production again:
// that is what made CI fail a different set of browser tests on every run.

const dir = new URL('./', import.meta.url);
const specs = (await readdir(dir)).filter((name) => /^browser-.*\.spec\.js$/.test(name));

test('every browser spec takes its test from tests/browser-test.js', async () => {
  assert.ok(specs.length >= 6, 'the browser specs are found');
  for (const name of specs) {
    const source = await readFile(new URL(name, dir), 'utf8');
    assert.doesNotMatch(source, /from '@playwright\/test'/, `${name} imports Playwright directly, so it can reach production`);
    assert.match(source, /import \{ test, expect \} from '\.\/browser-test\.js';/, `${name} takes test from browser-test.js`);
  }
});

test('the shared test cuts off production unless a run is aimed at a deployment', async () => {
  const shared = await readFile(new URL('browser-test.js', dir), 'utf8');
  assert.match(shared, /together-ledger\\\.com/, 'it names production');
  assert.match(shared, /if \(!process\.env\.QA_BASE_URL\) await page\.route\(PRODUCTION, \(route\) => route\.abort\(/);
  const { test: shared_test } = await import('./browser-test.js');
  assert.equal(typeof shared_test.extend, 'function', 'it is a Playwright test');
});
