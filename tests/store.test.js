import test from 'node:test';
import assert from 'node:assert/strict';
import { appendJourneyEvent, demoState, normalizeConcern } from '../src/model.js';
import { exportState, importState, LEGACY_STORAGE_KEY, loadState, PREVIOUS_STORAGE_KEY, STORAGE_KEY } from '../src/store.js';

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    value(key) { return values.get(key); },
  };
}

test('legacy browser state migrates to the current schema without deleting the rollback copy', () => {
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
  assert.equal(loaded.schemaVersion, 4);
  assert.deepEqual(loaded.entries, legacy.entries);
  assert.equal(loaded.moments.length, legacy.entries.length);
  assert.equal(storage.value(LEGACY_STORAGE_KEY), JSON.stringify(legacy));
  assert.equal(JSON.parse(storage.value(STORAGE_KEY)).schemaVersion, 4);
  delete globalThis.localStorage;
});

test('v2 browser data remains available from its former storage key', () => {
  const state = demoState();
  const v2 = { ...state, schemaVersion: 2 };
  delete v2.moments;
  globalThis.localStorage = memoryStorage({ [PREVIOUS_STORAGE_KEY]: JSON.stringify(v2) });
  const loaded = loadState();
  assert.equal(loaded.schemaVersion, 4);
  assert.equal(loaded.entries.length, state.entries.length);
  assert.equal(loaded.moments.length, state.entries.length);
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

test('exports replace account IDs with aliases without changing the working state', () => {
  globalThis.localStorage = memoryStorage();
  const state = demoState();
  const ownerId = '54bf0d03-ddb6-4c63-b176-a993179d0c5d';
  const memberId = 'b5dad022-3b9e-4e03-9c1a-8944547c4d97';
  const trip = state.trips[0];
  trip.memberRecords = [
    { id: ownerId, displayName: 'Journey owner', role: 'owner', joinedAt: '2026-08-23T14:00:00.000Z' },
    { id: memberId, displayName: 'Journey member', role: 'member', joinedAt: '2026-08-23T15:00:00.000Z' },
  ];
  trip.createdByUserId = ownerId;
  trip.invitationRecords = [{ id: 'invitation-1', invitedByUserId: ownerId, status: 'accepted' }];
  state.entries.push({ id: 'expense-1', tripId: trip.id, merchant: 'Shared item', category: 'Other', amountCents: 100, paidByUserId: memberId });
  state.events.push({
    id: 'event-1', tripId: trip.id, sequence: 1, occurredAt: '2026-08-23T15:00:00.000Z', actorName: 'Journey owner',
    actorUserId: ownerId, action: 'member_joined', entityType: 'membership', entityId: memberId, summary: 'Accepted journey invitation',
    before: { ownerUserId: ownerId }, after: { userId: memberId }, previousEventId: '',
  });
  const workingState = structuredClone(state);

  const text = exportState(state);
  const exported = JSON.parse(text);
  assert.equal(exported.identityProtection, 'account-aliases-v1');
  assert.doesNotMatch(text, new RegExp(ownerId));
  assert.doesNotMatch(text, new RegExp(memberId));
  assert.deepEqual(exported.data.trips[0].memberRecords.map((record) => record.id), ['journeyer-1', 'journeyer-2']);
  assert.equal(exported.data.trips[0].createdByUserId, 'journeyer-1');
  assert.equal(exported.data.trips[0].invitationRecords[0].invitedByUserId, 'journeyer-1');
  assert.equal(exported.data.entries[0].paidByUserId, 'journeyer-2');
  assert.equal(exported.data.events[0].actorUserId, 'journeyer-1');
  assert.equal(exported.data.events[0].entityId, 'journeyer-2');
  assert.deepEqual(exported.data.events[0].before, { ownerUserId: 'journeyer-1' });
  assert.deepEqual(exported.data.events[0].after, { userId: 'journeyer-2' });
  assert.deepEqual(state, workingState);
  assert.deepEqual(importState(text), exported.data);
  delete globalThis.localStorage;
});
