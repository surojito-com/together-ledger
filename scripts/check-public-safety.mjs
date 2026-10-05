import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const ignored = new Set(['.git', 'node_modules', 'coverage', 'dist']);
// CLAUDE.md says to put worktrees at .claude/worktrees, and each one is a whole second checkout.
// Walking into them made this check read other branches' copies of its own forbidden-pattern list
// and fail on them, so following one instruction in CLAUDE.md made the other impossible (#256).
// A checkout answers for itself; the worktree answers for itself when the check is run there.
const ignoredPaths = new Set(['.claude/worktrees']);
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

// withFileTypes answers from the directory entry rather than by following the link, so a dangling
// symlink is a file to skip instead of a crash. A phone worktree's CocoaPods headers are full of
// them, and statSync threw on the first one before any violation could be reported.
export function collectFiles(directory, from = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const path = join(directory, entry.name);
    if (ignoredPaths.has(relative(from, path).split(sep).join('/'))) return [];
    return entry.isDirectory() ? collectFiles(path, from) : [path];
  });
}

// Importing this file now reads nothing and exits nothing, so the walk above can be tested.
export function findViolations() {
  const violations = [];
  for (const path of collectFiles(root)) {
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
  // The apex belongs to the separate company-site repository, which serves it through
  // Cloudflare. A Pages deployment from this repository would build a bundle no visitor
  // can reach and still report success, so nothing here may deploy to Pages again.
  const workflowsDirectory = join(root, '.github/workflows');
  for (const workflowName of readdirSync(workflowsDirectory)) {
    const workflow = readFileSync(join(workflowsDirectory, workflowName), 'utf8');
    for (const pagesDeployAction of ['actions/configure-pages@', 'actions/deploy-pages@', 'actions/upload-pages-artifact@']) {
      if (workflow.includes(pagesDeployAction)) {
        violations.push(`${workflowName} deploys to GitHub Pages, which no longer serves any Together Ledger address`);
      }
    }
  }
  const workerWorkflow = readFileSync(join(root, '.github/workflows/app-worker.yml'), 'utf8');
  for (const requiredWorkerDeliveryStep of [
    'workflow_run:',
    'npm run build:public',
    'github.event.workflow_run.conclusion == \'success\'',
    'github.event.workflow_run.event == \'push\'',
    'TOGETHER_LEDGER_RELEASE_REVISION',
    'CLOUDFLARE_API_TOKEN',
    'wrangler deploy --dry-run',
    'probes/app-release-probe/wrangler.jsonc',
    'deploy-release-probe.mjs',
    'verify-release-probe.mjs',
  ]) {
    if (!workerWorkflow.includes(requiredWorkerDeliveryStep)) {
      violations.push(`App Worker workflow is missing ${requiredWorkerDeliveryStep}`);
    }
  }
  const shareCardPath = join(root, 'public/social/together-ledger-card.png');
  if (existsSync(shareCardPath)) {
    const shareCard = readFileSync(shareCardPath);
    if (shareCard.readUInt32BE(16) !== 1200 || shareCard.readUInt32BE(20) !== 630) {
      violations.push('social card must be a 1200 by 630 PNG');
    }
  }

  return violations;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const violations = findViolations();
  if (violations.length) {
    console.error('Public-safety check failed:\n' + violations.map((item) => `- ${item}`).join('\n'));
    process.exit(1);
  }
  console.log('✓ public-safety check passed — no household identifiers, private endpoints, or credential-shaped values found.');
}
