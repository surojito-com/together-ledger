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

const draft = await importMobile('src/journey/moment-draft.ts');
const existing = { id: 'm1', journeyId: 'j', kind: 'memory', kindLabel: '', occurredOn: '2026-06-02', title: 'The road near Marlow', detail: 'We missed the turn.', visibility: 'share-later', theme: 'rose-pine', moneyCents: 1250, moneyCurrency: 'USD', locations: [{ label: 'Marlow', latitude: null, longitude: null, accuracyMeters: null }], version: 3, updatedAt: '' };

test('a new moment starts as the web\'s does, and an edit starts from the moment as it is', () => {
  const fresh = draft.draftFrom(null, { now: new Date('2026-09-30T08:00:00Z') });
  assert.equal(fresh.visibility, 'shared-now');
  assert.equal(fresh.occurredOn, '2026-09-30');
  assert.ok(web.includes("form.elements.visibility.value = 'shared-now';"), 'the web starts a new moment shared now too');
  assert.equal(draft.draftFrom(null, { kind: 'other' }).kind, 'other');
  const edit = draft.draftFrom(existing);
  assert.equal(edit.money, '12.50');
  assert.equal(edit.theme, 'dark', 'a retired theme lands on its survivor');
  assert.notEqual(edit.locations, existing.locations, 'places are copied, so editing never changes the ledger behind the form');
});

test('what the phone sends is the web\'s payload, field for field', () => {
  const sent = draft.payloadFrom({ ...draft.draftFrom(existing), money: '12.5' }, existing);
  const webKeys = web.match(/const payload = \{ kind: input\.kind, ([^}]+)\.\.\.\(before/)[1].split(',').map((part) => part.trim().split(':')[0]).filter(Boolean);
  assert.deepEqual(Object.keys(sent), ['kind', ...webKeys, 'version']);
  assert.equal(sent.moneyCents, 1250);
  assert.equal(sent.version, 3);
  assert.equal(draft.payloadFrom({ ...draft.draftFrom(null), title: 'x', money: ' ' }, null).moneyCents, null);
  assert.equal(Object.hasOwn(draft.payloadFrom(draft.draftFrom(null), null), 'version'), false, 'a new moment has no version to conflict with');
  assert.equal(draft.payloadFrom({ ...draft.draftFrom(null), kind: 'memory', kindLabel: 'left over' }, null).kindLabel, '', 'only a custom kind carries its own name');
});

test('a problem is caught before sending, in the server\'s own words', () => {
  const ok = { ...draft.draftFrom(null), title: 'A quiet apology after dinner' };
  assert.equal(draft.draftProblem(ok), null);
  const cases = [
    [{ ...ok, title: '  ' }, 'Moment title is required and must be 120 characters or fewer.'],
    [{ ...ok, kind: 'other', kindLabel: '' }, 'A name for this kind of moment is required and must be 60 characters or fewer.'],
    [{ ...ok, occurredOn: '2026-02-30' }, 'Choose a valid moment date.'],
    [{ ...ok, occurredOn: '30/09/2026' }, 'Choose a valid moment date.'],
    [{ ...ok, money: '-1' }, 'Enter a valid optional money context.'],
    [{ ...ok, money: 'twelve' }, 'Enter a valid optional money context.'],
  ];
  for (const [input, message] of cases) assert.equal(draft.draftProblem(input), message);
  assert.match(server, /\$\{label\} is required and must be \$\{max\} characters or fewer\./);
  assert.match(server, /cleanText\(input\.title \?\? existing\?\.title, 'Moment title', 120\)/);
  assert.match(server, /'A name for this kind of moment', 60\)/);
  for (const message of ['Choose a valid moment date.', 'Enter a valid optional money context.', 'A moment can hold up to 12 places.']) assert.ok(server.includes(message), message);
});

test('places are added in the person\'s words, removed one at a time, and never a thirteenth', () => {
  assert.deepEqual(draft.addPlace([], '  Marlow  ').locations, [{ label: 'Marlow' }]);
  assert.deepEqual(draft.addPlace([], '   '), { locations: [], problem: null });
  const twelve = Array.from({ length: 12 }, (_, index) => ({ label: `Place ${index}` }));
  assert.equal(draft.addPlace(twelve, 'One more').problem, 'A moment can hold up to 12 places.');
  assert.ok(web.includes("showToast('A moment can hold up to 12 places.')"));
  assert.deepEqual(draft.removePlace([{ label: 'a' }, { label: 'b' }, { label: 'c' }], 1), [{ label: 'a' }, { label: 'c' }]);
});

test('places carry no price on the phone, and a moment with no room says so without one (#268)', async () => {
  const form = await read('app/moment.tsx');
  assert.equal(Object.hasOwn(draft, 'placeNote'), false, 'the web\'s per-place price note stays on the web');
  assert.match(form, /<Section title="Places \(Optional\)" help="Add only what helps tell the story\.">/);
  assert.ok(web.includes("index === 0 ? 'Included' : '$1/month'"), 'the web form is not touched');
  const { accountMessage, NO_ROOM_ADDED_HERE } = await importMobile('src/auth/account-messages.ts');
  const serverWords = 'Hold the first place, then add another through its monthly place add-on.';
  assert.ok((await readFile(new URL('../server/app.js', import.meta.url), 'utf8')).includes(serverWords), 'the words being replaced are still the server\'s');
  const said = accountMessage({ code: 'location_payment_required', message: serverWords });
  assert.equal(said, NO_ROOM_ADDED_HERE.location_payment_required);
  assert.match(said, /Remove a place to save the moment\.$/, 'it says what the person can do');
  for (const message of Object.values(NO_ROOM_ADDED_HERE)) {
    assert.doesNotMatch(message, /\$|\d|month|price|pay|buy|purchase|upgrade|add-on|unlock|web|site|browser|seat|slot|licen[cs]e/i, message);
  }
  assert.equal(accountMessage({ code: 'invalid_credentials', message: 'Password confirmation failed.' }), 'Password confirmation failed.', 'every other answer is still the server\'s own');
});

