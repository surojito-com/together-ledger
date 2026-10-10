import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import {
  CODE_POINTS_PER_CHARACTER,
  characterCount,
  characters,
  cleanDisplayText,
  clipToLimit,
  fitsLimit,
  fitTyping,
  graphemesWithoutSegmenter,
} from '../src/display-text.js';
import { demoState, normalizeMoment } from '../src/model.js';
import { exportState } from '../src/store.js';

// The owner's samples (Oct 10, 2026). Escapes keep what each one is made of in plain sight.
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
const HEART = '❤️';
const INDIA = '\u{1F1EE}\u{1F1F3}';
const KISS = '\u{1F469}\u{1F3FD}‍❤️‍\u{1F48B}‍\u{1F468}\u{1F3FF}';
const SAMPLES = [
  [`Saanvi & Ravi ${HEART}`, 15],
  ['家族の旅', 4],
  ['רות ודני', 8],
  ['सान्वी', 2],
  [`Zoë's ${INDIA} summer`, 14],
  [`${FAMILY} weekend`, 9],
  ["O'Brien – <b>bold</b>", 21],
  ['1️⃣ \u{1F44B}\u{1F3FD} \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}', 5],
];

test('every sample is counted in the characters a person sees, on any engine', () => {
  for (const [sample, count] of SAMPLES) {
    assert.equal(characterCount(sample), count, sample);
    assert.deepEqual(graphemesWithoutSegmenter(sample), characters(sample), `a phone without Intl.Segmenter splits ${sample} the same way`);
  }
  assert.equal(`${FAMILY} weekend`.length, 19, 'where a string\'s length makes the family eleven');
  assert.equal(characterCount(KISS), 1);
});

test('the rule-based split agrees with Intl.Segmenter on scripts, marks, emoji, flags and keycaps', () => {
  const pool = ['a', 'é', 'e', '́', '̈', '家', 'ר', 'ָ', 'ا', 'َ', 'स', 'ा', 'न', '्', 'व', 'ी', '़',
    'ক', '্', 'ত', 'ગ', '્', 'ಕ', '್', 'த', '்', 'ก', 'ั', '้', 'ᄀ', 'ᅡ', 'ᆨ', '한',
    '‍', '‌', '️', '⃣', '1', '#', ' ', '\u{1F468}', '\u{1F469}', '\u{1F467}', '❤', '\u{1F48B}', '\u{1F3FD}', '\u{1F3FF}', '\u{1F1EE}',
    '\u{1F1F3}', '\u{1F1FA}', '\u{1F3F4}', '\u{E0067}', '\u{E007F}', '\u{1F44B}', '☺', '\u{1F600}', '\u{1FAF6}', '؀', '­', '\r', '\n', '‮', '⁦'];
  let seed = 20261010;
  const random = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  for (let round = 0; round < 20000; round += 1) {
    let text = '';
    for (let length = 1 + Math.floor(random() * 12); length > 0; length -= 1) text += pool[Math.floor(random() * pool.length)];
    assert.deepEqual(graphemesWithoutSegmenter(text), characters(text), JSON.stringify(text));
  }
});

test('a name keeps every language, symbol and emoji, composed, without controls or direction overrides', () => {
  for (const [sample] of SAMPLES) assert.equal(cleanDisplayText(sample), sample);
  assert.equal(cleanDisplayText('Zoë'), 'Zoë', 'composed to NFC');
  assert.equal(cleanDisplayText('Ravi‮odnap'), 'Raviodnap');
  assert.equal(cleanDisplayText('‪a‫b‬c‭d⁦e⁧f⁨g⁩'), 'abcdefg');
  assert.equal(cleanDisplayText('Ma\u0007\u001B\u007F\u009Bya'), 'Maya', 'C0 and C1 controls are taken out');
  assert.equal(cleanDisplayText('Saanvi\nand\tRavi\r\n'), 'Saanvi and Ravi', 'a line break or tab is a space, not a join');
  assert.equal(cleanDisplayText(FAMILY + HEART), FAMILY + HEART, 'the zero-width joiner and variation selector stay');
  assert.equal(cleanDisplayText('‮ ⁦'), '', 'nothing is left of a name made only of them');
});

test('limits count what a person sees, with a ceiling on size for stacked marks', () => {
  assert.equal(fitsLimit(FAMILY.repeat(80), 80), true);
  assert.equal(fitsLimit(FAMILY.repeat(81), 80), false);
  assert.equal(fitsLimit(KISS.repeat(80), 80), true, 'ten code points is the largest emoji in use, and fits');
  assert.equal(CODE_POINTS_PER_CHARACTER, 10);
  const stacked = `a${'́'.repeat(30)}`;
  assert.equal(characterCount(stacked), 1);
  assert.equal(fitsLimit(stacked, 1), false, 'one character, but thirty-one code points');
  assert.equal(fitsLimit('x'.repeat(120), 120), true);
  assert.equal(fitsLimit('x'.repeat(121), 120), false);
});

test('clipping never cuts a character in half', () => {
  assert.equal(clipToLimit(FAMILY.repeat(81), 80), FAMILY.repeat(80));
  for (const [sample] of SAMPLES) {
    for (let max = 0; max <= characterCount(sample); max += 1) {
      assert.deepEqual(characters(clipToLimit(sample, max)), characters(sample).slice(0, max), `${sample} at ${max}`);
    }
  }
});

