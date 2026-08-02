import { readFileSync, readdirSync, statSync } from 'node:fs';
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

if (violations.length) {
  console.error('Public-safety check failed:\n' + violations.map((item) => `- ${item}`).join('\n'));
  process.exit(1);
}
console.log('✓ public-safety check passed — no household identifiers, private endpoints, or credential-shaped values found.');