test('a shared moment cannot be taken back, and the form says so in the web\'s words', () => {
  const shared = { ...existing, visibility: 'shared-now' };
  assert.equal(draft.visibilityLocked(shared, 'private'), true);
  assert.equal(draft.visibilityLocked(shared, 'shared-now'), false);
  assert.equal(draft.visibilityLocked(existing, 'private'), false);
  assert.equal(draft.visibilityLocked(null, 'private'), false);
  for (const before of [shared, existing]) assert.ok(web.includes(`'${draft.visibilityHelp(before)}'`), draft.visibilityHelp(before));
  for (const [before, visibility] of [[existing, 'private'], [null, 'shared-now'], [null, 'private']]) assert.ok(web.includes(`'${draft.savedMessage(before, visibility)}'`));
  assert.equal(draft.sharePayload(existing).visibility, 'shared-now');
  assert.equal(draft.sharePayload(existing).version, 3);
});

test('sharing and deleting go through the consequence dialog; the currencies are the web\'s', async () => {
  const actions = await read('src/journey/moment-actions.ts');
  assert.ok(web.includes("confirmConsequence({ title: 'Share this moment now?', consequence: 'Everyone in this journey will be able to see it, including anyone who joins later. That access cannot be undone.', confirmLabel: 'Share this moment' })"));
  assert.match(actions, /title: 'Share this moment now\?',\s*consequence: 'Everyone in this journey will be able to see it, including anyone who joins later\. That access cannot be undone\.',\s*confirmLabel: 'Share this moment',/);
  assert.match(actions, /if \(before && before\.visibility !== 'shared-now' && draft\.visibility === 'shared-now' && !await shell\.confirmConsequence\(SHARE_NOW\)\) return false;/, 'turning an existing moment shared asks first');
  assert.match(actions, /confirmConsequence\(\{ title: 'Delete this moment\?', consequence: deleteConsequence\(moment\), confirmLabel: 'Delete moment', destructive: true \}\)/);
  assert.match(draft.deleteConsequence({ ...existing, visibility: 'shared-now' }), /deletion tombstone/);
  assert.doesNotMatch(draft.deleteConsequence(existing), /tombstone/);
  for (const [value, label] of draft.CURRENCIES) assert.ok(html.includes(`<option value="${value}">${label}</option>`), label);
});

test('the choice is made by seeing the result: the preview is the moment\'s own card', async () => {
  const form = await read('app/moment.tsx');
  assert.match(form, /<MomentCard moment=\{preview\} \/>/);
  assert.match(form, /visibility: draft\.visibility,\s*theme: draft\.theme,/, 'the preview follows the chosen visibility and theme as they change');
  assert.match(form, /borderLeftColor: cueColor/, 'each visibility choice carries its own border');
  assert.match(form, /<Text style=\{styles\.glyph\}>\{cue\.glyph\} <\/Text>\s*\{cue\.label\}/, 'and its own shape and word');
  assert.match(form, /accessibilityState=\{\{ checked: active, disabled: locked \}\}/);
  assert.match(form, /const \[before\] = useState<EditableMoment \| null>\(\(\) =>/, 'an edit stays on the version it began from, so a newer change is a conflict, never overwritten');
  assert.match(form, /useEffect\(\(\) => \(\) => clearStatus\('moment'\), \[clearStatus\]\)/, 'a problem with the form leaves with it');
});

test('places are typed, never taken from the phone: no location permission is asked for', async () => {
  const app = JSON.parse(await read('app.json'));
  const text = JSON.stringify(app);
  assert.doesNotMatch(text, /LOCATION|NSLocation/i);
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(Object.hasOwn(pkg.dependencies, 'expo-location'), false);
});

test('the calendar picks a day, not a moment in time: what is chosen is what is stored (#248)', async () => {
  for (const day of ['2026-01-01', '2026-02-28', '2026-09-30', '2026-12-31', '2024-02-29']) {
    assert.equal(draft.dayFrom(draft.calendarDate(day)), day, `${day} survives the round trip`);
  }
  assert.equal(draft.dayFrom(draft.calendarDate('not a date', new Date('2026-10-05T23:30:00Z'))), '2026-10-05', 'an unreadable field opens on today');
  assert.equal(draft.dayFrom(draft.calendarDate('2026-02-30', new Date('2026-10-05T00:10:00Z'))), '2026-10-05', 'so does a day that does not exist');
  const field = await read('src/components/date-field.tsx');
  assert.equal((field.match(/timeZoneName(=|: )['"]UTC['"]/g) || []).length, 2, 'both platforms\' calendars work in UTC, so the phone\'s own zone never shifts the day');
  assert.match(field, /mode(=|: )['"]date['"]/);
  assert.match(field, /<Field label=\{label\}[^>]*onChangeText=\{onChange\}/, 'typing the day still works');
  assert.match(await read('app/moment.tsx'), /<DateField label="When"/);
  const app = JSON.parse(await read('app.json'));
  assert.ok(app.expo.plugins.includes('@react-native-community/datetimepicker'));
  assert.doesNotMatch(JSON.stringify(app), /permission/i, 'a date picker asks for no permission');
});
