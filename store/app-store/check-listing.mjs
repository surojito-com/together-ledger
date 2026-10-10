// Checks the App Store listing and the App Review notes against Apple's field limits and the
// wording rules in CLAUDE.md ("Language", "Design system"). It runs in `npm run check`.
//
//   node store/app-store/check-listing.mjs
//
// A sibling of store/google-play/check-listing.mjs, not a copy of it. The listing keeps Play's
// rules where they hold for the App Store too. The review notes have their own, because they have
// to name Apple and the App Store, and they are read by App Review, not by customers.
//
// Exits non-zero on any failure, so it can also run before every paste into App Store Connect.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const read = (name) => readFileSync(join(here, name), 'utf8').replace(/\n$/, '');
const readRepo = (path) => readFileSync(join(root, path), 'utf8');

// Apple's limits, checked on Oct 8, 2026 (store/app-store/README.md cites the pages). Name,
// subtitle, promotional text and description count characters; keywords and the review notes
// count bytes.
const listing = [
  { file: 'name.txt', label: 'Name', max: 30, min: 2, unit: 'characters' },
  { file: 'subtitle.txt', label: 'Subtitle', max: 30, unit: 'characters' },
  { file: 'promotional-text.txt', label: 'Promotional text', max: 170, unit: 'characters' },
  { file: 'keywords.txt', label: 'Keywords', max: 100, unit: 'bytes' },
  { file: 'description.txt', label: 'Description', max: 4000, unit: 'characters' },
];
const notes = { file: 'review-notes.txt', label: 'Review notes', max: 4000, unit: 'bytes' };
// Pasted after the review notes only while the server counts paid places (README, "Review notes").
const extraPlace = { file: 'review-notes-extra-place.txt', label: 'Review notes with the extra place' };

const size = (text, unit) => (unit === 'bytes' ? Buffer.byteLength(text, 'utf8') : [...text].length);
const hasWord = (text, word) => new RegExp(`(^|[^a-z])${word.replace(/[#.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(text);
const hasStem = (text, stem) => new RegExp(`(^|[^a-z])${stem}`, 'i').test(text);

// Everywhere, notes included. CLAUDE.md "Language": capacity is room for another person, never
// seats, licences or slots, and nobody is removed for not paying; people rest. Together Ledger is
// never an emergency, SOS or diagnostic app.
const everywhereStems = ['seat', 'licen', 'slot', 'removed', 'emergenc', 'diagnos'];
const everywhereWords = ['sos', 'panic', 'couples'];

// No photo-privacy claim until #258 confirms the server cleans photos on production.
const photoPrivacy = ['exif', 'metadata', 'camera details', 'location details', 'stored without'];

// The listing only. App Store Review Guideline 2.3: metadata reflects the app, names no other
// platform, and makes no ranking claim.
const listingWords = [
  'best', '#1', 'number one', 'top rated', 'free forever',
  'android', 'google', 'play store', 'whatsapp',
];
// What the iPhone app can't do yet, so the listing doesn't claim it: notifications (#265),
// encryption, seamless sync (#186), attaching a photo (#187), the web's export and guided
// check-in. Nor anything that scores a relationship.
const listingStems = ['notification', 'end-to-end', 'encrypt', 'sync', 'photo', 'export', 'check-in', 'check in'];
// Offline (#300, #352): the owner's one sentence (Oct 10, decision 102), word for word, and
// nothing broader. Since #361 and #366 the phone holds a new moment without a connection and
// sends it once it's back; it doesn't keep journeys to read or browse offline (#360, v2), so any
// other word about the connection is refused, in every listing field.
const offlineSentence = "You can hold a moment without a connection; it's sent when you're back online.";
const connectionWords = ['offline', 'online', 'connection', 'connectivity', 'internet', 'airplane', 'flight mode', 'wi-fi', 'wifi', 'no signal', 'reception'];
const listingPhrases = ['relationship score', 'healthy relationship'];

// The description has to keep these.
const requiredInDescription = [
  ['a journey of two is free', 'TERMS.md; owner decision, Oct 6'],
  ['someone new joins only when everyone already in the journey agrees', 'TERMS.md'],
  ['18 and over', 'TERMS.md and PRIVACY.md: adults only'],
  ['renews automatically until you cancel it', 'App Store Review Guideline 3.1.2'],
  ['terms of use: https://app.together-ledger.com/terms', 'Guideline 3.1.2: a link to the terms of use in the metadata'],
  ['privacy policy: https://app.together-ledger.com/privacy', 'Guideline 3.1.2 and 5.1.1(i)'],
];

// The notes have to keep these: what #357 asks App Review to be told.
const requiredInNotes = [
  ["sign-in information", 'where the reviewer\'s email and password are: App Store Connect, never this repository'],
  ['a journey of two is free', 'nothing has to be bought'],
  ['settings > journey sharing > room for more people', 'where the purchase screen is (apps/mobile/app/journey-settings.tsx)'],
  ['restore purchases is in settings', 'apps/mobile/app/settings.tsx'],
  ['honours sandbox purchases only for a short list of test accounts', 'STORE_SANDBOX_ACCOUNT_IDS (server/store-purchases.js)'],
];

let failed = false;
const fail = (msg) => {
  failed = true;
  console.log(`  ✗ ${msg}`);
};

function common(label, text) {
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) fail(`${label} contains an emoji`);
  for (const stem of everywhereStems) if (hasStem(text, stem)) fail(`${label} uses "${stem}…"`);
  for (const word of everywhereWords) if (hasWord(text, word)) fail(`${label} uses "${word}"`);
  for (const phrase of photoPrivacy) if (text.toLowerCase().includes(phrase)) fail(`${label} makes a photo-privacy claim ("${phrase}"); wait for #258`);
  // A real address or a password never goes in this public repository (docs/APP_REVIEW.md).
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(text)) fail(`${label} contains an email address`);
  if (/password\s*[:=]/i.test(text)) fail(`${label} looks like it carries a password`);
}

