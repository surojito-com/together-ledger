import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMomentTheme } from '../src/moment-themes.js';
import {
  activeEntries,
  activeMoments,
  appendJourneyEvent,
  conversationPrompts,
  dateRange,
  demoState,
  groupDayByCategory,
  isRetiredSyntheticDemo,
  isValidState,
  migrateState,
  normalizeConcern,
  normalizeEntry,
  normalizeMoment,
  normalizeTrip,
  remainingLabel,
  summarize,
} from '../src/model.js';

test('a fresh shared space is valid and begins without invented records', () => {
  const state = demoState();
  assert.equal(isValidState(state), true);
  assert.equal(activeEntries(state).length, 0);
  assert.equal(activeMoments(state).length, 0);
  assert.deepEqual(state.trips[0].members, ['You', 'Your journeyer']);
});

test('only the untouched retired sample is recognized for replacement', () => {
  const sample = {
    activeTripId: 'demo-coast',
    trips: [{ id: 'demo-coast', name: 'Coastal Weekend' }],
    entries: [{ id: 'demo-1' }, { id: 'demo-2' }, { id: 'demo-3' }],
    moments: [{ id: 'moment-1' }, { id: 'moment-2' }, { id: 'moment-3' }, { id: 'practical-demo-1' }, { id: 'practical-demo-2' }, { id: 'practical-demo-3' }],
    concerns: [{ id: 'thread-1' }],
    events: [{ id: 'demo-event-1', source: 'synthetic-demo' }],
  };
  assert.equal(isRetiredSyntheticDemo(sample), true);
  assert.equal(isRetiredSyntheticDemo({ ...sample, moments: [...sample.moments, { id: 'a-real-moment' }] }), false);
});

test('summary calculates totals, due costs, categories, payers, and budget', () => {
  const entries = [normalizeEntry({ merchant: 'Museum', category: 'Activities', amount: '19.95', occurredOn: '2026-08-15', paidBy: 'You', status: 'paid' }, 'first-shared-space')];
  const summary = summarize(entries, 120000);
  assert.equal(summary.totalCents, 1995);
  assert.equal(summary.dueCents, 0);
  assert.equal(summary.budgetLeftCents, 118005);
  assert.equal(summary.byCategory.Activities, 1995);
  assert.equal(summary.byPayer.You, 1995);
});

test('date range includes every trip day', () => {
  const state = demoState();
  assert.deepEqual(dateRange(state.trips[0].startDate, state.trips[0].endDate, state.entries), [
    '2026-01-01',
  ]);
});

test('day drilldown groups existing practical records by category', () => {
  const entry = normalizeEntry({ merchant: 'Museum', category: 'Activities', amount: '19.95', occurredOn: '2026-08-15', paidBy: 'You', status: 'paid' }, 'first-shared-space');
  const groups = groupDayByCategory([entry], '2026-08-15');
  assert.equal(groups.Activities.length, 1);
});

test('entry normalization uses integer cents and validates categories', () => {
  const entry = normalizeEntry({ merchant: 'Museum', category: 'Activities', amount: '19.95', occurredOn: '2026-08-15', paidBy: 'Alex', status: 'paid' }, 'demo-coast');
  assert.equal(entry.amountCents, 1995);
  assert.equal(entry.tripId, 'demo-coast');
  assert.throws(() => normalizeEntry({ ...entry, amount: '10', category: 'Invalid' }, 'demo-coast'), /valid category/);
});

test('conversation prompts make room for a shared check-in without scoring', () => {
  const summary = summarize(activeEntries(demoState()), 120000);
  const prompts = conversationPrompts(summary);
  assert.equal(prompts.length, 5);
  assert.match(prompts.join(' '), /What|Which|Is/);
  assert.doesNotMatch(prompts.join(' '), /fault|blame|score/i);
});

