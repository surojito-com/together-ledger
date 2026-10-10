import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderPrivacyPage, renderSupportPage, renderTermsPage } from '../scripts/render-privacy-page.mjs';

// What the website and the phone can send, held where a test can hold it cheaply (TL-C-03, #261).
// The capture itself (scripts/capture-outbound.mjs, docs/OUTBOUND_CAPTURE.md) drives a browser and
// is run by hand; these read files only and make no network call.

const root = fileURLToPath(new URL('..', import.meta.url));

// What scripts/build-public-site.mjs puts in _site: the page, its scripts and stylesheet, public/,
// and the three policy pages rendered from Markdown.
async function shippedWebFiles() {
  const files = new Map();
  for (const path of ['index.html', ...(await readdir(join(root, 'src'))).map((name) => `src/${name}`)]) {
    if (['.html', '.js', '.css'].includes(extname(path))) files.set(path, await readFile(join(root, path), 'utf8'));
  }
  for (const name of await readdir(join(root, 'public'), { recursive: true })) {
    if (['.svg', '.html', '.json', ''].includes(extname(name)) && !name.endsWith('social')) files.set(`public/${name}`, await readFile(join(root, 'public', name), 'utf8'));
  }
  files.set('privacy.html', renderPrivacyPage(await readFile(join(root, 'PRIVACY.md'), 'utf8')));
  files.set('terms.html', renderTermsPage(await readFile(join(root, 'TERMS.md'), 'utf8')));
  files.set('support.html', renderSupportPage(await readFile(join(root, 'SUPPORT.md'), 'utf8')));
  return files;
}

test('nothing the website ships names a cleartext http:// address', async () => {
  for (const [path, text] of await shippedWebFiles()) {
    // An XML namespace is a name, never fetched.
    const cleartext = [...text.matchAll(/http:\/\/[^\s"'<>)]+/g)].map(([url]) => url).filter((url) => !url.startsWith('http://www.w3.org/'));
    assert.deepEqual(cleartext, [], `${path} names a cleartext address`);
  }
});

const FONT_HOSTS = /fonts\.googleapis\.com|fonts\.gstatic\.com|typekit\.net|fonts\.bunny\.net|use\.fontawesome\.com|fast\.fonts\.net/;

test('the website asks for no font: no @font-face, no @import, no font host', async () => {
  const files = await shippedWebFiles();
  const css = files.get('src/styles.css');
  assert.doesNotMatch(css, /@font-face/, 'a font file would be a request; the web uses the system serif and sans (CLAUDE.md, Design system)');
  assert.doesNotMatch(css, /@import/, 'a stylesheet import is a request to wherever it points');
  assert.doesNotMatch(css, /url\(\s*['"]?(?:https?:)?\/\//, 'the stylesheet loads nothing from another address');
  for (const [path, text] of files) assert.doesNotMatch(text, FONT_HOSTS, `${path} names a font host`);
});

test('the page loads from other addresses only its icons, and the scripts only Google and Apple sign-in', async () => {
  const files = await shippedWebFiles();
  const page = files.get('index.html');
  // Every tag the browser fetches for: scripts, stylesheets and icons, preconnects and preloads.
  const loads = [
    ...page.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g),
    ...page.matchAll(/<link\b(?=[^>]*\brel="(?:stylesheet|icon|apple-touch-icon|preconnect|dns-prefetch|preload|prefetch|modulepreload|manifest)")[^>]*\bhref="([^"]+)"/g),
  ].map(([, url]) => url).filter((url) => /^(?:https?:)?\/\//.test(url));
  assert.deepEqual(loads.sort(), ['https://together-ledger.com/apple-touch-icon.png', 'https://together-ledger.com/favicon.svg']);

  // The only addresses the scripts load a script from (src/app.js, PROVIDER_SCRIPTS), and nothing
  // from Stripe: checkout is Stripe's own page, reached by navigating, never by loading Stripe.js.
  const scripts = [...files].filter(([path]) => path.startsWith('src/') && path.endsWith('.js')).map(([, text]) => text).join('\n');
  const scriptHosts = new Set([...scripts.matchAll(/https:\/\/([a-z0-9.-]+)\//g)].map(([, host]) => host));
  assert.deepEqual([...scriptHosts].sort(), ['accounts.google.com', 'appleid.cdn-apple.com']);
  for (const [path, text] of files) assert.doesNotMatch(text, /js\.stripe\.com|m\.stripe\.network/, `${path} loads Stripe's script`);
});

// expo-iap carries an optional service of its author's (IAPKit, kit.openiap.dev) and links to the
// stores' subscription pages. Each is reached only by calling it, and the phone's privacy answers
// rest on never doing so: purchases are checked by our own server (docs/STORE_PURCHASES.md).
test("the phone never calls expo-iap's IAPKit, its verification, or its subscription links", async () => {
  const mobile = join(root, 'apps/mobile');
  for (const directory of ['src', 'app']) {
    for (const name of await readdir(join(mobile, directory), { recursive: true })) {
      if (!['.ts', '.tsx'].includes(extname(name))) continue;
      const text = await readFile(join(mobile, directory, name), 'utf8');
      const path = relative(root, join(mobile, directory, name));
      assert.doesNotMatch(text, /\bkitApi\b|verifyPurchaseWithProvider|\bverifyPurchase\b|deepLinkToSubscriptions|kit\.openiap\.dev/, `${path} reaches past the store into expo-iap's own services`);
    }
  }
});
