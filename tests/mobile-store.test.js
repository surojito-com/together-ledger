import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { demoState, isRetiredSyntheticDemo, migrateState, normalizeConcern, normalizeMoment } from '../src/model.js';
import { createLedgerStore, LEGACY_STORAGE_KEY, loadState, PREVIOUS_STORAGE_KEY, saveState, STORAGE_KEY } from '../src/store.js';
import '../src/themes.js';

const mobile = new URL('../apps/mobile/', import.meta.url);
const read = (path) => readFile(new URL(path, mobile), 'utf8');

// The phone's own TypeScript, compiled on the spot. Its relative imports of the web's modules
// are pointed at the real files, so the phone and these tests share one copy of each.
async function importMobile(path) {
  const url = new URL(path, mobile);
  const source = await readFile(url, 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const linked = outputText.replace(/from '(\.[^']+\.js)'/g, (_, specifier) => `from '${new URL(specifier, url).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(linked).toString('base64')}`);
}

const { createPhoneStore, SAVE_FAILED_MESSAGE, THEME_KEY } = await importMobile('src/storage/ledger-store.ts');

// The browser's storage answers at once; the phone's answers later. Both hold the same values,
// so after the same steps their contents can be compared directly.
function browserStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

function phoneStorage(seed = {}, { failReads = false, failWrites = false } = {}) {
  const values = new Map(Object.entries(seed));
  const later = (work) => new Promise((resolve, reject) => setTimeout(() => {
    try { resolve(work()); } catch (error) { reject(error); }
  }, 0));
  return {
    values,
    writes: 0,
    getItem(key) { return later(() => { if (failReads) throw new Error('blocked'); return values.get(key) ?? null; }); },
    setItem(key, value) { return later(() => { if (failWrites) throw new Error('disk full'); this.writes += 1; values.set(key, String(value)); }); },
    removeItem(key) { return later(() => { values.delete(key); }); },
  };
}

/** Run the same seed through the browser and the phone; return both states and both storages. */
async function bothLoad(seed) {
  const browser = browserStorage(seed);
  const phone = phoneStorage(seed);
  const onBrowser = createLedgerStore(() => browser).loadState();
  const onPhone = await createPhoneStore(phone).loadState();
  return { onBrowser, onPhone, browser: browser.values, phone: phone.values };
}

// A ledger as each earlier schema wrote it. v1 had no milestones or archive; v2 no moments;
// later versions add fields the migration fills in.
function payload(schemaVersion) {
  const current = demoState();
  current.preferences.onboardingComplete = true;
  current.entries.push({ id: 'expense-1', tripId: current.activeTripId, merchant: 'Train tickets', category: 'Transportation', amountCents: 4200, occurredOn: '2026-01-01', paidBy: 'You' });
  if (schemaVersion === 1) {
    return { schemaVersion, activeTripId: current.activeTripId, trips: current.trips.map(({ milestones, archivedAt, ...trip }) => trip), entries: current.entries };
  }
  const older = { ...current, schemaVersion };
  if (schemaVersion === 2) delete older.moments;
  if (schemaVersion <= 3) { delete older.concerns; delete older.events; }
  return older;
}

test('a v1, v2 and v3 ledger each land at v6 with the same result on the web and the phone', async () => {
  for (const schemaVersion of [1, 2, 3]) {
    const raw = JSON.stringify(payload(schemaVersion));
    for (const key of [STORAGE_KEY, PREVIOUS_STORAGE_KEY, LEGACY_STORAGE_KEY]) {
      const { onBrowser, onPhone, browser, phone } = await bothLoad({ [key]: raw });
      assert.equal(onPhone.schemaVersion, 6, `schema v${schemaVersion} under ${key}`);
      assert.deepEqual(onPhone, onBrowser, `schema v${schemaVersion} under ${key}`);
      assert.equal(onPhone.entries.length, 1, 'the ledger itself came through, not an empty fallback');
      assert.equal(onPhone.preferences.onboardingComplete, schemaVersion !== 1, 'v1 had no preferences to carry');
      // Before v3 there were no moments, so each expense becomes a practical one.
      assert.equal(onPhone.moments.length, schemaVersion < 3 ? 1 : 0);
      assert.deepEqual(phone, browser, `schema v${schemaVersion} under ${key} leaves the same storage`);
      if (key !== STORAGE_KEY) {
        assert.equal(phone.get(key), raw, 'the rollback copy is kept as it was');
        assert.equal(JSON.parse(phone.get(STORAGE_KEY)).schemaVersion, 6, 'the current key is written');
      }
    }
  }
});

test('every schema from v1 to v6 migrates identically on both clients', async () => {
  for (const schemaVersion of [1, 2, 3, 4, 5, 6]) {
    const { onBrowser, onPhone, browser, phone } = await bothLoad({ [PREVIOUS_STORAGE_KEY]: JSON.stringify(payload(schemaVersion)) });
    assert.equal(onPhone.entries.length, 1, `schema v${schemaVersion} came through`);
    assert.deepEqual(onPhone, onBrowser, `schema v${schemaVersion}`);
    assert.deepEqual(phone, browser, `schema v${schemaVersion}`);
  }
});

test('a damaged current value does not hide a valid older backup, on either client', async () => {
  const backup = JSON.stringify(payload(2));
  for (const damaged of ['{not json', JSON.stringify({ schemaVersion: 99, trips: [], entries: [] })]) {
    const { onBrowser, onPhone, browser, phone } = await bothLoad({ [STORAGE_KEY]: damaged, [LEGACY_STORAGE_KEY]: backup });
    assert.equal(onPhone.entries.length, 1);
    assert.deepEqual(onPhone, onBrowser);
    assert.deepEqual(phone, browser);
  }
});

test('nothing saved, or nothing readable, begins with an empty shared space', async () => {
  const { onBrowser, onPhone, phone } = await bothLoad({});
  assert.deepEqual(onPhone, demoState());
  assert.deepEqual(onPhone, onBrowser);
  assert.equal(phone.size, 0, 'loading writes nothing when there is nothing to carry forward');

  const blocked = phoneStorage({ [STORAGE_KEY]: JSON.stringify(payload(6)) }, { failReads: true });
  assert.deepEqual(await createPhoneStore(blocked).loadState(), demoState(), 'a blocked store still renders');
});

test('a browser that blocks storage outright still opens, and a write to it fails loudly rather than silently', () => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    assert.deepEqual(loadState(), demoState(), 'a blocked store still renders');
    assert.throws(() => saveState(demoState()), /SecurityError/);
  } finally {
    delete globalThis.localStorage;
  }
});

test('the retired synthetic demo is replaced the same way on both clients', async () => {
  const demo = {
    ...demoState(),
    activeTripId: 'demo-coast',
    trips: [{ ...demoState().trips[0], id: 'demo-coast', name: 'Coastal Weekend' }],
    entries: [1, 2, 3].map((n) => ({ id: `demo-${n}`, tripId: 'demo-coast', merchant: 'Demo', category: 'Other', amountCents: 100, occurredOn: '2026-01-01' })),
    moments: ['moment-1', 'moment-2', 'moment-3', 'practical-demo-1', 'practical-demo-2', 'practical-demo-3'].map((id) => normalizeMoment({ kind: 'memory', title: 'Demo', detail: '', occurredOn: '2026-01-01', visibility: 'shared-now', money: '' }, 'demo-coast', { id })),
    concerns: [{ ...normalizeConcern({ title: 'Demo', detail: '', status: 'open' }, 'demo-coast', 'You'), id: 'thread-1' }],
    events: [{ id: 'demo-event-1', tripId: 'demo-coast', sequence: 1, occurredAt: '2026-01-01T12:00:00.000Z', actorName: 'You', action: 'concern_added', entityType: 'concern', entityId: 'thread-1', summary: 'Demo', previousEventId: '', source: 'synthetic-demo' }],
  };
  assert.ok(isRetiredSyntheticDemo(migrateState(demo)), 'the fixture is the retired demo');
  const { onBrowser, onPhone, browser, phone } = await bothLoad({ [STORAGE_KEY]: JSON.stringify(demo) });
  assert.deepEqual(onPhone, demoState());
  assert.deepEqual(JSON.parse(phone.get(STORAGE_KEY)), demoState(), 'the empty space replaced the demo in storage');
  assert.deepEqual(onPhone, onBrowser);
  assert.deepEqual(phone, browser);
});

test('an invalid state is never written on the phone, and an invalid import is refused in the web\'s words', async () => {
  const phone = phoneStorage();
  const store = createPhoneStore(phone);
  const invalid = { ...demoState(), moments: null };
  await assert.rejects(store.saveState(invalid), /The ledger data is not valid\./);
  await assert.rejects(store.saveState({ ...demoState(), schemaVersion: 5 }), /The ledger data is not valid\./);
  await assert.rejects(store.importState('{"schemaVersion":2,"trips":[]}'), /valid Together Ledger export/);
  await assert.rejects(store.importState('{not json'));
  assert.equal(phone.writes, 0);
  assert.equal(phone.values.size, 0);
});

test('a backup exported on one client imports to the same ledger on the other', async () => {
  const state = demoState();
  state.preferences.onboardingComplete = true;
  state.trips[0].memberRecords = [{ id: '54bf0d03-ddb6-4c63-b176-a993179d0c5d', displayName: 'Journey owner', role: 'owner' }];
  const browser = createLedgerStore(() => browserStorage());
  const phoneValues = phoneStorage();
  const phone = createPhoneStore(phoneValues);

  const fromBrowser = browser.exportState(state);
  const fromPhone = phone.exportState(state);
  assert.deepEqual(JSON.parse(fromPhone).data, JSON.parse(fromBrowser).data);
  assert.doesNotMatch(fromPhone, /54bf0d03/);

  const imported = await phone.importState(fromBrowser);
  assert.deepEqual(imported, browser.importState(fromPhone));
  assert.deepEqual(await phone.loadState(), imported, 'the import is what the phone opens to next');
});

test('a write that fails rejects instead of crashing, and loading still answers', async () => {
  const full = phoneStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify(payload(1)) }, { failWrites: true });
  const store = createPhoneStore(full);
  await assert.rejects(store.saveState(demoState()), /disk full/);
  await assert.rejects(store.completeOnboarding(), /disk full/);
  // The browser's chain treats a failed write-back as a reason to keep looking; so does the phone's.
  const browser = browserStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify(payload(1)) });
  browser.setItem = () => { throw new Error('disk full'); };
  assert.deepEqual(await store.loadState(), createLedgerStore(() => browser).loadState());
  assert.match(SAVE_FAILED_MESSAGE, /^This phone could not save that change\./);
});

test('beginning the ledger is remembered on the phone, inside the ledger, as on the web', async () => {
  const phone = phoneStorage();
  const store = createPhoneStore(phone);
  await store.completeOnboarding();
  assert.equal((await store.loadState()).preferences.onboardingComplete, true);
  assert.equal(JSON.parse(phone.values.get(STORAGE_KEY)).preferences.onboardingComplete, true);
  const writes = phone.writes;
  await store.completeOnboarding();
  assert.equal(phone.writes, writes, 'a second begin writes nothing');
});

test('every retired theme id resolves to the same survivor on the phone as on the web, and is settled once', async () => {
  const retired = globalThis.TOGETHER_RETIRED_THEMES;
  assert.equal(Object.keys(retired).length, 12);
  const { resolveTheme } = await importMobile('src/theme/resolve-theme.ts');
  const tokens = JSON.parse(await read('src/theme/tokens.json'));
  const onPhone = (saved) => resolveTheme(saved, tokens);
  for (const id of Object.keys(retired)) {
    const phone = phoneStorage({ [THEME_KEY]: id });
    const applied = await createPhoneStore(phone).loadTheme(onPhone);
    assert.equal(applied, globalThis.resolveTogetherTheme(id), id);
    assert.equal(phone.values.get(THEME_KEY), applied, `${id} is saved as its survivor`);
  }
  const current = phoneStorage({ [THEME_KEY]: 'flexoki' });
  assert.equal(await createPhoneStore(current).loadTheme(onPhone), 'flexoki');
  assert.equal(current.writes, 0, 'a current theme is not rewritten');
  assert.equal(await createPhoneStore(phoneStorage()).loadTheme(onPhone), null, 'no choice follows the phone');

  const chosen = phoneStorage();
  await createPhoneStore(chosen).saveTheme('green');
  assert.equal(chosen.values.get(THEME_KEY), 'green');
  await createPhoneStore(chosen).saveTheme(null);
  assert.equal(chosen.values.has(THEME_KEY), false, 'following the phone again forgets the choice');
});

test('only the phone storage file touches SQLite, and tokens never leave the keychain', async () => {
  const files = ['app/_layout.tsx', 'src/storage/ledger-store.ts', 'src/storage/use-stored-preferences.ts', 'src/auth/session.tsx', 'src/auth/token-storage.ts', 'src/api/client.ts', 'src/theme/theme-provider.tsx', 'src/shell/shell-provider.tsx'];
  for (const file of files) assert.doesNotMatch(await read(file), /expo-sqlite/, file);
  assert.match(await read('src/storage/phone-storage.ts'), /from 'expo-sqlite\/kv-store'/);
  assert.doesNotMatch(await read('src/storage/phone-storage.ts'), /SecureStore|token-storage'/, 'tokens are never moved into the ledger store');
  const layout = await read('app/_layout.tsx');
  assert.match(layout, /if \(!fontsLoaded \|\| !stored\) return null;/, 'nothing is drawn before the saved theme is known');
  assert.match(layout, /showStatus\(failure\.message, \{ tone: 'caution', source: 'storage' \}\)/, 'a failed save goes to the status region');
});
