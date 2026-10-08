// The privacy policy and the terms of use the phone app shows on its own Privacy and Terms
// screens, generated from PRIVACY.md and TERMS.md with the same parse the web's /privacy and
// /terms pages use (policyBlocks in render-privacy-page.mjs). The phone never carries a hand-kept
// copy: apps/mobile/src/policies/privacy.json and terms.json are written by this script, and
// tests/mobile-policies.test.js fails when either no longer matches its source. The terms are on
// the phone because Apple 3.1.2 asks a subscription offer to link to them (#340).
//
// The phone shows the policy itself rather than opening the web page, because the phone app
// opens no web page at all (tests/mobile-no-stripe.test.js, #268): the web page links on to the
// web app, and from there to paying on the web. A link inside the policy is shown as its words.
//
//   node scripts/mobile-policies.mjs          check that privacy.json and terms.json are current
//   node scripts/mobile-policies.mjs --write  regenerate them after changing PRIVACY.md or TERMS.md
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { policyBlocks } from './render-privacy-page.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MOBILE_PRIVACY_PATH = join(root, 'apps', 'mobile', 'src', 'policies', 'privacy.json');
export const MOBILE_TERMS_PATH = join(root, 'apps', 'mobile', 'src', 'policies', 'terms.json');

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

export async function generateTerms() {
  return buildMobilePolicy(await readFile(join(root, 'TERMS.md'), 'utf8'), 'TERMS.md');
}

const POLICIES = [
  { path: MOBILE_PRIVACY_PATH, source: 'PRIVACY.md', build: generate },
  { path: MOBILE_TERMS_PATH, source: 'TERMS.md', build: generateTerms },
];

export const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const { path, source, build } of POLICIES) {
    const expected = serialize(await build());
    if (process.argv.includes('--write')) {
      await writeFile(path, expected);
      console.log(`Wrote ${path}`);
    } else {
      const current = await readFile(path, 'utf8').catch(() => '');
      if (current !== expected) {
        console.error(`${path} is out of date with ${source}. Run: node scripts/mobile-policies.mjs --write`);
        process.exitCode = 1;
      } else {
        console.log(`✓ the phone's copy matches ${source}`);
      }
    }
  }
}
