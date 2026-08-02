import test from 'node:test';
import assert from 'node:assert/strict';
import { appendJourneyEvent, demoState, normalizeConcern } from '../src/model.js';
import { exportState, importState, LEGACY_STORAGE_KEY, loadState, STORAGE_KEY } from '../src/store.js';

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    value(key) { return values.get(key); },
  };
}

test('legacy browser state migrates to v2 without deleting the rollback copy', () => {
  const current = demoState();
  const legacy = {
    schemaVersion: 1,
    activeTripId: current.activeTripId,
    trips: current.trips.map(({ milestones, archivedAt, ...trip }) => trip),
    entries: current.entries,
  };
  const storage = memoryStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify(legacy) });
  globalThis.localStorage = storage;
  const loaded = loadState();
  assert.equal(loaded.schemaVersion, 2);
  assert.deepEqual(loaded.entries, legacy.entries);
  assert.equal(storage.value(LEGACY_STORAGE_KEY), JSON.stringify(legacy));
  assert.equal(JSON.parse(storage.value(STORAGE_KEY)).schemaVersion, 2);
  delete globalThis.localStorage;
});

test('exports round-trip every journey and rejects malformed imports', () => {
  globalThis.localStorage = memoryStorage();
  const state = demoState();
  state.preferences.onboardingComplete = true;
  const concern = normalizeConcern({ title: 'Confirm the deposit', detail: 'Ask before arrival.', status: 'open' }, state.activeTripId, 'Alex');
  state.concerns.push(concern);
  appendJourneyEvent(state, { tripId: state.activeTripId, actorName: 'Alex', action: 'concern_added', entityType: 'concern', entityId: concern.id, summary: `Logged concern: ${concern.title}`, before: null, after: concern });
  const imported = importState(exportState(state));
  assert.deepEqual(imported, state);
  assert.throws(() => importState('{"schemaVersion":2,"trips":[]}'), /valid Together Ledger export/);
  delete globalThis.localStorage;
});
