// Checks the Google Play listing text against Play's length limits and the
// wording rules in CLAUDE.md ("Language", "Design system").
//
//   node store/google-play/check-listing.mjs
//
// Exits non-zero on any failure, so it can run before every paste into
// Play Console. It runs in `npm run check` too.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), 'utf8').replace(/\n$/, '');

const fields = [
  { file: 'title.txt', label: 'App name', max: 30 },
  { file: 'short-description.txt', label: 'Short description', max: 80 },
  { file: 'full-description.txt', label: 'Full description', max: 4000 },
];

// Play's metadata policy: no ranking or superlative claims, and no other
// brands' names (the Book, Google Play guide, "Common rejections").
const playPolicy = [
  'best', '#1', 'number one', 'top rated', 'free forever',
  'whatsapp', 'google', 'apple', 'iphone', 'android',
];

// CLAUDE.md "Language": capacity is another person or another place, never
// seats, licenses or slots, and nobody is removed for non-payment. Matched as
// stems, so plurals are caught.
const stems = ['seat', 'licen', 'slot', 'removed', 'emergenc', 'diagnos'];

// Claims Together Ledger can't back on any surface yet
// (store/google-play/README.md): notifications (#265), offline (#300),
// encryption, seamless sync (#186), and anything that scores or diagnoses
// a relationship.
const offVoice = [
  'notification', 'notifications', 'offline', 'end-to-end', 'encrypted',
  'sync', 'couples', 'relationship score', 'healthy relationship',
];

// Lines the owner asked for, and the ones that bound the promise.
const required = [
  ['a journey of two is free', 'owner decision, Oct 6: two people free, more can be added'],
  ['18 and over', 'TERMS.md and PRIVACY.md: adults only'],
  ['someone new joins only when everyone already in the journey agrees', 'TERMS.md'],
];

let failed = false;
const fail = (msg) => {
  failed = true;
  console.log(`  ✗ ${msg}`);
};

for (const { file, label, max } of fields) {
  const text = read(file);
  const length = [...text].length;
  console.log(`${label}: ${length}/${max}`);
  if (length > max) fail(`${label} is ${length - max} characters over`);
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) fail(`${label} contains an emoji`);

  const lower = text.toLowerCase();
  for (const word of stems) {
    if (new RegExp(`\\b${word}`, 'i').test(lower)) fail(`${label} uses "${word}…"`);
  }
  for (const word of [...playPolicy, ...offVoice]) {
    const re = new RegExp(`(^|[^a-z])${word.replace(/[#]/g, '\\$&')}([^a-z]|$)`, 'i');
    if (re.test(lower)) fail(`${label} uses "${word}"`);
  }
}

const full = read('full-description.txt').toLowerCase();
for (const [phrase, why] of required) {
  if (!full.includes(phrase)) fail(`Full description no longer says "${phrase}" (${why})`);
}

console.log(failed ? '\nFAILED' : '\nAll checks passed');
process.exit(failed ? 1 : 0);
