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
  const fresh = draft.draftFrom(null, { now: new Date(2026, 8, 30, 8) });
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
    [{ ...ok, title: '  ' }, 'Give this moment a short name.'],
    [{ ...ok, title: 'x'.repeat(121) }, 'Moment title is required and must be 120 characters or fewer.'],
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
  assert.equal(draft.deleteConsequence({ ...existing, visibility: 'shared-now' }), '“The road near Marlow” will be removed for everyone in this journey. The journey’s history will still show that it was deleted, and who deleted it.', 'plain words for the tombstone (#338)');
  assert.doesNotMatch(draft.deleteConsequence({ ...existing, visibility: 'shared-now' }), /tombstone|attributable/);
  assert.ok(server.includes("action: 'moment_deleted', entityType: 'moment', entityId: momentId, summary: `Deleted moment: ${before.title}`"), 'the history does keep that a shared moment was deleted, and by whom');
  assert.doesNotMatch(draft.deleteConsequence(existing), /tombstone|history/);
  for (const [value, label] of draft.CURRENCIES) assert.ok(html.includes(`<option value="${value}">${label}</option>`), label);
});

test('the currency is one compact drop-down, and "No currency" reads as nothing chosen (#351)', async () => {
  const form = await read('app/moment.tsx');
  assert.match(form, /<DropDown label=\{CURRENCY_LABEL\} options=\{CURRENCIES\} selected=\{draft\.moneyCurrency\} onSelect=\{\(value\) => set\(\{ moneyCurrency: value \}\)\} \/>/);
  assert.doesNotMatch(form, /<Choices label="Currency"/, 'no longer a row of eight chips');
  assert.equal(draft.CURRENCY_LABEL, 'Currency (optional)');
  assert.deepEqual(draft.CURRENCIES.map(([value]) => value), ['', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'INR'], 'the same values as before, in the same order');
  assert.deepEqual(draft.CURRENCIES[0], ['', 'No currency'], 'the empty choice is worded as no currency, not as the field\'s name');
  assert.ok(html.includes('<select name="moneyCurrency"><option value="">No currency</option>'), 'and the web\'s empty option says the same (the owner, on #351)');
  assert.ok(html.includes('<span class="sr-only">Currency</span><select name="moneyCurrency">'), 'the web\'s field keeps its own name for a screen reader');
  for (const currency of ['', 'INR']) assert.equal(draft.payloadFrom({ ...draft.draftFrom(null), title: 'x', moneyCurrency: currency }, null).moneyCurrency, currency, 'what is saved is unchanged');

  const dropDown = await read('src/components/drop-down.tsx');
  assert.match(dropDown, /accessibilityRole="button"/, 'the closed control is one button');
  assert.match(dropDown, /accessibilityState=\{\{ expanded: open \}\}/);
  assert.match(dropDown, /accessibilityLabel=\{`\$\{label\}: \$\{chosen\?\.\[1\] \?\? ''\}`\}/, 'a screen reader hears the field and what is chosen');
  assert.equal(dropDown.match(/targetSize/g).length, 3, 'the control and every option meet the 44-point target');
  assert.match(dropDown, /color: empty \? colors\.muted : colors\.fg/, 'nothing chosen is drawn as a placeholder');
  assert.match(dropDown, /accessibilityRole="radio"\s+accessibilityState=\{\{ checked: active \}\}/, 'in the list, the chosen one is checked');
  assert.match(dropDown, /\{active \? '● ' : ''\}\{words\}/, 'and marked by a shape as well as colour');
  assert.match(dropDown, /onRequestClose=\{\(\) => setOpen\(false\)\}/, 'Android\'s back gesture keeps things as they are');
  assert.match(dropDown, /label=\{KEEP_LABEL\}/);
});