test('schema version 1 migrates losslessly into multiple-journey state', () => {
  const current = demoState();
  current.entries.push(normalizeEntry({ merchant: 'Museum', category: 'Activities', amount: '19.95', occurredOn: '2026-08-15', paidBy: 'You', status: 'paid' }, current.activeTripId));
  const legacy = {
    schemaVersion: 1,
    activeTripId: current.activeTripId,
    trips: current.trips.map(({ milestones, archivedAt, ...trip }) => trip),
    entries: current.entries.map((entry) => ({ ...entry })),
  };
  const migrated = migrateState(legacy);
  assert.equal(migrated.schemaVersion, 6);
  assert.equal(migrated.preferences.onboardingComplete, false);
  assert.deepEqual(migrated.events, []);
  assert.deepEqual(migrated.concerns, []);
  assert.deepEqual(migrated.entries, legacy.entries);
  assert.equal(migrated.moments.length, legacy.entries.length);
  assert.equal(migrated.moments[0].kind, 'practical-matter');
  assert.equal(migrated.moments[0].moneyCents, legacy.entries[0].amountCents);
  assert.deepEqual(migrated.moments[0].locations, []);
  assert.deepEqual(migrated.trips[0].members, legacy.trips[0].members);
  assert.deepEqual(migrated.trips[0].milestones, {
    reviewedPicture: false,
    chosePrompt: false,
    agreedNextAction: false,
  });
});

test('moments keep optional money as context and require an honest visibility choice', () => {
  const state = demoState();
  const moment = normalizeMoment({
    kind: 'repair-request',
    title: 'Return to the rushed goodbye',
    detail: 'Could we try again with ten quiet minutes?',
    occurredOn: '2026-08-16',
    visibility: 'share-later',
    theme: 'flexoki',
    money: '12.50',
  }, state.activeTripId);
  assert.equal(moment.moneyCents, 1250);
  assert.equal(moment.visibility, 'share-later');
  assert.equal(moment.theme, 'flexoki');
  assert.equal(normalizeMoment({ ...moment, theme: 'retired-theme' }, state.activeTripId, moment).theme, '');
  assert.throws(() => normalizeMoment({ ...moment, visibility: 'everyone' }, state.activeTripId), /who can see/);
});

test('moments hold an optional first place and additional paid places without weakening validation', () => {
  const state = demoState();
  const moment = normalizeMoment({
    kind: 'memory', title: 'We sat together after the concert', detail: '', occurredOn: '2026-09-10', visibility: 'shared-now', money: '',
    locations: [
      { label: 'Red Rocks Amphitheatre' },
      { label: 'The overlook', latitude: 39.665, longitude: -105.205, accuracyMeters: 28 },
    ],
  }, state.activeTripId);
  assert.equal(moment.locations.length, 2);
  assert.equal(moment.locations[0].label, 'Red Rocks Amphitheatre');
  assert.equal(isValidState({ ...state, moments: [moment] }), true);
  assert.throws(() => normalizeMoment({ ...moment, locations: [{ label: '', latitude: 200 }] }, state.activeTripId), /location/);
});

test('a browser-only journey can name a moment outside the preset list', () => {
  const moment = normalizeMoment({ kind: 'other', kindLabel: 'A small win', title: 'We paused before replying', detail: '', occurredOn: '2026-08-16', visibility: 'shared-now', money: '' }, demoState().activeTripId);
  assert.equal(moment.kindLabel, 'A small win');
  assert.equal(moment.label, 'A small win');
  assert.throws(() => normalizeMoment({ ...moment, kindLabel: '' }, demoState().activeTripId), /short name/);
});

test('requested shared-journey moments are valid browser-only records', () => {
  for (const kind of ['learned-something', 'call-me', 'called-you']) {
    const moment = normalizeMoment({ kind, title: 'A small thing worth holding', detail: '', occurredOn: '2026-08-25', visibility: 'shared-now', money: '' }, demoState().activeTripId);
    assert.equal(moment.kind, kind);
  }
});

test('journey normalization requires two people and preserves trip boundaries', () => {
  const trip = normalizeTrip({
    name: 'Mountain Weekend',
    location: 'Asheville, North Carolina',
    startDate: '2026-09-04',
    endDate: '2026-09-07',
    budget: '950.25',
    memberOne: 'Taylor',
    memberTwo: 'Morgan',
  });
  assert.match(trip.id, /^trip-/);
  assert.equal(trip.budgetCents, 95025);
  assert.deepEqual(trip.members, ['Taylor', 'Morgan']);
  assert.throws(() => normalizeTrip({ ...trip, budget: '10', memberOne: 'Taylor', memberTwo: '' }), /both people/);
  assert.throws(() => normalizeTrip({ ...trip, budget: '10', memberOne: 'Taylor', memberTwo: 'taylor' }), /distinct name/);
});

