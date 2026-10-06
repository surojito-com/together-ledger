import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// TL-P-02 (#269): a store purchase that does not carry our values cannot be tied to anyone, so the
// person is charged for something nobody can honour. Every purchase is built by purchaseOptions()
// in apps/mobile/src/billing/store-purchase.ts, and this fails if one is started anywhere else.

const root = fileURLToPath(new URL('..', import.meta.url));
const mobile = join(root, 'apps/mobile');
const MODULE = 'apps/mobile/src/billing/store-purchase.ts';

async function importMobile(path) {
  const source = await readFile(join(root, path), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path));
    else if (['.ts', '.tsx', '.js', '.jsx'].includes(extname(entry.name))) found.push(path);
  }
  return found;
}

const store = await importMobile(MODULE);
// Made fresh each run, as the service makes them.
const journeyValue = randomUUID();
const identity = { appAccountToken: journeyValue, obfuscatedAccountId: randomUUID(), obfuscatedProfileId: journeyValue };

test('Apple is given the journey value, and Google the account and the journey', () => {
  assert.deepEqual(store.purchaseOptions(identity, 'ios'), { platform: 'ios', appAccountToken: identity.appAccountToken });
  assert.deepEqual(store.purchaseOptions(identity, 'android'), { platform: 'android', obfuscatedAccountId: identity.obfuscatedAccountId, obfuscatedProfileId: identity.obfuscatedProfileId });
});

test('a purchase without its values never starts, and says nothing was charged', () => {
  const cases = [
    [null, 'ios'],
    [undefined, 'android'],
    [{ ...identity, appAccountToken: '' }, 'ios'],
    [{ ...identity, appAccountToken: 'not-a-uuid' }, 'ios'],
    [{ ...identity, obfuscatedAccountId: '' }, 'android'],
    [{ ...identity, obfuscatedProfileId: undefined }, 'android'],
    [identity, 'web'],
  ];
  for (const [given, platform] of cases) {
    assert.throws(() => store.purchaseOptions(given, platform), (error) => error instanceof store.StorePurchaseRefused && error.code === 'store_identity_missing', `${platform} ${JSON.stringify(given)}`);
  }
  assert.match(store.NOT_STARTED_MESSAGE, /nothing was charged/);
  assert.doesNotMatch(store.NOT_STARTED_MESSAGE, /[$€£]\s?\d|seat|slot|licen[cs]e|upgrade|unlock/i);
});

test('the values come from the service, signed in, for one journey', async () => {
  const client = await readFile(join(mobile, 'src/api/client.ts'), 'utf8');
  assert.match(client, /async storePurchaseIdentity\(journeyId: string\) \{\s*return request<[^>]+>\(`\/journeys\/\$\{encodeURIComponent\(journeyId\)\}\/billing\/store-identity`, \{ method: 'POST', body: \{\}, signedIn: true \}\);/);
});

test('no store purchase is started anywhere but through purchaseOptions()', async () => {
  // The calls StoreKit, Play Billing and the React Native wrappers use to begin a purchase.
  const STARTS = /\b(?:requestPurchase|requestSubscription|launchBillingFlow|purchaseItemAsync|purchaseAsync|buyProduct)\s*\(|\.purchase\s*\(\s*\{/;
  const files = [...await walk(join(mobile, 'app')), ...await walk(join(mobile, 'src'))];
  assert.ok(files.length > 10, 'the guard reads the phone app');
  for (const file of files) {
    const name = relative(root, file);
    const source = await readFile(file, 'utf8');
    const match = STARTS.exec(source);
    if (!match) continue;
    assert.ok(/purchaseOptions\(/.test(source), `${name} starts a store purchase ("${match[0]}") without purchaseOptions() from ${MODULE} (#269)`);
  }
});