test('an empty name is told at its own field, and the form takes the person there (#354)', async () => {
  const form = await read('app/moment.tsx');
  assert.equal(draft.MOMENT_NAME_MISSING, 'Give this moment a short name.');
  assert.match(form, /<Field\s+ref=\{titleInput\}\s+label="A short name"/, 'the field the message names');
  assert.match(form, /problem=\{titleProblem\}/, 'the field itself is marked');
  assert.match(form, /if \(problem === MOMENT_NAME_MISSING\) \{[\s\S]*?setTitleProblem\(problem\);\s*scroll\.current\?\.scrollTo\(\{ y: Math\.max\(0, titleTop\.current - 16\), animated: true \}\);\s*titleInput\.current\?\.focus\(\);\s*return;/, 'saving scrolls to the field and focuses it');
  assert.match(form, /<Screen scrollRef=\{scroll\}/);
  const ui = await read('src/components/ui.tsx');
  assert.match(ui, /accessibilityHint=\{problem \|\| undefined\}/, 'a screen reader hears the problem on the field');
  assert.match(ui, /borderColor: problem \? theme\.colors\.caution : theme\.colors\.border/, 'the mark is caution, never destructive: nothing has been lost');
  assert.match(ui, /STATUS_TONES\.caution\.glyph/, 'and a shape as well as a colour');
  assert.ok(web.includes('showStatus(MOMENT_NAME_MISSING, { source: \'moment\' });\n      form.elements.title.focus();'), 'the web says the same words and goes to the same field');
  assert.match(html, /<label class="field full"><span>A short name<\/span><input name="title" required/, 'where the browser\'s own check stops an empty one first');
});

test('deleting a moment sits in its own marked zone, apart from Save and Cancel (#338)', async () => {
  const form = await read('app/moment.tsx');
  assert.equal(draft.DELETE_ZONE_TITLE, 'Delete this moment');
  assert.equal(draft.DELETE_ZONE_NOTE, 'Deleting removes this moment from the ledger, and it can’t be undone. You’ll be asked once more before anything is deleted.');
  const cancel = form.indexOf('<Button kind="quiet" label="Cancel"');
  const zone = form.indexOf('styles.dangerZone');
  const del = form.indexOf('<Button kind="destructive" label="Delete moment"');
  assert.ok(cancel > 0 && cancel < zone && zone < del, 'Delete comes after Cancel, inside its own box');
  assert.equal(form.match(/label="Delete moment"/g).length, 1, 'there is one Delete button, and it is in the zone');
  assert.match(form, /\{before \? \(\s*<View style=\{\[styles\.dangerZone, \{ borderColor: colors\.destructive/, 'only an existing moment has the zone, and its border marks it');
  assert.match(form, /dangerZone: \{ gap: 10, marginTop: 40, borderWidth: 1, padding: 16 \}/, 'set apart by space as well as a border');
  assert.match(form, /<Text style=\{\[styles\.help, \{ color: colors\.muted \}\]\}>\{DELETE_ZONE_NOTE\}<\/Text>/);
  const actions = await read('src/journey/moment-actions.ts');
  assert.match(actions, /async remove\(moment: EditableMoment\) \{\s*if \(!journeyId\) return;\s*if \(!await shell\.confirmConsequence\(/, 'the second tap is the confirmation: nothing is deleted before it');
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
  // The iOS privacy manifest declares Precise Location as collected, because the phone re-sends the
  // coordinates a moment made on the web already holds (docs/STORE_READINESS.md, 1.1 and 3.2). That
  // is what we tell Apple, not a permission; everything else in app.json must still never name one.
  const { privacyManifests, ...ios } = app.expo.ios;
  assert.deepEqual(privacyManifests.NSPrivacyCollectedDataTypes.map((entry) => entry.NSPrivacyCollectedDataType).filter((type) => /Location/.test(type)), ['NSPrivacyCollectedDataTypePreciseLocation']);
  const text = JSON.stringify({ ...app, expo: { ...app.expo, ios } });
  assert.doesNotMatch(text, /LOCATION|NSLocation/i);
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(Object.hasOwn(pkg.dependencies, 'expo-location'), false);
});

test('the calendar picks a day, not a moment in time: what is chosen is what is stored (#248)', async () => {
  for (const day of ['2026-01-01', '2026-02-28', '2026-09-30', '2026-12-31', '2024-02-29']) {
    assert.equal(draft.dayFrom(draft.calendarDate(day)), day, `${day} survives the round trip`);
  }
  assert.equal(draft.dayFrom(draft.calendarDate('not a date', new Date(2026, 9, 5, 23, 30))), '2026-10-05', 'an unreadable field opens on today, the person\'s own day');
  assert.equal(draft.dayFrom(draft.calendarDate('2026-02-30', new Date(2026, 9, 5, 0, 10))), '2026-10-05', 'so does a day that does not exist');
  const field = await read('src/components/date-field.tsx');
  assert.equal((field.match(/timeZoneName(=|: )['"]UTC['"]/g) || []).length, 2, 'both platforms\' calendars work in UTC, so the phone\'s own zone never shifts the day');
  assert.match(field, /mode(=|: )['"]date['"]/);
  assert.match(field, /<Field label=\{label\}[^>]*onChangeText=\{onChange\}/, 'typing the day still works');
  assert.match(await read('app/moment.tsx'), /<DateField label="When"/);
  const app = JSON.parse(await read('app.json'));
  assert.ok(app.expo.plugins.includes('@react-native-community/datetimepicker'));
  // Only the network and what Play Billing needs are granted (tests/mobile-permissions.test.js), and iOS asks for nothing.
  assert.deepEqual(app.expo.android.permissions, ['android.permission.INTERNET', 'com.android.vending.BILLING', 'android.permission.ACCESS_NETWORK_STATE'], 'a date picker asks for no permission');
  assert.doesNotMatch(JSON.stringify(app.expo.ios), /UsageDescription/, 'a date picker asks for no permission');
});

test('a new moment starts on the person\'s own day: 8 pm on Oct 7 in New York is Oct 7 (#336)', () => {
  const before = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const evening = new Date('2026-10-08T00:00:00Z');
    assert.equal(draft.today(evening), '2026-10-07');
    assert.equal(draft.draftFrom(null, { now: evening }).occurredOn, '2026-10-07');
    assert.equal(draft.dayFrom(draft.calendarDate('', evening)), '2026-10-07', 'the calendar opens on that day too');
    assert.equal(draft.dayFrom(draft.calendarDate('2026-10-07')), '2026-10-07', 'and a chosen day is still the day stored, whatever the zone (#248)');
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
  assert.doesNotMatch(web, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/, 'the web never takes the UTC day for today');
  assert.equal(web.match(/form\.elements\.occurredOn\.value = localDay\(\);/g).length, 2, 'the web\'s moment and expense forms start on the local day');
});
