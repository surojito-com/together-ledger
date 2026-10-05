import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// No build of the phone app can reach a Stripe checkout (#268). Both stores refuse an app that
// sends people to a web page to pay for something used inside it (Apple 3.1.1 and 3.1.3), and the
// phones launch free with no purchase screen (#267). A comment saying so would not survive the
// purchase work that follows (TL-P-05 onward), so this reads everything the phone's bundle can
// reach: every file under app/ and src/, and every file outside the app that they import, all the
// way down. In-app purchase is not forbidden here; Stripe, a web checkout and a price are.

const root = fileURLToPath(new URL('..', import.meta.url));
const mobile = join(root, 'apps/mobile');
const SOURCE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

const FORBIDDEN = [
  [/stripe/i, 'names Stripe'],
  [/checkout/i, 'names a checkout'],
  [/portal-sessions|billingPortal|customer portal/i, 'opens the billing portal'],
  [/Linking\.openURL|openBrowserAsync|openAuthSessionAsync|expo-web-browser|WebBrowser\b/, 'opens a web page, the route to a web purchase'],
  [/[$€£]\s?\d|\b(?:USD|EUR|GBP)\s?\d|\/\s?(?:month|mo|year|yr)\b|\bper (?:month|year)\b/i, 'shows a price'],
];

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path));
    else if (SOURCE.has(extname(entry.name))) found.push(path);
  }
  return found;
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

// A relative import as Metro resolves it: the path itself (source, JSON or an asset), or with a
// source extension, or an index.
async function resolveImport(from, specifier) {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, ...[...SOURCE].map((ext) => base + ext), ...[...SOURCE].map((ext) => join(base, `index${ext}`))]) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

// Every file the phone's bundle can reach, starting from its own sources.
async function reachable() {
  const queue = [...await walk(join(mobile, 'app')), ...await walk(join(mobile, 'src'))];
  const seen = new Map();
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    const source = await readFile(file, 'utf8');
    seen.set(file, source);
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = await resolveImport(file, specifier);
      assert.ok(target, `${relative(root, file)} imports ${specifier}, which does not resolve`);
      // Data and assets (theme tokens, fonts) are bundled but run nothing, so only code is followed.
      if (SOURCE.has(extname(target))) queue.push(target);
    }
  }
  return seen;
}

const files = await reachable();

test('the guard reads beyond the app: the shared files the phone imports are in scope', () => {
  const names = [...files.keys()].map((file) => relative(root, file));
  assert.ok(names.includes('apps/mobile/app/moment.tsx'));
  assert.ok(names.includes('apps/mobile/src/api/client.ts'));
  assert.ok(names.includes('src/moment-themes.js'), 'a root module the phone imports is read too');
  assert.ok(names.includes('src/model.js'));
});

test('nothing the phone can reach names Stripe, a checkout, the portal, a web page to pay on, or a price (#268)', () => {
  for (const [file, source] of files) {
    for (const [pattern, reason] of FORBIDDEN) {
      const match = pattern.exec(source);
      assert.equal(match, null, `${relative(root, file)} ${reason}: "${match?.[0]}". The phone app sells nothing outside the store (#268).`);
    }
  }
});

test('the web\'s client, which does open Stripe, is never part of the phone', () => {
  const names = [...files.keys()].map((file) => relative(root, file));
  assert.equal(names.includes('src/api.js'), false, 'src/api.js carries createImageCheckout and createLocationCheckout');
  assert.equal(names.includes('src/app.js'), false);
});

test('the phone depends on no payment SDK and no in-app browser', async () => {
  const pkg = JSON.parse(await readFile(join(mobile, 'package.json'), 'utf8'));
  const app = await readFile(join(mobile, 'app.json'), 'utf8');
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    assert.doesNotMatch(name, /stripe|web-browser|inappbrowser|webview/i, name);
  }
  assert.doesNotMatch(app, /stripe|merchantIdentifier/i);
});

test('the phone\'s client has no method that starts a checkout or opens the portal', async () => {
  const client = await readFile(join(mobile, 'src/api/client.ts'), 'utf8');
  const methods = [...client.matchAll(/^\s{4}async (\w+)\s*[<(]/gm)].map((match) => match[1]);
  assert.ok(methods.includes('billingStatus'), 'reading where capacity stands stays');
  for (const method of methods) assert.doesNotMatch(method, /checkout|portal/i, method);
});
