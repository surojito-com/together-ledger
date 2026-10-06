import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { generate, MOBILE_PRIVACY_PATH, serialize, spans } from '../scripts/mobile-policies.mjs';

// Both stores ask that the privacy policy can be read from inside the app. The phone shows it on
// its own Privacy screen, generated from PRIVACY.md (scripts/mobile-policies.mjs), because the
// phone opens no web page (#268).

const root = fileURLToPath(new URL('..', import.meta.url));
const mobile = join(root, 'apps/mobile');
const read = (path) => readFile(join(mobile, path), 'utf8');
const words = (runs) => runs.map((run) => run.text).join('');

test('the phone\'s privacy policy is PRIVACY.md, not a copy kept by hand', async () => {
  assert.equal(await readFile(MOBILE_PRIVACY_PATH, 'utf8'), serialize(await generate()), 'privacy.json is stale: run node scripts/mobile-policies.mjs --write');
});

test('a policy run keeps its words and drops its marks', () => {
  assert.deepEqual(spans('Write to **us** at `legal@` or see [stripe.com/privacy](https://stripe.com/privacy).'), [
    { text: 'Write to ' }, { text: 'us', bold: true }, { text: ' at ' }, { text: 'legal@', code: true }, { text: ' or see ' }, { text: 'stripe.com/privacy' }, { text: '.' },
  ]);
});

test('nothing in the phone\'s policy is left as Markdown, and the repository-only section stays off', async () => {
  const text = await readFile(MOBILE_PRIVACY_PATH, 'utf8');
  assert.doesNotMatch(text, /\]\(|\*\*|`/);
  assert.doesNotMatch(text, /Never place in this public repository/);
});

test('Settings opens the Privacy screen for everyone, signed in or not', async () => {
  const settings = await read('app/settings.tsx');
  const route = settings.indexOf("router.push('/privacy')");
  assert.ok(route > -1, 'Settings routes to /privacy');
  // The privacy entry sits after the signed-in/signed-out account block, outside either branch.
  assert.ok(route > settings.indexOf('Sign in to manage or delete your account.'), 'it is not inside a signed-in branch');
  assert.match(await read('app/privacy.tsx'), /from '\.\.\/src\/policies\/privacy\.json'/);
  assert.match(await read('app/_layout.tsx'), /<Stack\.Screen name="privacy"/);
});

test('the addresses on the phone are the ones PRIVACY.md gives', async () => {
  const policy = await readFile(join(root, 'PRIVACY.md'), 'utf8');
  const settings = await read('app/settings.tsx');
  for (const address of ['ledger-support@together-ledger.com', 'legal@together-ledger.com']) {
    assert.ok(policy.includes(address), `PRIVACY.md names ${address}`);
    assert.ok(settings.includes(address), `Settings names ${address}`);
  }
});

// The policy says who processes payments, which is a disclosure it has to make. It is the one
// place the phone carries the words the #268 guard keeps out of its code, so where they may
// appear is pinned here: a new mention elsewhere in the policy fails until someone looks at it.
test('payment words reach the phone only in the policy\'s disclosure sections', async () => {
  const policy = JSON.parse(await readFile(MOBILE_PRIVACY_PATH, 'utf8'));
  const allowed = new Set(['Payments', 'Service providers', 'Deletion']);
  const payment = /stripe|checkout|customer portal|[$€£]\s?\d|\bper (?:month|year)\b/i;
  let section = '(before the first section)';
  for (const block of policy.blocks) {
    if (block.kind === 'heading' && block.level === 2) {
      section = words(block.spans);
      continue;
    }
    const text = block.kind === 'list' ? block.items.map(words).join(' ') : words(block.spans);
    if (payment.test(text)) assert.ok(allowed.has(section), `"${section}" names payment: ${text}`);
  }
});
