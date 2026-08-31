import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const ignored = new Set(['.git', 'node_modules', 'coverage', 'dist']);
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.yml', '.yaml', '.txt']);
const forbidden = [
  /colorado-together-trip/i,
  /surojito\.chatgpt\.site/i,
  /colorado_trip_access/i,
  /TRIP_BYPASS_TOKEN/i,
  /TRIP_PASSCODE_HASH/i,
  /\bSJ\b.*\bFO\b|\bFO\b.*\bSJ\b/,
  /memberOne:\s*['\"]Me['\"]/,
  /memberTwo:\s*['\"]Husband['\"]/,
];
const credentialPatterns = [
  /(?:token|secret|password|passcode|api[_-]?key)\s*[:=]\s*['\"][A-Za-z0-9_\-.]{16,}['\"]/i,
  /Bearer\s+[A-Za-z0-9_\-.]{16,}/i,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
];

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    if (ignored.has(name)) return [];
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const violations = [];
for (const path of files(root)) {
  if (relative(root, path) === 'scripts/check-public-safety.mjs') continue;
  const extension = path.slice(path.lastIndexOf('.'));
  if (!textExtensions.has(extension)) continue;
  const content = readFileSync(path, 'utf8');
  for (const pattern of [...forbidden, ...credentialPatterns]) {
    if (pattern.test(content)) violations.push(`${relative(root, path)} matched ${pattern}`);
  }
}

const homepage = readFileSync(join(root, 'index.html'), 'utf8');
const requiredShareMetadata = [
  'rel="canonical" href="https://together-ledger.com/"',
  'property="og:title"',
  'property="og:image" content="https://together-ledger.com/social/together-ledger-card.png"',
  'property="og:image:width" content="1200"',
  'property="og:image:height" content="630"',
  'property="og:image:alt"',
  'name="twitter:card" content="summary_large_image"',
];
for (const metadata of requiredShareMetadata) {
  if (!homepage.includes(metadata)) violations.push(`index.html is missing ${metadata}`);
}
for (const asset of ['public/favicon.svg', 'public/apple-touch-icon.png', 'public/social/together-ledger-card.png']) {
  if (!existsSync(join(root, asset))) violations.push(`${asset} does not exist`);
}
const favicon = readFileSync(join(root, 'public/favicon.svg'), 'utf8');
if (!favicon.includes('data-mark="knot"') || !favicon.includes('x="6.5"') || !favicon.includes('x="22.5"')) {
  violations.push('favicon.svg must use the locked Knot mark');
}
const touchIconPath = join(root, 'public/apple-touch-icon.png');
if (existsSync(touchIconPath)) {
  const touchIcon = readFileSync(touchIconPath);
  if (touchIcon.readUInt32BE(16) !== 180 || touchIcon.readUInt32BE(20) !== 180) {
    violations.push('Apple touch icon must be a 180 by 180 PNG');
  }
}
const pagesWorkflow = readFileSync(join(root, '.github/workflows/pages.yml'), 'utf8');
if (!pagesWorkflow.includes('cp -R public/. _site/')) {
  violations.push('Pages workflow does not publish the social and icon assets');
}
const shareCardPath = join(root, 'public/social/together-ledger-card.png');
if (existsSync(shareCardPath)) {
  const shareCard = readFileSync(shareCardPath);
  if (shareCard.readUInt32BE(16) !== 1200 || shareCard.readUInt32BE(20) !== 630) {
    violations.push('social card must be a 1200 by 630 PNG');
  }
}

if (violations.length) {
  console.error('Public-safety check failed:\n' + violations.map((item) => `- ${item}`).join('\n'));
  process.exit(1);
}
console.log('✓ public-safety check passed — no household identifiers, private endpoints, or credential-shaped values found.');
