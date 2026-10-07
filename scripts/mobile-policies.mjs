// The privacy policy the phone app shows on its own Privacy screen, generated from PRIVACY.md
// with the same parse the web's /privacy page uses (policyBlocks in render-privacy-page.mjs).
// The phone never carries a hand-kept copy: apps/mobile/src/policies/privacy.json is written by
// this script, and tests/mobile-policies.test.js fails when it no longer matches PRIVACY.md.
//
// The phone shows the policy itself rather than opening the web page, because the phone app
// opens no web page at all (tests/mobile-no-stripe.test.js, #268): the web page links on to the
// web app, and from there to paying on the web. A link inside the policy is shown as its words.
//
//   node scripts/mobile-policies.mjs          check that privacy.json is current
//   node scripts/mobile-policies.mjs --write  regenerate it after changing PRIVACY.md
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { policyBlocks } from './render-privacy-page.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MOBILE_PRIVACY_PATH = join(root, 'apps', 'mobile', 'src', 'policies', 'privacy.json');

// A run of text and how it is marked: the subset policyBlocks accepts (**bold**, `code` and
// [links](…)) as plain runs. A link keeps its words and drops its address.
export function spans(text) {
  const runs = [];
  const mark = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\([^)\s]+\)/g;
  let last = 0;
  for (const match of text.matchAll(mark)) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index) });
    if (match[1] !== undefined) runs.push({ text: match[1], code: true });
    else if (match[2] !== undefined) runs.push({ text: match[2].replace(/`([^`]+)`/g, '$1'), bold: true });
    else runs.push({ text: match[3] });
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}

export function buildMobilePolicy(markdown, source) {
  const { title, blocks } = policyBlocks(markdown, source);
  return {
    source: `Generated from ${source} by scripts/mobile-policies.mjs. Do not edit by hand.`,
    title,
    blocks: blocks.map((block) => {
      if (block.kind === 'heading') return { kind: 'heading', level: block.level, spans: spans(block.text) };
      if (block.kind === 'list') return { kind: 'list', items: block.items.map(spans) };
      return { kind: 'paragraph', spans: spans(block.text) };
    }),
  };
}

export async function generate() {
  return buildMobilePolicy(await readFile(join(root, 'PRIVACY.md'), 'utf8'), 'PRIVACY.md');
}

export const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const expected = serialize(await generate());
  if (process.argv.includes('--write')) {
    await writeFile(MOBILE_PRIVACY_PATH, expected);
    console.log(`Wrote ${MOBILE_PRIVACY_PATH}`);
  } else {
    const current = await readFile(MOBILE_PRIVACY_PATH, 'utf8').catch(() => '');
    if (current !== expected) {
      console.error('apps/mobile/src/policies/privacy.json is out of date with PRIVACY.md. Run: node scripts/mobile-policies.mjs --write');
      process.exit(1);
    }
    console.log('✓ the phone\'s privacy policy matches PRIVACY.md');
  }
}
