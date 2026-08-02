import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeEntries,
  conversationPrompts,
  dateRange,
  demoState,
  groupDayByCategory,
  isValidState,
  normalizeEntry,
  summarize,
} from '../src/model.js';

test('synthetic demo state is valid and isolated to its active trip', () => {
  const state = demoState();
  assert.equal(isValidState(state), true);
  assert.equal(activeEntries(state).length, 5);
  assert.deepEqual(state.trips[0].members, ['Alex', 'Jordan']);
});

test('summary calculates totals, due costs, categories, payers, and budget', () => {
  const entries = activeEntries(demoState());
  const summary = summarize(entries, 120000);
  assert.equal(summary.totalCents, 87825);
  assert.equal(summary.dueCents, 16000);
  assert.equal(summary.budgetLeftCents, 32175);
  assert.equal(summary.byCategory.Restaurants, 12225);
  assert.equal(summary.byPayer.Alex, 25025);
});

test('date range includes every trip day', () => {
  const state = demoState();
  assert.deepEqual(dateRange(state.trips[0].startDate, state.trips[0].endDate, state.entries), [
    '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17',
  ]);
});

test('day drilldown groups entries by spending category', () => {
  const groups = groupDayByCategory(activeEntries(demoState()), '2026-08-16');
  assert.equal(groups.Activities.length, 1);
  assert.equal(groups.Restaurants.length, 1);
});

test('entry normalization uses integer cents and validates categories', () => {
  const entry = normalizeEntry({ merchant: 'Museum', category: 'Activities', amount: '19.95', occurredOn: '2026-08-15', paidBy: 'Alex', status: 'paid' }, 'demo-coast');
  assert.equal(entry.amountCents, 1995);
  assert.equal(entry.tripId, 'demo-coast');
  assert.throws(() => normalizeEntry({ ...entry, amount: '10', category: 'Invalid' }, 'demo-coast'), /valid category/);
});

test('conversation prompts frame money as a shared question', () => {
  const summary = summarize(activeEntries(demoState()), 120000);
  const prompts = conversationPrompts(summary);
  assert.equal(prompts.length, 3);
  assert.match(prompts.join(' '), /What|Which|Was/);
  assert.doesNotMatch(prompts.join(' '), /fault|blame|score/i);
});
