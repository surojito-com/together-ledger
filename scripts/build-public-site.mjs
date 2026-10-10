import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { appSiteAssociationProblems, APP_SITE_ASSOCIATION, ASSET_LINKS, assetLinksProblems } from './app-links.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { renderPrivacyPage, renderSupportPage, renderTermsPage } from './render-privacy-page.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// _site unless told otherwise; tests/app-links.test.js assembles into a folder of its own.
const outIndex = process.argv.indexOf('--out');
const output = outIndex > 0 && process.argv[outIndex + 1] ? resolve(process.argv[outIndex + 1]) : join(root, '_site');
const releaseRevision = (process.env.TOGETHER_LEDGER_RELEASE_REVISION || 'local-development').trim();
const publicFiles = [
  'index.html',
  'src/api.js',
  'src/app.js',
  'src/display-text.js',
  'src/history-guide.js',
  'src/leave-journey.js',
  'src/model.js',
  'src/moment-themes.js',
  'src/photo-metadata.js',
  'src/store.js',
  'src/styles.css',
  'src/themes.js',
];

if (releaseRevision !== 'local-development' && !/^[0-9a-f]{40}$/i.test(releaseRevision)) {
  throw new Error('TOGETHER_LEDGER_RELEASE_REVISION must be a full Git commit SHA or local-development.');
}

rmSync(output, { force: true, recursive: true });
mkdirSync(join(output, 'src'), { recursive: true });

for (const relativePath of publicFiles) {
  cpSync(join(root, relativePath), join(output, relativePath));
}
cpSync(join(root, 'public'), output, { recursive: true });
// The phone apps' link files (#266). Apple's must be right to ship at all. Android's waits on the
// owner's certificate fingerprints: until they replace the placeholders it is left out, because an
// empty or placeholder list would only tell Android the app may not open the link, and the release
// gate refuses a bundle that carries one.
const associationProblems = appSiteAssociationProblems(readFileSync(join(output, APP_SITE_ASSOCIATION), 'utf8'));
if (associationProblems.length) throw new Error(associationProblems.join('; '));
const linkProblems = assetLinksProblems(readFileSync(join(output, ASSET_LINKS), 'utf8'));
if (linkProblems.length) {
  rmSync(join(output, ASSET_LINKS));
  console.log(`Left out ${ASSET_LINKS}: ${linkProblems.join('; ')}. Android opens invitation links in the browser until the owner adds the fingerprints (#266).`);
}
// Served at /privacy (html_handling resolves privacy.html) — the URL both stores ask for.
writeFileSync(join(output, 'privacy.html'), renderPrivacyPage(readFileSync(join(root, 'PRIVACY.md'), 'utf8')));
// Served at /terms the same way, from TERMS.md.
writeFileSync(join(output, 'terms.html'), renderTermsPage(readFileSync(join(root, 'TERMS.md'), 'utf8')));
// And /support, from SUPPORT.md: the support URL on both stores.
writeFileSync(join(output, 'support.html'), renderSupportPage(readFileSync(join(root, 'SUPPORT.md'), 'utf8')));
writeFileSync(join(output, 'release.json'), `${JSON.stringify({ revision: releaseRevision }, null, 2)}\n`);

console.log(`Assembled ${publicFiles.length} app files, public assets, the privacy, terms and support pages, and release marker ${releaseRevision} in _site/.`);
