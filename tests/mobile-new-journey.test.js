import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const mobile = new URL('../apps/mobile/', import.meta.url);
const read = (path) => readFile(new URL(path, mobile), 'utf8');
const web = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const server = await readFile(new URL('../server/platform.js', import.meta.url), 'utf8');

// The phone's own TypeScript, compiled on the spot, its imports of the web's modules pointed
// at the real files.
async function importMobile(path) {
  const url = new URL(path, mobile);
  const { outputText } = ts.transpileModule(await readFile(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const linked = outputText.replace(/from '(\.[^']+\.js)'/g, (_, specifier) => `from '${new URL(specifier, url).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(linked).toString('base64')}`);
}

const draft = await importMobile('src/journey/journey-draft.ts');
const screen = await read('app/new-journey.tsx');

// The options of one of the web's #journey-form selects, as [value, words] pairs.
function webOptions(name) {
  const select = html.match(new RegExp(`<select name="${name}">([\\s\\S]*?)</select>`))[1];
  return [...select.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map(([, value, words]) => [value, words]);
}

test('a new journey starts as the web\'s does: begun today, with no end planned', () => {
  const fresh = draft.newJourneyDraft(new Date(2026, 9, 8, 23, 30));
  assert.deepEqual(fresh, { name: '', location: '', startDateStatus: 'exact', startDate: '2026-10-08', endDateStatus: 'forever', endDate: '2026-10-08' });
  assert.ok(web.includes("form.elements.startDateStatus.value = 'exact';"));
  assert.ok(web.includes("form.elements.endDateStatus.value = 'forever';"));
  assert.ok(web.includes("const today = localDay();"), 'both count today as the person\'s own local day (#336)');
});

test('the date choices are the web\'s, in its order and its words', () => {
  assert.deepEqual(draft.START_DATE_CHOICES, [['exact', 'I know the date'], ['unknown', 'I don’t remember exactly']], 'the owner\'s words, still stored as exact (#358)');
  assert.deepEqual(draft.START_DATE_CHOICES, webOptions('startDateStatus'));
  assert.deepEqual(draft.END_DATE_CHOICES, webOptions('endDateStatus'));
  for (const [value] of [...draft.START_DATE_CHOICES, ...draft.END_DATE_CHOICES]) assert.ok(server.includes(`'${value}'`), `the server accepts ${value}`);
});

test('the exact dates show only when chosen, as the web\'s syncJourneyDateFields() decides', () => {
  const fresh = draft.newJourneyDraft();
  assert.deepEqual(draft.dateFieldsShown(fresh), { startDate: true, endDate: false });
  assert.deepEqual(draft.dateFieldsShown({ ...fresh, startDateStatus: 'unknown', endDateStatus: 'date' }), { startDate: false, endDate: true });
  assert.ok(web.includes("const hasExactStart = form.elements.startDateStatus.value === 'exact';"));
  assert.ok(web.includes("const hasExactEnd = form.elements.endDateStatus.value === 'date';"));
});

test('what the phone sends is the web\'s payload for a new journey, field for field', () => {
  const sent = draft.journeyPayload({ ...draft.newJourneyDraft(new Date(2026, 9, 8, 12)), name: '  Our first year  ', location: ' Leeds ' });
  const webPayload = web.match(/const payload = \{\n([\s\S]*?)\.\.\.\(existing \? \{ version/)[1];
  const webKeys = [...webPayload.matchAll(/^\s+(\w+):/gm)].map(([, key]) => key);
  assert.deepEqual(Object.keys(sent), webKeys);
  assert.deepEqual(sent, { name: 'Our first year', location: 'Leeds', startDateStatus: 'exact', endDateStatus: 'forever', startDate: '2026-10-08', endDate: null, budgetCents: 0 });
  assert.ok(html.includes('<input name="budget" type="hidden" value="0" />'), 'the web begins every journey with no budget too');
  const unknown = draft.journeyPayload({ ...draft.newJourneyDraft(), name: 'x', startDateStatus: 'unknown', endDateStatus: 'date', endDate: '2027-01-01' });
  assert.equal(unknown.startDate, null, 'a hidden date is never sent');
  assert.equal(unknown.endDate, '2027-01-01');
});

test('a draft the server would refuse is stopped first, in the server\'s own words', () => {
  const fresh = { ...draft.newJourneyDraft(new Date(2026, 9, 8, 12)), name: 'Our first year' };
  assert.equal(draft.journeyProblem(fresh), null);
  const problems = [
    draft.journeyProblem({ ...fresh, name: '   ' }),
    draft.journeyProblem({ ...fresh, startDate: '2026-02-30' }),
    draft.journeyProblem({ ...fresh, endDateStatus: 'date', endDate: '' }),
    draft.journeyProblem({ ...fresh, endDateStatus: 'date', endDate: '2026-10-07' }),
  ];
  assert.equal(problems[0], 'Journey name is required and must be 80 characters or fewer.');
  assert.ok(server.includes("cleanName(input.name, 'Journey name', 80)") && server.includes('is required and must be ${max} characters or fewer.'));
  for (const problem of problems.slice(1)) assert.ok(server.includes(problem), `the server says "${problem}" too`);
  assert.equal(draft.journeyProblem({ ...fresh, startDateStatus: 'unknown', startDate: 'not a date' }), null, 'a hidden date is not checked');
  assert.equal(draft.NAME_LIMIT, 80);
  assert.equal(draft.LOCATION_LIMIT, 80);
  // Counted in characters a person sees on both, never by maxlength, which counts UTF-16 units.
  assert.ok(html.includes('<input name="name" required data-character-limit="80"') && html.includes('<input name="location" data-character-limit="80"'));
  assert.ok(screen.includes('limit={NAME_LIMIT}') && screen.includes('limit={LOCATION_LIMIT}') && !screen.includes('maxLength={NAME_LIMIT}'));
});

test('the screen uses the web\'s words, and the journey it begins is the one that opens', () => {
  assert.ok(web.includes(`'${draft.CREATED_MESSAGE}'`), 'the toast is the web\'s');
  assert.ok(html.includes('placeholder="e.g. Mountain weekend"') && screen.includes('placeholder="e.g. Mountain weekend"'));
  assert.ok(web.includes("'Begin with a name. The optional details can wait until they feel useful.'") && screen.includes('lead="Begin with a name. The optional details can wait until they feel useful."'));
  assert.ok(web.includes("'Begin a shared journey'") && screen.includes('title="Begin a shared journey"'));
  assert.match(screen, /await journey\.open\(created\.id\);\s+showToast\(CREATED_MESSAGE\);/, 'the new journey opens before the toast says it exists');
});

test('both the empty start and an open ledger lead to a new journey, and nothing sends people to the web for it', async () => {
  const ledger = await read('app/ledger.tsx');
  assert.equal(ledger.match(/router\.push\('\/new-journey'\)/g)?.length, 2);
  assert.doesNotMatch(ledger, /created in Together Ledger on the web/);
  assert.match(await read('app/_layout.tsx'), /<Stack\.Screen name="new-journey" /);
});

test('the 101-journey limit reaches the phone in the server\'s own words (the Book, 4.7)', async () => {
  const { accountMessage, NO_ROOM_ADDED_HERE } = await importMobile('src/auth/account-messages.ts');
  const worded = server.match(/'journey_limit_reached', `([^`]+)`/)[1].replace('${MAX_JOURNEYS_PER_PERSON}', '101');
  assert.equal(worded, "One person can be in at most 101 journeys, and you've reached that, so a new one can't be started. Every journey you're in stays as it is.");
  assert.equal(Object.hasOwn(NO_ROOM_ADDED_HERE, 'journey_limit_reached'), false, 'the phone does not reword it');
  assert.equal(accountMessage({ code: 'journey_limit_reached', message: worded }), worded);
  assert.match(screen, /showStatus\(accountMessage\(error\), \{ source: 'new-journey' \}\)/, 'a refused journey is shown, not swallowed');
});

test('8 pm on Oct 7 in New York begins a journey on Oct 7, not the UTC day (#336)', () => {
  const before = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const fresh = draft.newJourneyDraft(new Date('2026-10-08T00:00:00Z'));
    assert.equal(fresh.startDate, '2026-10-07');
    assert.equal(fresh.endDate, '2026-10-07');
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

test('"I know the date" takes a date still to come, and the end still cannot come before it (#358)', () => {
  const planned = { ...draft.newJourneyDraft(new Date(2026, 9, 8, 12)), name: 'The trip we are planning', startDate: '2027-06-01' };
  assert.deepEqual(draft.dateFieldsShown(planned), { startDate: true, endDate: false }, 'choosing it shows the date box');
  assert.equal(draft.journeyProblem(planned), null, 'a future start is accepted');
  assert.equal(draft.journeyPayload(planned).startDateStatus, 'exact');
  assert.equal(draft.journeyPayload(planned).startDate, '2027-06-01');
  assert.equal(draft.journeyProblem({ ...planned, endDateStatus: 'date', endDate: '2027-06-14' }), null);
  assert.equal(draft.journeyProblem({ ...planned, endDateStatus: 'date', endDate: '2027-05-31' }), 'The end date must be on or after the start date.');
  assert.doesNotMatch(server.match(/function cleanJourneyDetails[\s\S]*?\n\}/)[0], /today|now\(|new Date/i, 'the server has no rule against a future start either');
});
