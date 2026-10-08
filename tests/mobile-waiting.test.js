import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const mobile = new URL('../apps/mobile/', import.meta.url);
const read = (path) => readFile(new URL(path, mobile), 'utf8');

// The phone's own TypeScript, compiled on the spot, so these tests exercise the code the app runs.
async function importMobile(path) {
  const { outputText } = ts.transpileModule(await read(path), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

const waiting = await importMobile('src/journey/waiting-moments.ts');

// The phone's storage, as expo-sqlite's kv-store answers it: later, never at once.
function memoryStorage() {
  const items = new Map();
  const later = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
  return {
    items,
    async getItem(key) { await later(); return items.has(key) ? items.get(key) : null; },
    async setItem(key, value) { await later(); items.set(key, value); },
    async removeItem(key) { await later(); items.delete(key); },
  };
}

const moment = (title, visibility = 'shared-now') => ({ kind: 'memory', kindLabel: '', occurredOn: '2026-10-08', title, detail: '', visibility, theme: '', moneyCents: null, moneyCurrency: '', locations: [] });
const entry = (key, title, journeyId = 'j1') => ({ key, journeyId, journeyName: 'Ours', heldAt: '2026-10-08T04:33:00.000Z', moment: moment(title), refusal: null });

test('a waiting moment is kept for one account, and only ever read for it', async () => {
  const storage = memoryStorage();
  const store = waiting.createWaitingStore(storage);
  await store.add('alice', entry('k1', 'AirplaneModeEntry'));
  await store.add('alice', entry('k1', 'AirplaneModeEntry'));
  assert.deepEqual((await store.list('alice')).map((held) => held.key), ['k1'], 'the same key is kept once');
  assert.deepEqual(await store.list('bob'), [], 'another account sees nothing of it');
  assert.ok(storage.items.has(waiting.waitingKeyFor('alice')));

  await store.refuse('alice', 'k1', { code: 'conflict', message: 'No.' });
  assert.deepEqual((await store.list('alice'))[0].refusal, { code: 'conflict', message: 'No.' });
  await store.refuse('alice', 'k1', null);
  assert.equal((await store.list('alice'))[0].refusal, null);
  await store.remove('alice', 'k1');
  assert.equal(storage.items.has(waiting.waitingKeyFor('alice')), false, 'nothing left behind once the last one is gone');

  await store.add('alice', entry('k2', 'Second'));
  await store.clear('alice');
  assert.deepEqual(await store.list('alice'), []);

  await store.rememberSignedIn('alice');
  assert.equal(await store.signedInAccount(), 'alice');
  await store.rememberSignedIn(null);
  assert.equal(await store.signedInAccount(), null);
});

test('changes made together are all kept, in the order they were held', async () => {
  const store = waiting.createWaitingStore(memoryStorage());
  await Promise.all(Array.from({ length: 12 }, (_, n) => store.add('alice', entry(`k${n}`, `Moment ${n}`))));
  assert.deepEqual((await store.list('alice')).map((held) => held.key), Array.from({ length: 12 }, (_, n) => `k${n}`));
  await Promise.all([store.remove('alice', 'k3'), store.refuse('alice', 'k5', { code: 'x', message: 'y' }), store.add('alice', entry('k12', 'Last'))]);
  const after = await store.list('alice');
  assert.equal(after.length, 12);
  assert.equal(after.find((held) => held.key === 'k5').refusal.code, 'x');
});

test('what the phone cannot read is not taken for a moment', async () => {
  const storage = memoryStorage();
  const store = waiting.createWaitingStore(storage);
  storage.items.set(waiting.waitingKeyFor('alice'), 'not json');
  assert.deepEqual(await store.list('alice'), []);
  storage.items.set(waiting.waitingKeyFor('alice'), JSON.stringify([{ key: 'k1' }, entry('k2', 'Whole')]));
  assert.deepEqual((await store.list('alice')).map((held) => held.key), ['k2']);
});

test('a failed send waits, stops for a refused sign-in, or keeps the service\'s refusal', () => {
  const cases = [
    [{ code: 'offline' }, 'wait'],
    [{ code: 'unreachable', status: 503 }, 'wait'],
    [{ code: 'accounts_unavailable' }, 'wait'],
    [{ code: 'request_failed', status: 500 }, 'wait'],
    [{ code: 'rate_limited', status: 429 }, 'wait'],
    [{ code: 'authentication_required', status: 401 }, 'signed-out'],
    [{ code: 'invalid_input', status: 400 }, 'refused'],
    [{ code: 'forbidden', status: 403 }, 'refused'],
    [{ code: 'conflict', status: 409 }, 'refused'],
    [{ code: 'location_payment_required', status: 409 }, 'refused'],
    [{ code: 'capacity_resting', status: 409 }, 'refused'],
    [{ code: 'moment_key_reused', status: 409 }, 'refused'],
    [{ code: 'moment_already_deleted', status: 409 }, 'refused'],
    [new Error('anything else'), 'wait'],
  ];
  for (const [error, outcome] of cases) assert.equal(waiting.sendOutcome(error), outcome, JSON.stringify(error));
});

test('waiting moments go in order, a refusal stays with its moment, and losing the connection stops the rest', async () => {
  const store = waiting.createWaitingStore(memoryStorage());
  for (const [key, title] of [['k1', 'First'], ['k2', 'Refused'], ['k3', 'Third'], ['k4', 'Fourth']]) await store.add('alice', entry(key, title));
  const tried = [];
  let online = true;
  const send = async (held) => {
    tried.push(held.key);
    if (!online) throw Object.assign(new Error('Private sync is temporarily unreachable.'), { code: 'offline', status: 0 });
    if (held.key === 'k2') throw Object.assign(new Error('Choose a valid moment date.'), { code: 'invalid_input', status: 400 });
    if (held.key === 'k3') online = false;
  };
  const describe = (error) => error.message;

  const first = await waiting.sendWaiting('alice', { store, send, describe });
  assert.deepEqual(tried, ['k1', 'k2', 'k3', 'k4'], 'oldest first; a refusal does not hold up the next');
  assert.deepEqual(first, { sent: ['k1', 'k3'], stopped: 'wait' });
  const left = await store.list('alice');
  assert.deepEqual(left.map((held) => held.key), ['k2', 'k4'], 'nothing is dropped');
  assert.deepEqual(left[0].refusal, { code: 'invalid_input', message: 'Choose a valid moment date.' });
  assert.equal(left[1].refusal, null, 'the one cut off by the connection is still simply waiting');

  online = true;
  tried.length = 0;
  assert.deepEqual(await waiting.sendWaiting('alice', { store, send, describe }), { sent: ['k4'], stopped: null });
  assert.deepEqual(tried, ['k4'], 'a refused moment is not sent again until the person asks');
  assert.deepEqual((await store.list('alice')).map((held) => held.key), ['k2'], 'it waits for the person, with its message');

  await store.add('alice', entry('k5', 'After a refused sign-in'));
  const refusedSignIn = async () => { throw Object.assign(new Error('Sign in to continue.'), { code: 'authentication_required', status: 401 }); };
  assert.deepEqual(await waiting.sendWaiting('alice', { store, send: refusedSignIn, describe }), { sent: [], stopped: 'signed-out' });
  assert.deepEqual((await store.list('alice')).map((held) => [held.key, held.refusal?.code ?? null]), [['k2', 'invalid_input'], ['k5', null]], 'kept for when the same account signs in again');
  assert.deepEqual(await store.list('bob'), []);
});

test('the words the person reads, for the owner to approve', () => {
  assert.equal(waiting.WAITING_TITLE, 'Waiting to send');
  assert.equal(waiting.WAITING_HELP, 'Kept on this phone until the service has them, and sent in the order you held them. Nobody else sees them before then.');
  assert.deepEqual({ ...waiting.WAITING_CUE }, { glyph: '▲', waiting: 'Waiting to send', refused: 'Not sent' });
  assert.equal(waiting.onceSent('shared-now'), 'Once it’s sent, everyone in this journey will see it.');
  assert.equal(waiting.onceSent('share-later'), 'Once it’s sent, it stays with you until you share it.');
  assert.equal(waiting.onceSent('private'), 'Once it’s sent, it stays with you.');
  assert.equal(waiting.KEPT_ON_PHONE, 'Kept on this phone. It will be sent when the connection returns.');
  assert.equal(waiting.sentFromPhone(1), 'Your waiting moment was sent.');
  assert.equal(waiting.sentFromPhone(3), '3 waiting moments were sent.');
  assert.equal(waiting.waitingWhileOffline(1), 'One moment you held is waiting on this phone. It will be sent when the connection returns.');
  assert.equal(waiting.waitingWhileOffline(2), '2 moments you held are waiting on this phone. They will be sent when the connection returns.');
  assert.deepEqual(waiting.signOutConsequence(1), { title: 'Sign out with moments waiting?', consequence: 'One moment you held hasn’t been sent yet. Signing out removes it from this phone, and it can’t be sent later.', confirmLabel: 'Sign out and remove it', destructive: true });
  assert.equal(waiting.signOutConsequence(2).consequence, '2 moments you held haven’t been sent yet. Signing out removes them from this phone, and they can’t be sent later.');
  assert.equal(waiting.signOutConsequence(2).confirmLabel, 'Sign out and remove them');
  assert.deepEqual(waiting.discardConsequence(entry('k', 'AirplaneModeEntry')), { title: 'Discard this moment?', consequence: '“AirplaneModeEntry” was never sent. Discarding removes it from this phone, and it can’t be brought back.', confirmLabel: 'Discard moment', destructive: true });
  assert.equal(waiting.removedWithAccount(0), '');
  assert.equal(waiting.removedWithAccount(1), 'One moment waiting on this phone was never sent, and is removed too.');
  assert.equal(waiting.removedWithAccount(4), '4 moments waiting on this phone were never sent, and are removed too.');
  for (const words of [waiting.WAITING_HELP, waiting.KEPT_ON_PHONE, waiting.waitingWhileOffline(2), waiting.onceSent('shared-now')]) {
    assert.doesNotMatch(words, /\b(seat|seats|license|slot|removed for)\b/i);
  }
});

test('waiting moments live in the phone\'s own storage, never the keychain, and are drawn as waiting, never as shared', async () => {
  const storage = await read('src/storage/phone-storage.ts');
  assert.match(storage, /from 'expo-sqlite\/kv-store'/);
  assert.match(storage, /export const waitingStore = createWaitingStore\(phoneStorage\);/);
  const provider = await read('src/journey/use-waiting-moments.ts');
  assert.match(provider, /import \{ waitingStore \} from '\.\.\/storage\/phone-storage';/);
  assert.doesNotMatch(provider, /secure-store|token-storage/);
  assert.match(provider, /import \{ randomUUID \} from 'expo-crypto';/, 'each key is a random id chosen on this phone');
  assert.match(provider, /client\.createMoment\(entry\.journeyId, entry\.moment, entry\.key\)/, 'every send of a moment carries the same key');

  const card = await read('src/components/waiting-moments.tsx');
  assert.doesNotMatch(card, /<MomentCard/, 'a waiting moment never carries a visibility cue that says it is shared');
  assert.match(card, /borderLeftColor: colors\.caution/);
  assert.doesNotMatch(card, /destructive/, 'waiting is not a failure, and never takes the destructive colour');
  assert.match(card, /confirmConsequence\(discardConsequence\(entry\)\)\) await waiting\.discard\(entry\.key\)/, 'discarding is asked first');
  assert.match(card, /\{entry\.refusal \? \(/, 'only a refused moment offers Discard');

  const ledger = await read('app/ledger.tsx');
  assert.match(ledger, /<WaitingMoments activeJourneyId=\{activeId\} \/>/);
  assert.match(ledger, /waitingWhileOffline\(waiting\.moments\.length\)/, 'an app opened offline still says what waits');
});

test('signing out on purpose asks first; a sign-in that ends by itself keeps what waits', async () => {
  const account = await read('app/account.tsx');
  const ask = account.indexOf('confirmConsequence(signOutConsequence(held))');
  const clear = account.indexOf('if (held) await waiting.clear();');
  const logout = account.indexOf('await session.client.logout();');
  assert.ok(ask > 0 && clear > ask && logout > clear, 'counted and asked, then cleared, then signed out');
  assert.match(account, /if \(held && !await shell\.confirmConsequence\(signOutConsequence\(held\)\)\) return;/, 'keeping them keeps the sign-in too');

  // A refused renewal clears only the tokens; nothing that clears them knows about waiting moments.
  for (const path of ['src/api/client.ts', 'src/auth/session.tsx', 'src/auth/session-state.ts', 'src/journey/use-journey.ts']) {
    assert.doesNotMatch(await read(path), /waiting|waitingStore/i, `${path} never clears what waits`);
  }

  const deletion = await read('app/delete-account.tsx');
  assert.match(deletion, /removedWithAccount\(waiting\.moments\.length\)/, 'deleting says what waits before it is gone');
  assert.ok(deletion.indexOf('await session.client.deleteAccount(password);') < deletion.indexOf('await waiting.clear();'), 'cleared only once the account is really deleted');
});

test('a new moment waits when the service is out of reach; changing one still needs the connection', async () => {
  const actions = await read('src/journey/moment-actions.ts');
  assert.match(actions, /const held = await waiting\.hold\(journeyId, journeyName, payload\)/);
  assert.match(actions, /if \(held === 'waiting'\) \{\s*router\.back\(\);\s*shell\.showToast\(KEPT_ON_PHONE\);/);
  assert.match(actions, /client\.updateMoment\(journeyId, before\.id, payload\)/, 'an edit is sent as before');
  assert.doesNotMatch(actions, /client\.createMoment/, 'a new moment only ever goes through the waiting store');
});
