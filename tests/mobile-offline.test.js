import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';

// #352, #300: the phone in airplane mode, as the owner used it on Oct 9 (Android build 3).

const mobile = new URL('../apps/mobile/', import.meta.url);
const repo = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(new URL(path, mobile), 'utf8');

// The phone's own TypeScript, compiled on the spot, so these tests exercise the code the app runs.
async function importMobile(path) {
  const { outputText } = ts.transpileModule(await read(path), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

const journeyState = await importMobile('src/journey/journey-state.ts');
const { createAccountClient, OFFLINE_MESSAGE, UNREACHABLE_MESSAGE } = await importMobile('src/api/client.ts');
const { OFFLINE_NOTICE, CONNECTION_SOURCE } = await importMobile('src/shell/connection.ts');
const { showStatus, clearStatus } = await importMobile('src/shell/status.ts');
const { sessionFailed, LEDGER_WHILE_OFFLINE } = await importMobile('src/auth/session-state.ts');
const waiting = await importMobile('src/journey/waiting-moments.ts');

const offline = Object.assign(new Error(OFFLINE_MESSAGE), { code: 'offline', status: 0 });
const unreachable = Object.assign(new Error(UNREACHABLE_MESSAGE), { code: 'unreachable', status: 503 });
const conflict = Object.assign(new Error('The journey changed elsewhere.'), { code: 'conflict', status: 409 });

const journeys = [{ id: 'home', name: 'Our home' }, { id: 'trip', name: 'The trip' }];
const ready = { phase: 'ready', journeys, activeId: 'home', snapshot: { journey: { id: 'home', name: 'Our home' }, moments: [{ id: 'm1' }] } };

test('opening another journey offline keeps the open one, and opens the other once the connection is back', () => {
  const asked = journeyState.opening(ready, 'trip');
  assert.equal(asked.phase, 'ready', 'never blanked to loading');
  assert.equal(asked.activeId, 'home');
  assert.equal(asked.snapshot, ready.snapshot, 'the open journey\'s name and moments stay, from one snapshot');
  assert.deepEqual(asked.next, { journeyId: 'trip', when: 'opening' });

  const lost = journeyState.failedLoad(asked, offline);
  assert.equal(lost.phase, 'ready', 'a lost connection never empties the ledger');
  assert.equal(lost.snapshot, ready.snapshot);
  assert.deepEqual(lost.next, { journeyId: 'trip', when: 'when-back' });
  assert.equal(journeyState.preferredJourney(lost), 'trip', 'the next read, when the connection is back, opens the one asked for');
  assert.deepEqual(journeyState.failedLoad(asked, unreachable).next, { journeyId: 'trip', when: 'when-back' }, 'the service not answering is the same');

  // Any other failure is said in the status region, with the open journey still there.
  const refused = journeyState.failedLoad(asked, conflict);
  assert.equal(refused.snapshot, ready.snapshot);
  assert.equal(refused.next, null);
  assert.equal(journeyState.preferredJourney(refused), 'home');

  // Choosing the open one again stays there; a refresh that fails changes nothing.
  assert.equal(journeyState.opening(lost, 'home').next, null);
  assert.equal(journeyState.failedLoad(ready, offline), ready);
});

test('a first load the connection stopped is drawn as offline; any other says why, never a bare button', () => {
  assert.deepEqual(journeyState.failedLoad(null, offline), { phase: 'failed', reason: 'offline' });
  assert.deepEqual(journeyState.failedLoad({ phase: 'loading' }, unreachable), { phase: 'failed', reason: 'unreachable' });
  assert.deepEqual(journeyState.failedLoad(null, conflict), { phase: 'failed', reason: null });
  assert.equal(journeyState.offlineReason({ phase: 'failed', reason: 'offline' }), 'offline');
  assert.equal(journeyState.offlineReason({ phase: 'offline', reason: 'unreachable' }), 'unreachable');
  assert.equal(journeyState.offlineReason({ phase: 'failed', reason: null }), null);
  assert.equal(journeyState.offlineReason(ready), null);
});

test('the ledger never blanks: offline it shows its words, what waits with Try sending now, and Try again', async () => {
  const ledger = await read('app/ledger.tsx');
  assert.match(ledger, /if \(state\.phase === 'offline'\) return <LedgerWhileOffline reason=\{state\.reason\} onRetry=\{session\.refresh\} \/>;/);
  assert.match(ledger, /if \(state\.phase === 'failed'\) \{\s*if \(state\.reason\) return <LedgerWhileOffline reason=\{state\.reason\} onRetry=\{journey\.retry\} \/>;/, 'a load the connection stopped is drawn as the offline phase');
  const whileOffline = ledger.slice(ledger.indexOf('function LedgerWhileOffline'), ledger.indexOf('function JourneyPicker'));
  assert.match(whileOffline, /<Body>\{LEDGER_WHILE_OFFLINE\[reason\]\}<\/Body>/);
  assert.match(whileOffline, /<WaitingMoments activeJourneyId=\{null\} \/>/);
  assert.match(whileOffline, /<Button kind="quiet" label="Try again" onPress=\{onRetry\} \/>/);
  const failed = ledger.slice(ledger.indexOf("if (state.phase === 'failed')"), ledger.indexOf("if (state.phase === 'signed-out'"));
  assert.match(failed, /<Body>\{JOURNEYS_NOT_LOADED\}<\/Body>/, 'any other failure says so in words');
  assert.match(failed, /<WaitingMoments activeJourneyId=\{null\} \/>/, 'and what waits stays in sight');
  assert.match(ledger, /\{next && nextName \? <Text accessibilityLiveRegion="polite"[^>]*>\{nextJourneyWords\(nextName, next\.when\)\}<\/Text> : null\}/, 'the journey asked for is named under the choices');

  const card = await read('src/components/waiting-moments.tsx');
  assert.match(card, /const sendNow = session\.status === 'signed-in' \? waiting\.sendNow : session\.refresh;/, 'opened offline, Try sending now asks the service first, never does nothing');
  assert.match(card, /label=\{SEND_NOW_LABEL\} onPress=\{sendNow\}/);
  assert.equal(waiting.SEND_NOW_LABEL, 'Try sending now');
});

test('the loader keeps what is open, opens the one asked for when back, and clears the offline notice once it hears back', async () => {
  const hook = await read('src/journey/use-journey.ts');
  assert.match(hook, /setHeld\(\(current\) => \(\{ forUser, state: failedLoad\(current\?\.forUser === forUser \? current\.state : null, error\) \}\)\);/);
  assert.match(hook, /const preferredId = preferredJourney\(state\);/);
  assert.match(hook, /const reload = useCallback\(async \(\) => \{\s*if \(userId\) await load\(userId, preferredId\);/, 'the connection watch\'s reload opens it');
  assert.match(hook, /clearStatus\(CONNECTION_SOURCE\);/);
  assert.doesNotMatch(hook, /phase: 'failed' \}/, 'no failure without its reason');
});

test('one message for being offline on the phone: the connection notice\'s words', async () => {
  assert.equal(OFFLINE_MESSAGE, OFFLINE_NOTICE);
  const client = createAccountClient({ base: () => '/api/v1', tokens: { read: async () => ({ token: 't', tokenExpiresAt: '2099-01-01T00:00:00.000Z', refreshToken: 'r', refreshTokenExpiresAt: '2099-01-01T00:00:00.000Z' }), write: async () => {}, clear: async () => {} }, fetch: async () => { throw new TypeError('Network request failed'); } });
  await assert.rejects(client.journeys(), { code: 'offline', message: OFFLINE_NOTICE }, 'a read that cannot be sent says the notice\'s words');

  // Whoever noticed, it is one notice: a caution, under the connection's source, so reconnecting clears it.
  const fromJourney = showStatus(OFFLINE_MESSAGE, { source: 'journey' });
  assert.deepEqual(fromJourney, { message: OFFLINE_NOTICE, tone: 'caution', source: CONNECTION_SOURCE, inDialog: false });
  assert.deepEqual(fromJourney, showStatus(OFFLINE_NOTICE, { tone: 'caution', source: CONNECTION_SOURCE }), 'the same as the connection watch\'s');
  assert.equal(clearStatus(fromJourney, CONNECTION_SOURCE), null);
  assert.equal(showStatus(UNREACHABLE_MESSAGE, { source: 'journey' }).tone, 'caution', 'the service out of reach is a caution too');
  assert.equal(showStatus(UNREACHABLE_MESSAGE, { source: 'journey' }).source, 'journey', 'but it is not the offline notice');

  // "Private sync is temporarily unreachable." is retired on the phone, and "private sync" with it. The web keeps its words.
  const files = [];
  for (const dir of ['app', 'src']) {
    for (const entry of await readdir(new URL(`${dir}/`, mobile), { recursive: true })) if (/\.tsx?$/.test(entry)) files.push(`${dir}/${entry}`);
  }
  for (const file of files) assert.doesNotMatch(await read(file), /private sync/i, `${file} says "private sync"`);
  assert.match(await readFile(new URL('../src/api.js', import.meta.url), 'utf8'), /'Private sync is temporarily unreachable\.'/);
});

test('History and Journey sharing open once the connection is back, never "Sign in" or an endless "Loading…" while signed in', async () => {
  assert.equal(journeyState.opensWhenBack('History'), 'History opens once the connection is back.');
  const notOpen = await read('src/components/journey-not-open.tsx');
  assert.match(notOpen, /const offline = offlineReason\(state\);\s*if \(offline \|\| state\.phase === 'failed'\)/);
  assert.match(notOpen, /<Body>\{offline \? opensWhenBack\(title\) : JOURNEYS_NOT_LOADED\}<\/Body>/);
  assert.match(notOpen, /label="Try again" onPress=\{state\.phase === 'offline' \? session\.refresh : journey\.retry\}/);
  assert.match(notOpen, /state\.phase === 'signed-out' \? signedOut : state\.phase === 'no-journeys' \? noJourneys : 'Loading…'/, '"Sign in" only while signed out, "Loading…" only while loading');

  const history = await read('app/history.tsx');
  assert.match(history, /if \(state\.phase !== 'ready'\) return <JourneyNotOpen title="History" signedOut="Sign in and open a journey to see its history\." noJourneys=\{HISTORY_WITHOUT_JOURNEY\} \/>;/);
  const sharing = await read('app/journey-settings.tsx');
  assert.match(sharing, /<JourneyNotOpen title="Journey sharing" signedOut="Sign in and create a private journey to invite another journeyer\." noJourneys="Your account is ready\. Create a private journey to invite another journeyer\." \/>/);
  assert.doesNotMatch(sharing, /Loading this journey…/);
});

test('the words, for the owner to approve', () => {
  assert.equal(OFFLINE_MESSAGE, 'You’re offline. A moment you hold now waits on this phone and is sent when you reconnect. Your journeys will be back then; until then, nothing else can be changed.');
  assert.equal(UNREACHABLE_MESSAGE, 'Together Ledger can’t be reached right now. You’re still signed in. Try again in a moment.');
  assert.equal(LEDGER_WHILE_OFFLINE.offline, 'This phone is offline. You’re still signed in, and your journeys will be back here when it reconnects.');
  assert.equal(LEDGER_WHILE_OFFLINE.unreachable, 'Together Ledger can’t be reached right now. You’re still signed in on this phone. Try again in a moment.');
  assert.equal(journeyState.nextJourneyWords('The trip', 'opening'), 'Opening “The trip”…');
  assert.equal(journeyState.nextJourneyWords('The trip', 'when-back'), '“The trip” opens once the connection is back.');
  assert.equal(journeyState.opensWhenBack('Journey sharing'), 'Journey sharing opens once the connection is back.');
  assert.equal(journeyState.JOURNEYS_NOT_LOADED, 'Your journeys couldn’t be loaded just now.');
  assert.equal(journeyState.HISTORY_WITHOUT_JOURNEY, 'Your account is ready. Create a private journey, and its history will be here.');
});

// #353: offline never signs anyone out. #366: a moment held offline is sent once.
test('offline still never signs out, and a waiting moment is sent once, with the same key', async () => {
  const signedIn = { status: 'signed-in', user: { id: 'u1' } };
  assert.equal(sessionFailed(signedIn, offline), signedIn);
  assert.equal(sessionFailed(signedIn, unreachable), signedIn);
  const hook = await read('src/journey/use-journey.ts');
  assert.match(hook, /if \(\(error as \{ code\?: string \}\)\.code === 'authentication_required'\) setUser\(null\);/, 'only a refusal signs out');
  assert.equal((hook.match(/setUser\(/g) || []).length, 1);

  const items = new Map();
  const store = waiting.createWaitingStore({ getItem: async (key) => items.get(key) ?? null, setItem: async (key, value) => { items.set(key, value); }, removeItem: async (key) => { items.delete(key); } });
  const moment = { kind: 'memory', kindLabel: '', occurredOn: '2026-10-09', title: 'AirplaneModeEntry', detail: '', visibility: 'shared-now' };
  await store.add('u1', { key: 'k1', journeyId: 'home', journeyName: 'Our home', heldAt: '2026-10-09T10:00:00.000Z', moment, refusal: null });
  const held = new Map();
  let connected = false;
  const send = async (entry) => {
    if (!connected) throw offline;
    if (!held.has(entry.key)) held.set(entry.key, entry.moment);
  };
  const sent = [];
  const sendTo = async (entry) => { await send(entry); sent.push(entry.key); };
  assert.deepEqual(await waiting.sendWaiting('u1', { store, send: sendTo, describe: (error) => error.message }), { sent: [], stopped: 'wait' }, 'offline it waits');
  connected = true;
  await Promise.all([
    waiting.sendWaiting('u1', { store, send: sendTo, describe: (error) => error.message }),
    waiting.sendWaiting('u1', { store, send: sendTo, describe: (error) => error.message }),
  ]);
  assert.equal(held.size, 1, 'one moment in the journey, however many sends find it');
  assert.ok(sent.every((key) => key === 'k1'), 'every send carries the key the phone chose');
  assert.deepEqual(await store.list('u1'), [], 'and nothing is left waiting');
  assert.deepEqual(await waiting.sendWaiting('u1', { store, send: sendTo, describe: (error) => error.message }), { sent: [], stopped: null }, 'a later send has nothing to send again');
});

// Owner, Oct 10, decision 102: one offline sentence in both listings, and nothing broader (#360 is v2).
const SENTENCE = "You can hold a moment without a connection; it's sent when you're back online.";
const run = promisify(execFile);

async function checkListing(store, file, change) {
  const root = await mkdtemp(join(tmpdir(), 'listing-'));
  try {
    await cp(join(repo, 'store'), join(root, 'store'), { recursive: true });
    // The App Store check holds its notes to the code, so it reads these from the repository.
    await symlink(join(repo, 'apps'), join(root, 'apps'));
    await symlink(join(repo, 'server'), join(root, 'server'));
    const path = join(root, 'store', store, file);
    await writeFile(path, change(await readFile(path, 'utf8')));
    return await run(process.execPath, [join(root, 'store', store, 'check-listing.mjs')]).then(() => 'passed', (error) => error.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const [store, file] of [['google-play', 'full-description.txt'], ['app-store', 'description.txt']]) {
  test(`${store}: the offline sentence, once and word for word, and no broader claim`, async () => {
    const text = await readFile(join(repo, 'store', store, file), 'utf8');
    assert.equal(text.split(SENTENCE).length - 1, 1, 'the listing says it once');
    assert.equal(await checkListing(store, file, (words) => words), 'passed');
    assert.match(await checkListing(store, file, (words) => words.replace(SENTENCE, '')), /offline sentence 0 times/);
    assert.match(await checkListing(store, file, (words) => words.replace(SENTENCE, SENTENCE.replace('back online', 'online again'))), /offline sentence 0 times/, 'word for word');
    for (const broader of ['Read your journeys offline.', 'Browse every moment without a connection.', 'Works without internet.', 'Everything is there in airplane mode.']) {
      assert.match(await checkListing(store, file, (words) => words.replace(SENTENCE, `${SENTENCE} ${broader}`)), /only the offline sentence may speak of the connection/, broader);
    }
  });
}
