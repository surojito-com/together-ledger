import test from 'node:test';
import assert from 'node:assert/strict';
import { isStale, MAX_RECONCILIATION_AGE_MS } from '../scripts/check-stripe-reconciliation-freshness.mjs';

test('reconciliation freshness treats a missing run as stale', () => {
  assert.equal(isStale(null), true);
  assert.equal(isStale(undefined), true);
});

test('reconciliation freshness holds for eight hours and no longer', () => {
  const now = new Date('2026-09-14T12:00:00.000Z');
  const justUnderThreshold = new Date(now.getTime() - MAX_RECONCILIATION_AGE_MS + 1000);
  const exactlyAtThreshold = new Date(now.getTime() - MAX_RECONCILIATION_AGE_MS);
  const justOverThreshold = new Date(now.getTime() - MAX_RECONCILIATION_AGE_MS - 1000);
  assert.equal(isStale(justUnderThreshold, now), false);
  assert.equal(isStale(exactlyAtThreshold, now), false);
  assert.equal(isStale(justOverThreshold, now), true);
});

test('reconciliation freshness accepts a database-style timestamp string', () => {
  const now = new Date('2026-09-14T12:00:00.000Z');
  assert.equal(isStale('2026-09-14T05:00:00.000Z', now), false);
  assert.equal(isStale('2026-09-14T03:00:00.000Z', now), true);
});
