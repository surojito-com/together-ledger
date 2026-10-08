import { test, expect } from './browser-test.js';
import AxeBuilder from '@axe-core/playwright';

// #349: History's intro leads to "How to read your history", which explains every part of it.
// The words themselves are checked against the server in tests/history-guide.test.js; this is
// that a person can reach them, and that a moment's places read as places.

const owner = { id: 'guide-owner', username: 'guide-owner', displayName: 'guide-owner', email: 'owner@example.test', emailVerified: true };
const place = { label: 'Harbour', latitude: 38.7, longitude: -9.1, accuracyMeters: 12 };

async function hostedJourney(page) {
  await page.route('https://api.together-ledger.com/api/v1/session', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { user: owner, csrfToken: 'csrf-test' } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { journeys: [{ id: 'journey-guide' }] } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys/journey-guide/snapshot', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: {
      journey: { id: 'journey-guide', name: 'Ours', location: '', startDate: '', startDateStatus: 'unknown', endDate: '', endDateStatus: 'forever', budgetCents: 0, version: 1, role: 'owner', createdAt: '2026-08-30T11:00:00.000Z', updatedAt: '2026-08-30T11:00:00.000Z' },
      members: [{ id: owner.id, displayName: owner.displayName, role: 'owner', joinedAt: '2026-08-30T11:00:00.000Z' }], invitations: [], expenses: [], moments: [], concerns: [], milestones: [],
      events: [
        { id: 'event-1', sequence: 1, actorUserId: owner.id, action: 'journey_created', entityType: 'journey', entityId: 'journey-guide', summary: 'Created journey: Ours', before: null, after: null, previousHash: '0'.repeat(64), eventHash: 'a'.repeat(64), createdAt: '2026-08-30T11:00:00.000Z' },
        { id: 'event-2', sequence: 2, actorUserId: owner.id, action: 'moment_added', entityType: 'moment', entityId: 'moment-1', summary: 'Held memory: The harbour', before: null, after: { title: 'The harbour', locations: [place] }, previousHash: 'a'.repeat(64), eventHash: 'b'.repeat(64), createdAt: '2026-08-30T12:00:00.000Z' },
      ],
      eventChainValid: true,
    } }),
  }));
}

test('History\'s intro leads to how to read it, and a moment\'s places read as places', async ({ page }) => {
  await hostedJourney(page);
  await page.goto('/');
  await page.locator('#event-manager-button').click();
  const dialog = page.locator('#event-dialog');
  await expect(dialog).toBeVisible();

  await dialog.locator('.event-row').filter({ hasText: 'Held memory: The harbour' }).locator('summary').click();
  await expect(dialog.locator('.event-row dl div').filter({ has: page.locator('dt', { hasText: /^locations$/ }) }).locator('dd')).toHaveText(`none → ${JSON.stringify(place)}`);
  await expect(dialog).not.toContainText('[object Object]');

  await dialog.getByRole('button', { name: 'How to read your history' }).click();
  const guide = dialog.locator('#history-guide');
  await expect(guide).toBeFocused();
  await expect(guide.getByRole('heading', { level: 3, name: 'How to read your history' })).toBeVisible();
  for (const heading of ['What an entry shows', 'What the hash, the previous entry and the chain prove', 'Server-authoritative and account-attributed', 'Tombstones: what’s kept after something is deleted', 'Why one action can show as two entries', 'Times inside entries are in UTC', 'Every kind of entry', 'What each value means', 'Every part of an entry']) {
    await expect(guide.getByRole('heading', { level: 4, name: heading })).toHaveCount(1);
  }
  await expect(guide.locator('.history-guide-kind').filter({ hasText: 'paid_room_moved_in' })).toContainText('Paid room moved here from another journey');
  const scan = await new AxeBuilder({ page }).include('#event-dialog').analyze();
  expect(scan.violations).toEqual([]);
});

test('a browser-only journey, whose history this browser keeps, is not sent to the server\'s guide', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Begin your ledger/ }).first().click();
  await page.locator('#moment-form [name="title"]').fill('Only here');
  await page.getByRole('button', { name: 'Hold this moment' }).click();
  await page.locator('#event-manager-button').click();
  await expect(page.locator('#event-dialog')).toBeVisible();
  await expect(page.locator('#history-guide-link')).toBeHidden();
  await expect(page.locator('#history-guide')).toBeHidden();
});