test('typing past a limit keeps as much of what was typed as fits, and what was there stays', () => {
  const full = 'x'.repeat(79);
  assert.deepEqual(fitTyping(full, `${full}${FAMILY}`, 80), { value: `${full}${FAMILY}`, caret: null });
  assert.deepEqual(fitTyping(full, `${full}${FAMILY}${FAMILY}`, 80), { value: `${full}${FAMILY}`, caret: 79 + FAMILY.length });
  // Pasted in the middle: the end of the name is not what goes.
  const name = `${'a'.repeat(39)}${'b'.repeat(39)}`;
  const pasted = fitTyping(name, `${'a'.repeat(39)}${INDIA}${INDIA}${INDIA}${'b'.repeat(39)}`, 80);
  assert.equal(pasted.value, `${'a'.repeat(39)}${INDIA}${INDIA}${'b'.repeat(39)}`);
  assert.equal(pasted.caret, 39 + INDIA.length * 2);
  // A whole box set at once, as a paste into an empty box or a browser's autofill.
  assert.equal(fitTyping('', FAMILY.repeat(81), 80).value, FAMILY.repeat(80));
});

// The phone's own TypeScript, compiled on the spot, its imports of the web's modules pointed at
// the real files, as tests/mobile-new-journey.test.js does.
const mobile = new URL('../apps/mobile/', import.meta.url);
async function importMobile(path) {
  const url = new URL(path, mobile);
  const { outputText } = ts.transpileModule(await readFile(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const linked = outputText.replace(/from '(\.[^']+\.js)'/g, (_, specifier) => `from '${new URL(specifier, url).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(linked).toString('base64')}`);
}

test('the phone counts a journey\'s name and a moment\'s as the server does', async () => {
  const journey = await importMobile('src/journey/journey-draft.ts');
  const moment = await importMobile('src/journey/moment-draft.ts');
  const fresh = journey.newJourneyDraft(new Date(2026, 9, 10));
  assert.equal(journey.journeyProblem({ ...fresh, name: FAMILY.repeat(80) }), null);
  assert.equal(journey.journeyProblem({ ...fresh, name: FAMILY.repeat(81) }), 'Journey name is required and must be 80 characters or fewer.');
  for (const [sample] of SAMPLES) assert.equal(journey.journeyProblem({ ...fresh, name: sample }), null, sample);
  const draft = { ...moment.draftFrom(null), title: 'x' };
  assert.equal(moment.draftProblem({ ...draft, title: '\u{1F600}'.repeat(120) }), null);
  assert.equal(moment.draftProblem({ ...draft, title: '\u{1F600}'.repeat(121) }), 'Moment title is required and must be 120 characters or fewer.');
  assert.equal(moment.draftProblem({ ...draft, kind: 'other', kindLabel: HEART.repeat(60) }), null);
  assert.equal(moment.draftProblem({ ...draft, kind: 'other', kindLabel: HEART.repeat(61) }), 'A name for this kind of moment is required and must be 60 characters or fewer.');
});

test('every name box on the phone and the web counts characters, never UTF-16 units', async () => {
  const read = (path) => readFile(new URL(path, mobile), 'utf8');
  const ui = await read('src/components/ui.tsx');
  assert.ok(ui.includes("import { fitTyping } from '../../../../src/display-text.js';"));
  assert.ok(ui.includes('fitTyping(value ?? \'\', next, limit).value'));
  const account = await read('app/account.tsx');
  assert.match(account, /label="Name journeyers see"[^\n]*limit=\{80\}/);
  const momentScreen = await read('app/moment.tsx');
  assert.match(momentScreen, /label="Name this kind of moment"[^\n]*limit=\{60\}/);
  assert.match(momentScreen, /label="A short name"[\s\S]*?limit=\{120\}/);
  assert.match(momentScreen, /label="Enter a place"[^\n]*limit=\{120\}/);
  for (const source of [account, momentScreen, await read('app/new-journey.tsx')]) {
    assert.doesNotMatch(source, /maxLength=\{(?:60|80|120|NAME_LIMIT|LOCATION_LIMIT)\}/);
  }
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const [field, limit] of [['name="kindLabel"', 60], ['name="title" required', 120], ['id="manual-location"', 120], ['name="name" required', 80], ['name="location"', 80], ['name="displayName"', 80]]) {
    const input = html.match(new RegExp(`<input ${field}[^>]*>`))[0];
    assert.ok(input.includes(`data-character-limit="${limit}"`) && !input.includes('maxlength'), input);
  }
  const build = await readFile(new URL('../scripts/build-public-site.mjs', import.meta.url), 'utf8');
  assert.ok(build.includes("'src/display-text.js',"), 'the web is published with the file it counts with');
});

test('a browser-only ledger holds and exports every sample whole', () => {
  const state = demoState();
  const tripId = state.trips[0].id;
  for (const [sample] of SAMPLES) {
    state.moments.push(normalizeMoment({ kind: 'other', kindLabel: clipToLimit(sample, 60), title: sample, occurredOn: '2026-10-10', visibility: 'shared-now', locations: [{ label: sample }] }, tripId));
  }
  state.moments.push(normalizeMoment({ kind: 'other', kindLabel: HEART.repeat(60), title: FAMILY.repeat(120), occurredOn: '2026-10-10', visibility: 'private', locations: [{ label: INDIA.repeat(120) }] }, tripId));
  assert.throws(() => normalizeMoment({ kind: 'memory', title: FAMILY.repeat(121), occurredOn: '2026-10-10', visibility: 'private' }, tripId), /displayed limits/);
  const exported = JSON.parse(exportState(state)).data.moments;
  for (const [sample] of SAMPLES) {
    const held = exported.find((moment) => moment.title === sample);
    assert.ok(held, sample);
    assert.equal(held.locations[0].label, sample);
  }
});