for (const { file, label, max, min = 0, unit } of listing) {
  const text = read(file);
  const length = size(text, unit);
  console.log(`${label}: ${length}/${max} ${unit}`);
  if (length > max) fail(`${label} is ${length - max} ${unit} over`);
  if (length < min) fail(`${label} is under ${min} ${unit}`);
  if (/\n/.test(text) && file !== 'description.txt') fail(`${label} has more than one line`);
  common(label, text);
  for (const word of listingWords) if (hasWord(text, word)) fail(`${label} uses "${word}"`);
  for (const stem of listingStems) if (hasStem(text, stem)) fail(`${label} uses "${stem}…"`);
  // The offline sentence is checked on its own below; every other word about the connection is a broader claim.
  const rest = text.split(offlineSentence).join(' ').toLowerCase();
  for (const word of connectionWords) if (rest.includes(word)) fail(`${label} says "${word}": only the offline sentence may speak of the connection (#352, #360)`);
  for (const phrase of listingPhrases) if (text.toLowerCase().includes(phrase)) fail(`${label} uses "${phrase}"`);
}

// Keywords: comma-separated, with no byte spent on a space beside a comma, an empty entry, a
// repeat, or a word the name already gives (Apple indexes the name on its own).
const keywords = read('keywords.txt');
const terms = keywords.split(',');
if (/\s,|,\s|^\s|\s$/.test(keywords)) fail('Keywords have a space beside a comma or at an end');
if (terms.some((term) => !term.trim())) fail('Keywords have an empty entry');
const seen = new Set();
for (const term of terms.map((t) => t.trim().toLowerCase())) {
  if (seen.has(term)) fail(`Keywords repeat "${term}"`);
  seen.add(term);
}
const nameWords = read('name.txt').toLowerCase().split(/[^a-z]+/).filter(Boolean);
for (const word of nameWords) if (terms.some((term) => term.toLowerCase().split(/\s+/).includes(word))) fail(`Keywords repeat "${word}" from the name`);

// The name under the icon stays "Together Ledger" whatever the App Store name is (#357).
const appJson = JSON.parse(readRepo('apps/mobile/app.json'));
if (appJson.expo?.name !== 'Together Ledger') fail(`apps/mobile/app.json names the app "${appJson.expo?.name}", not "Together Ledger"`);

const description = read('description.txt').toLowerCase();
for (const [phrase, why] of requiredInDescription) {
  if (!description.includes(phrase)) fail(`Description no longer says "${phrase}" (${why})`);
}
const offlineCount = read('description.txt').split(offlineSentence).length - 1;
if (offlineCount !== 1) fail(`Description says the offline sentence ${offlineCount} times, not once, word for word (owner decision 102, Oct 10)`);

// The review notes, on their own rules.
const notesText = read(notes.file);
const notesBytes = size(notesText, notes.unit);
console.log(`${notes.label}: ${notesBytes}/${notes.max} ${notes.unit}`);
if (notesBytes > notes.max) fail(`${notes.label} are ${notesBytes - notes.max} bytes over`);
common(notes.label, notesText);
const lowerNotes = notesText.toLowerCase();
for (const [phrase, why] of requiredInNotes) {
  if (!lowerNotes.includes(phrase)) fail(`Review notes no longer say "${phrase}" (${why})`);
}

const extraText = read(extraPlace.file);
const combined = Buffer.byteLength(`${notesText}\n\n${extraText}`, 'utf8');
console.log(`${extraPlace.label}: ${combined}/${notes.max} bytes`);
if (combined > notes.max) fail(`${extraPlace.label} are ${combined - notes.max} bytes over`);
common(extraPlace.label, extraText);

// What the notes name has to be what the code does.
const reviewJourney = readRepo('server/review-journey.js');
const partner = reviewJourney.match(/partner:\s*'([^']+)'/)?.[1];
if (!partner || !notesText.includes(`username ${partner}`)) fail(`Review notes don't name the partner's username as server/review-journey.js makes it (${partner})`);
for (const title of extraText.match(/"([^"]+)"/g) || []) {
  if (!reviewJourney.includes(`title: '${title.slice(1, -1)}'`)) fail(`The extra-place note names ${title}, which server/review-journey.js doesn't make`);
}

// The refusal the notes quote is the server's own sentence, as an iPhone shows it.
const purchases = readRepo('server/store-purchases.js');
const appleName = purchases.match(/const STORE = \{ apple: '([^']+)'/)?.[1];
const refusal = purchases.match(/'store_environment_mismatch', `(This was a test purchase[^`]*)`/)?.[1]?.replace('${STORE[store]}', appleName);
if (!refusal || !notesText.includes(`"${refusal}"`)) fail('Review notes no longer quote the sandbox refusal exactly as server/store-purchases.js words it for Apple');

const settings = readRepo('apps/mobile/app/settings.tsx');
for (const label of ['Journey sharing', 'History and conversations', 'Delete account']) {
  if (!settings.includes(`label="${label}"`) && !settings.includes(`label={\`${label}`)) fail(`Review notes name Settings > ${label}, which apps/mobile/app/settings.tsx no longer shows`);
}
if (!readRepo('apps/mobile/src/billing/store-products.ts').includes("ROOM_TITLE = 'Room for more people'")) fail('Review notes name "Room for more people", which the phone no longer titles its offers');

console.log(failed ? '\nFAILED' : '\nAll checks passed');
process.exit(failed ? 1 : 0);
