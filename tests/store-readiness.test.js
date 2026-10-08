import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// docs/STORE_READINESS.md is the one file the privacy policy, Play's Data Safety form and Apple's
// privacy labels are written from (#264). Its dependency tables say, for every package either app
// depends on, whether it makes a network request. A dependency added without a row there is a
// network question nobody answered, so it fails here first. A row for a package that has gone
// fails too, so the tables never describe an app that no longer exists.

const root = new URL('../', import.meta.url);
const doc = await readFile(new URL('docs/STORE_READINESS.md', root), 'utf8');

// The rows under one "#### `<manifest>`" heading, up to the next heading.
export function packagesListedFor(markdown, manifest) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.startsWith('#### ') && line.includes(`\`${manifest}\``));
  if (start === -1) return null;
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break;
    const name = line.match(/^\|\s*`([^`]+)`\s*\|/)?.[1];
    if (name) names.push(name);
  }
  return names;
}

async function declared(manifest) {
  const json = JSON.parse(await readFile(new URL(manifest, root), 'utf8'));
  return [...Object.keys(json.dependencies || {}), ...Object.keys(json.devDependencies || {})].sort();
}

for (const manifest of ['package.json', 'apps/mobile/package.json']) {
  test(`every dependency in ${manifest} is accounted for in docs/STORE_READINESS.md`, async () => {
    const listed = packagesListedFor(doc, manifest);
    assert.ok(listed, `docs/STORE_READINESS.md has no "#### \`${manifest}\`" table`);
    const dependencies = await declared(manifest);
    const missing = dependencies.filter((name) => !listed.includes(name));
    assert.deepEqual(missing, [], `Add a row for each to the ${manifest} table in docs/STORE_READINESS.md, saying whether it makes a network request, and update the store answers if it collects anything.`);
    const gone = listed.filter((name) => !dependencies.includes(name));
    assert.deepEqual(gone, [], `docs/STORE_READINESS.md lists packages ${manifest} no longer has. Remove their rows.`);
  });
}

test('the check reads only its own table', () => {
  const markdown = [
    '#### `a/package.json`',
    '| Package | Network |',
    '|---|---|',
    '| `left` | No |',
    '#### `package.json`',
    '| `right` | No |',
    '## Next',
    '| `outside` | No |',
  ].join('\n');
  assert.deepEqual(packagesListedFor(markdown, 'package.json'), ['right']);
  assert.deepEqual(packagesListedFor(markdown, 'a/package.json'), ['left']);
  assert.equal(packagesListedFor(markdown, 'b/package.json'), null);
});
