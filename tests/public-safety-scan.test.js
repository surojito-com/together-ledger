import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { collectFiles } from '../scripts/check-public-safety.mjs';

// CLAUDE.md says to put worktrees at .claude/worktrees and also requires `npm run check` to pass
// before a pull request. Following the first made the second impossible (#256): the walk read every
// other branch's checkout, including their copies of this very script's forbidden-pattern list.

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'public-safety-'));
  writeFileSync(join(root, 'real.md'), 'ordinary repository file');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.js'), 'also real');
  // A second checkout, exactly where CLAUDE.md says to put it.
  mkdirSync(join(root, '.claude', 'worktrees', 'other-branch', 'scripts'), { recursive: true });
  // Built rather than written out: this file is scanned too, and a literal would trip the very
  // check it is testing — which is the check doing its job.
  const forbidden = ['colorado', 'trip', 'access'].join('_');
  writeFileSync(join(root, '.claude', 'worktrees', 'other-branch', 'scripts', 'check-public-safety.mjs'), forbidden);
  // And a committed file under .claude that is not a worktree, which must still be read.
  writeFileSync(join(root, '.claude', 'settings.json'), '{}');
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'ignored already');
  return root;
}

const names = (root) => collectFiles(root).map((path) => path.slice(root.length + 1).split(sep).join('/')).sort();

test('a second checkout under .claude/worktrees is not read as if it were this one', () => {
  const root = fixture();
  try {
    const found = names(root);
    assert.deepEqual(found, ['.claude/settings.json', 'real.md', 'src/app.js']);
    // The specific file that broke it: another branch's copy of this script's own pattern list.
    assert.ok(!found.some((path) => path.includes('worktrees')), 'no worktree file is read');
    // .claude itself is not blanket-ignored; only the worktrees inside it are.
    assert.ok(found.includes('.claude/settings.json'), 'a committed .claude file is still read');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Not in #256, and the thing that actually happens first: a phone worktree's CocoaPods headers are
// full of dangling symlinks, and statSync threw on one before a single violation was reported.
test('a dangling symlink is skipped rather than thrown on', () => {
  const root = mkdtempSync(join(tmpdir(), 'public-safety-link-'));
  try {
    writeFileSync(join(root, 'real.md'), 'ordinary');
    symlinkSync(join(root, 'does-not-exist.h'), join(root, 'broken.h'));
    assert.deepEqual(names(root), ['broken.h', 'real.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
