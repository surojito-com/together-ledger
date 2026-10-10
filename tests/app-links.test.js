import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { APP_SITE_ASSOCIATION, appSiteAssociationProblems, APPLE_APP_ID, ASSET_LINKS, assetLinksProblems, INVITATION_PATH } from '../scripts/app-links.mjs';
import { INVITATION_PATH as MAILED_PATH } from '../server/mailer.js';

// A tapped invitation opens the phone app when it is installed, and the website when it isn't:
// one link everywhere (#266). Apple and Android each read a file from the website to allow it, and
// both fail silently when it is wrong, so what they say is held here. Proving it on a real phone,
// by tapping a real link, is still the owner's step (the PR lists it).

const root = fileURLToPath(new URL('..', import.meta.url));
const publicFile = (path) => readFileSync(join(root, 'public', path), 'utf8');
const app = JSON.parse(readFileSync(join(root, 'apps/mobile/app.json'), 'utf8')).expo;

test('the invitation path is the same in the email, the website and the phone', async () => {
  assert.equal(INVITATION_PATH, '/invite');
  assert.equal(MAILED_PATH, INVITATION_PATH);
  assert.match(readFileSync(join(root, 'src/app.js'), 'utf8'), /const INVITATION_PATH = '\/invite';/);
  assert.match(readFileSync(join(root, 'apps/mobile/src/invitations/invitation-link.ts'), 'utf8'), /export const INVITATION_PATH = '\/invite';/);
});

test('apple-app-site-association names this app and claims the invitation path and nothing else', () => {
  const text = publicFile(APP_SITE_ASSOCIATION);
  assert.deepEqual(appSiteAssociationProblems(text), []);
  assert.deepEqual(JSON.parse(text), {
    applinks: {
      details: [{
        appIDs: ['769MBW6826.com.togetherledger.ledger'],
        components: [{ '/': '/invite', comment: 'Invitation links only (#266). The code is after the #. Verification and recovery links stay on the web.' }],
      }],
    },
  });
  assert.equal(APPLE_APP_ID, `769MBW6826.${app.ios.bundleIdentifier}`, 'the Team ID and the bundle identifier the app is built with');
  // What must never be claimed: the home page, where verification and recovery links land.
  for (const wrong of [
    { '/': '*' }, { '/': '/' }, { '/': '/*' }, { '/': '/invite*' }, { '/': '/invite', '#': '*' },
  ]) {
    const claimed = JSON.stringify({ applinks: { details: [{ appIDs: [APPLE_APP_ID], components: [wrong] }] } });
    assert.notDeepEqual(appSiteAssociationProblems(claimed), [], JSON.stringify(wrong));
  }
  assert.notDeepEqual(appSiteAssociationProblems(JSON.stringify({ applinks: { details: [{ appIDs: [APPLE_APP_ID], paths: ['*'] }] } })), []);
  assert.notDeepEqual(appSiteAssociationProblems('{'), []);
});

test('assetlinks.json holds a marked placeholder for the owner\'s fingerprints, and is refused until they replace it', () => {
  const text = publicFile(ASSET_LINKS);
  const [statement] = JSON.parse(text);
  assert.equal(statement.target.package_name, app.android.package);
  assert.deepEqual(statement.relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(statement.target.sha256_cert_fingerprints.length, 2, 'the app signing key and the upload key');
  assert.ok(statement.target.sha256_cert_fingerprints.every((value) => value.startsWith('OWNER-TO-SUPPLY: Play Console > Test and release > App integrity')));
  assert.match(assetLinksProblems(text).join(), /placeholder/);

  const withFingerprints = (fingerprints) => JSON.stringify([{ ...statement, target: { ...statement.target, sha256_cert_fingerprints: fingerprints } }]);
  const real = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, '0').toUpperCase()).join(':');
  assert.deepEqual(assetLinksProblems(withFingerprints([real])), []);
  assert.deepEqual(assetLinksProblems(withFingerprints([real, real.replace(/^00/, 'FF')])), []);
  assert.match(assetLinksProblems(withFingerprints([])).join(), /no certificate fingerprint/, 'never shipped empty');
  assert.match(assetLinksProblems(withFingerprints([real.toLowerCase()])).join(), /placeholder|not a SHA-256/);
  assert.match(assetLinksProblems(withFingerprints([real, 'OWNER-TO-SUPPLY'])).join(), /placeholder/, 'one filled in and one left is still refused');
  assert.match(assetLinksProblems(withFingerprints([real.slice(3)])).join(), /not a SHA-256/);
  const otherPackage = JSON.stringify([{ ...statement, target: { ...statement.target, package_name: 'com.example.other', sha256_cert_fingerprints: [real] } }]);
  assert.match(assetLinksProblems(otherPackage).join(), /must name com\.togetherledger\.ledger/);
});

test('each file is served as application/json: Apple\'s by a rule, Android\'s by its extension', () => {
  const headers = publicFile('_headers');
  const rules = new Map();
  let path = null;
  for (const line of headers.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    if (!/^\s/.test(line)) { path = line.trim(); rules.set(path, []); continue; }
    rules.get(path).push(line.trim());
  }
  assert.deepEqual(rules.get('/.well-known/apple-app-site-association'), ['Content-Type: application/json']);
  // A rule here would label the app page as JSON at that address while the file is left out.
  assert.equal(rules.has('/.well-known/assetlinks.json'), false);
  assert.ok(ASSET_LINKS.endsWith('.json'));
  // The local server and the capture both type a .json file the same way.
  assert.match(readFileSync(join(root, 'scripts/dev.mjs'), 'utf8'), /'\.json': 'application\/json'/);
});

test('the assembled site carries Apple\'s file as written, and leaves Android\'s out while it holds a placeholder', () => {
  const out = mkdtempSync(join(tmpdir(), 'tl-site-'));
  try {
    const said = execFileSync(process.execPath, [join(root, 'scripts/build-public-site.mjs'), '--out', join(out, '_site')], { encoding: 'utf8' });
    assert.equal(readFileSync(join(out, '_site', APP_SITE_ASSOCIATION), 'utf8'), publicFile(APP_SITE_ASSOCIATION));
    assert.equal(existsSync(join(out, '_site', ASSET_LINKS)), false, 'a placeholder never ships');
    assert.match(said, /Left out \.well-known\/assetlinks\.json/);
    assert.ok(existsSync(join(out, '_site', 'index.html')));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the phone claims the same one link: Associated Domains on iOS, a verified App Link on Android', () => {
  assert.deepEqual(app.ios.associatedDomains, ['applinks:app.together-ledger.com']);
  assert.deepEqual(app.android.intentFilters, [{
    action: 'VIEW',
    autoVerify: true,
    data: [{ scheme: 'https', host: 'app.together-ledger.com', path: '/invite' }],
    category: ['BROWSABLE', 'DEFAULT'],
  }]);
  // Its own scheme is unchanged, and no other web address is claimed.
  assert.equal(app.scheme, 'togetherledger');
  assert.doesNotMatch(JSON.stringify(app), /pathPrefix|pathPattern|applinks:(?!app\.together-ledger\.com)|webcredentials/);
});
