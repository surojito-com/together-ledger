import { demoState, isRetiredSyntheticDemo, isValidState, migrateState } from './model.js';

export const STORAGE_KEY = 'together-ledger-v3';
export const PREVIOUS_STORAGE_KEY = 'together-ledger-v2';
export const LEGACY_STORAGE_KEY = 'together-ledger-v1';

// The browser answers a read on the spot; a phone hands back a promise. The chain below is
// written once, as steps that ask for a read or a write, so the browser and the phone run the
// same migrations, the same three-key fallback and the same validity gate rather than two
// copies that could drift apart (TL-M-10, #185). A storage error is thrown back into the step
// that asked, so its own try/catch decides what happens, exactly as when it called storage itself.

function* loadSteps() {
  for (const key of [STORAGE_KEY, PREVIOUS_STORAGE_KEY, LEGACY_STORAGE_KEY]) {
    try {
      const raw = yield { get: key };
      if (!raw) continue;
      const state = migrateState(JSON.parse(raw));
      if (isRetiredSyntheticDemo(state)) {
        const fresh = demoState();
        yield* saveSteps(fresh);
        return fresh;
      }
      if (key !== STORAGE_KEY) yield* saveSteps(state);
      return state;
    } catch {
      // Keep looking. A damaged current value must not hide a valid legacy backup.
    }
  }
  return demoState();
}

function* saveSteps(state) {
  if (!isValidState(state)) throw new Error('The ledger data is not valid.');
  yield { set: STORAGE_KEY, value: JSON.stringify(state) };
}

function* resetSteps() {
  const state = demoState();
  yield* saveSteps(state);
  return state;
}

function* importSteps(text) {
  const parsed = JSON.parse(text);
  let state;
  try {
    state = migrateState(parsed?.data ?? parsed);
  } catch {
    throw new Error('This does not look like a valid Together Ledger export.');
  }
  yield* saveSteps(state);
  return state;
}

const perform = (storage, request) => ('get' in request ? storage.getItem(request.get) : storage.setItem(request.set, request.value));

function runSync(steps, storage) {
  let next = steps.next();
  while (!next.done) {
    let answer;
    try {
      answer = perform(storage, next.value);
    } catch (error) {
      next = steps.throw(error);
      continue;
    }
    next = steps.next(answer);
  }
  return next.value;
}

async function runAsync(steps, storage) {
  let next = steps.next();
  while (!next.done) {
    let answer;
    try {
      answer = await perform(storage, next.value);
    } catch (error) {
      next = steps.throw(error);
      continue;
    }
    next = steps.next(answer);
  }
  return next.value;
}

/**
 * The ledger over storage that answers at once (the browser's localStorage). getStorage is
 * asked on every call, so whichever store is current is the one used.
 */
export function createLedgerStore(getStorage) {
  return {
    loadState: () => runSync(loadSteps(), getStorage()),
    saveState: (state) => runSync(saveSteps(state), getStorage()),
    resetState: () => runSync(resetSteps(), getStorage()),
    exportState,
    importState: (text) => runSync(importSteps(text), getStorage()),
  };
}

/**
 * The same ledger over storage that answers later (a phone's). Every function that touches
 * storage returns a promise; the chain it runs is the browser's own.
 */
export function createPhoneLedgerStore(storage) {
  return {
    loadState: () => runAsync(loadSteps(), storage),
    saveState: (state) => runAsync(saveSteps(state), storage),
    resetState: () => runAsync(resetSteps(), storage),
    exportState,
    importState: (text) => runAsync(importSteps(text), storage),
  };
}

// localStorage is reached for inside each read and write, never before: in a browser that blocks
// storage, even reaching for it throws, and that must land in the chain's own try/catch.
const browserStorage = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
};
const browser = createLedgerStore(() => browserStorage);

export function loadState() {
  return browser.loadState();
}

export function saveState(state) {
  browser.saveState(state);
}

export function resetState() {
  return browser.resetState();
}

function stateWithExportAliases(state) {
  const aliases = new Map();
  const remember = (value) => {
    if (typeof value === 'string' && value && !aliases.has(value)) aliases.set(value, `journeyer-${aliases.size + 1}`);
  };
  const isAccountIdKey = (key) => key === 'userId' || key.endsWith('UserId');
  const visitAccountReferences = (value) => {
    if (Array.isArray(value)) return value.forEach(visitAccountReferences);
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([key, child]) => {
      if (isAccountIdKey(key)) remember(child);
      visitAccountReferences(child);
    });
  };

  state.trips.forEach((trip) => (trip.memberRecords || []).forEach((member) => remember(member.id)));
  visitAccountReferences(state);
  state.events.forEach((event) => { if (event.entityType === 'membership') remember(event.entityId); });

  // The state is JSON by construction, so a JSON copy is exact, and it runs where
  // structuredClone does not (a phone's JavaScript engine is not guaranteed to have it).
  const exported = JSON.parse(JSON.stringify(state));
  const replaceAccountReferences = (value) => {
    if (Array.isArray(value)) return value.forEach(replaceAccountReferences);
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([key, child]) => {
      if (isAccountIdKey(key) && aliases.has(child)) value[key] = aliases.get(child);
      else replaceAccountReferences(child);
    });
  };
  replaceAccountReferences(exported);
  exported.trips.forEach((trip) => (trip.memberRecords || []).forEach((member) => {
    if (aliases.has(member.id)) member.id = aliases.get(member.id);
  }));
  exported.events.forEach((event) => {
    if (event.entityType === 'membership' && aliases.has(event.entityId)) event.entityId = aliases.get(event.entityId);
  });
  return exported;
}

export function exportState(state) {
  if (!isValidState(state)) throw new Error('The ledger data is not valid.');
  return JSON.stringify({
    product: 'Together Ledger',
    exportedAt: new Date().toISOString(),
    identityProtection: 'account-aliases-v1',
    data: stateWithExportAliases(state),
  }, null, 2);
}

export function importState(text) {
  return browser.importState(text);
}