test('active entries switch without mixing journeys', () => {
  const state = demoState();
  const second = normalizeTrip({ name: 'City Break', location: 'Chicago', startDate: '2026-10-01', endDate: '2026-10-03', budget: '400', memberOne: 'Alex', memberTwo: 'Jordan' });
  state.trips.push(second);
  state.entries.push(normalizeEntry({ merchant: 'Museum', category: 'Activities', amount: '25', occurredOn: '2026-10-02', paidBy: 'Jordan', status: 'paid' }, second.id));
  state.activeTripId = second.id;
  assert.equal(isValidState(state), true);
  assert.equal(activeEntries(state).length, 1);
  assert.equal(activeEntries(state)[0].merchant, 'Museum');
});

test('journey events are append-only, attributable, and sequential per journey', () => {
  const state = demoState();
  const event = appendJourneyEvent(state, {
    tripId: state.activeTripId,
    actorName: 'Jordan',
    action: 'budget_updated',
    entityType: 'journey',
    entityId: state.activeTripId,
    summary: 'Changed the journey budget',
    before: { budgetCents: 120000 },
    after: { budgetCents: 130000 },
    occurredAt: '2026-08-02T07:06:00.000Z',
  });
  assert.equal(event.sequence, 1);
  assert.equal(event.previousEventId, '');
  assert.equal(event.actorName, 'Jordan');
  assert.deepEqual(event.before, { budgetCents: 120000 });
  assert.equal(isValidState(state), true);
  state.events[0].previousEventId = 'wrong-event';
  assert.equal(isValidState(state), false);
});

test('concerns have an explicit lifecycle separate from private check-in prompts', () => {
  const state = demoState();
  const concern = normalizeConcern({ title: 'Unexpected hotel deposit', detail: 'Confirm whether it is refundable.', status: 'open' }, state.activeTripId, 'Alex');
  assert.equal(concern.status, 'open');
  assert.equal(concern.createdBy, 'Alex');
  const resolved = normalizeConcern({ ...concern, status: 'resolved' }, state.activeTripId, 'Jordan', concern);
  assert.equal(resolved.id, concern.id);
  assert.equal(resolved.createdBy, 'Alex');
  assert.equal(resolved.updatedBy, 'Jordan');
});

test('a moment saved with a retired treatment keeps the nearest surviving one', () => {
  // The stored-state validator requires normalize(theme) === theme, so this mapping has to
  // be idempotent or every existing moment carrying a retired treatment would fail to load.
  assert.equal(normalizeMomentTheme('rose-pine'), 'dark');
  assert.equal(normalizeMomentTheme('tokyo-night-day'), 'light');
  assert.equal(normalizeMomentTheme(normalizeMomentTheme('rose-pine')), 'dark');
  assert.equal(normalizeMomentTheme('flexoki'), 'flexoki');
  assert.equal(normalizeMomentTheme('a-theme-that-never-existed'), '');
  assert.equal(normalizeMomentTheme(''), '');
});

test('a countdown says what is left in the units that are left, and stops at nothing', () => {
  const now = Date.parse('2026-09-18T12:00:00.000Z');
  assert.equal(remainingLabel('2026-10-18T12:00:00.000Z', now), '30d 00h 00m left');
  assert.equal(remainingLabel('2026-09-24T16:12:00.000Z', now), '6d 04h 12m left');
  // A short-lived invitation is measured in the units it actually has, not padded out with days.
  assert.equal(remainingLabel('2026-09-18T12:29:00.000Z', now), '29m left');
  assert.equal(remainingLabel('2026-09-18T16:12:00.000Z', now), '4h 12m left');
  assert.equal(remainingLabel('2026-09-18T12:00:30.000Z', now), 'Less than a minute left');
  // Time already gone is said plainly rather than counted downwards past zero.
  assert.equal(remainingLabel('2026-09-18T11:59:00.000Z', now), 'No time left');
  assert.equal(remainingLabel('', now), 'No end time recorded');
  assert.equal(remainingLabel('not a date', now), 'No end time recorded');
});
