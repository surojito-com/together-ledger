import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function skipOnboarding(page) {
  if (await page.locator('#onboarding-dialog').getAttribute('open') !== null) await page.locator('#skip-onboarding').click();
}

test('the first browser-only screen begins empty and explains what can be held', async ({ page }) => {
  await page.goto('/');
  await skipOnboarding(page);

  await expect(page.getByRole('heading', { name: 'What can live here?' })).toBeVisible();
  await expect(page.locator('#moment-timeline')).toContainText('There are no examples here—only possibilities:');
  await expect(page.locator('#moment-timeline')).toContainText('Repair request');
  await expect(page.locator('.trip-bar')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Begin' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Return-to conversations' })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'One question, if now is a good time.' })).toBeHidden();
  await expect(page.getByRole('button', { name: /See all \d+ moments/ })).toBeHidden();
  await expect(page.locator('body')).not.toContainText('Total trip cost');
  await expect(page.locator('body')).not.toContainText('Daily spending');

  await page.getByRole('button', { name: 'Begin' }).click();
  await page.locator('#moment-form [name="kind"]').selectOption('heart-to-heart');
  await page.locator('#moment-form [name="occurredOn"]').fill('2026-08-17');
  await page.locator('#moment-form [name="title"]').fill('We made room to listen');
  await page.locator('#moment-form [name="detail"]').fill('We paused before trying to solve anything.');
  await page.locator('#moment-form [name="visibility"][value="share-later"]').check();
  await page.locator('#moment-form [name="money"]').fill('19.95');
  await page.getByRole('button', { name: 'Hold this moment' }).click();

  await expect(page.locator('#moment-timeline')).toContainText('We made room to listen');
  await expect(page.locator('.trip-bar')).toBeVisible();
  await expect(page.locator('#moment-timeline')).toContainText('share later');
  await expect(page.locator('#moment-timeline')).toContainText('19.95 is held here as context, not a score.');
  await expect(page.locator('#moment-timeline')).toContainText('Practical money context');
  await expect(page.locator('#guidance')).toBeVisible();
  await expect(page.locator('#guidance')).not.toHaveAttribute('open', '');
  await page.locator('#guidance > summary').click();
  await page.getByRole('button', { name: 'End for today' }).click();
  await expect(page.locator('#guidance')).toBeHidden();

  await page.locator('#actor-select').selectOption('Your journeyer');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#moment-form [name="detail"]').fill('We both returned to this moment with care.');
  await page.getByRole('button', { name: 'Save moment' }).click();
  await expect(page.locator('.moment-collaboration-badge')).toHaveText('Shaped by both journeyers');

  const accessibilityScan = await new AxeBuilder({ page }).include('main').analyze();
  expect(accessibilityScan.violations).toEqual([]);
});

test('the browser-only starter offers a named add-your-own moment', async ({ page }) => {
  await page.goto('/');
  await skipOnboarding(page);

  await page.getByRole('button', { name: /Add your own moment/ }).click();
  await expect(page.locator('#moment-kind-label-field')).toBeVisible();
  await page.locator('#moment-form [name="kindLabel"]').fill('A small win');
  await page.locator('#moment-form [name="title"]').fill('We paused before replying');
  await page.getByRole('button', { name: 'Hold this moment' }).click();

  await expect(page.locator('#moment-timeline')).toContainText('A small win');
  await expect(page.locator('#moment-timeline')).toContainText('We paused before replying');
});

test('a selected practical-context currency is shown without inventing one', async ({ page }) => {
  await page.goto('/');
  await skipOnboarding(page);

  await page.getByRole('button', { name: 'Begin' }).click();
  await page.locator('#moment-form [name="title"]').fill('A practical promise');
  await page.locator('#moment-form [name="money"]').fill('2.50');
  await page.locator('#moment-form [name="moneyCurrency"]').selectOption('EUR');
  await page.getByRole('button', { name: 'Hold this moment' }).click();

  await expect(page.locator('#moment-timeline')).toContainText('€2.50 is held here as context, not a score.');
});

test('a verified account without a journey can begin one from Journey settings', async ({ page }) => {
  await page.route('https://api.together-ledger.com/api/v1/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: { user: { id: 'user-1', username: 'new-journeyer', displayName: 'new-journeyer', email: 'journeyer@example.test', emailVerified: true }, csrfToken: 'csrf-test' } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: { journeys: [] } }),
  }));

  await page.goto('/');
  await skipOnboarding(page);
  await expect(page.getByRole('button', { name: 'Account settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Journey settings' }).click();

  await expect(page.locator('#sharing-copy')).toHaveText('Your account is ready. Create a private journey to invite another journeyer.');
  await page.locator('#sharing-create-journey-button').click();
  await expect(page.getByRole('heading', { name: 'Begin a shared journey' })).toBeVisible();
});

test('Journey settings keeps creation, joining, and invitation history visible', async ({ page }) => {
  let invitationAccepted = false;
  const owner = { id: 'user-owner', username: 'journey-owner', displayName: 'journey-owner', email: 'owner@example.test', emailVerified: true };
  const member = { id: 'user-member', displayName: 'journey-member', role: 'member', joinedAt: '2026-08-23T15:30:00.000Z' };
  await page.route('https://api.together-ledger.com/api/v1/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: { user: owner, csrfToken: 'csrf-test' } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: { journeys: [{ id: 'journey-1' }] } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys/journey-1/snapshot', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: {
      journey: { id: 'journey-1', name: 'A careful beginning', location: '', startDate: '', startDateStatus: 'unknown', endDate: '', endDateStatus: 'forever', budgetCents: 0, version: 1, role: 'owner', createdAt: '2026-08-23T14:00:00.000Z', updatedAt: '2026-08-23T15:30:00.000Z' },
      members: [{ id: owner.id, displayName: owner.displayName, role: 'owner', joinedAt: '2026-08-23T14:00:00.000Z' }, ...(invitationAccepted ? [member] : [])],
      invitations: [{ id: 'invitation-1', email: 'invited@example.test', invitedByUserId: owner.id, invitedByDisplayName: owner.displayName, status: invitationAccepted ? 'accepted' : 'pending', sentAt: '2026-08-23T15:00:00.000Z', expiresAt: '2026-08-24T15:00:00.000Z', acceptedAt: invitationAccepted ? member.joinedAt : null, revokedAt: null }],
      expenses: [], moments: [], concerns: [], milestones: [],
      events: [{ id: 'event-1', sequence: 1, actorUserId: owner.id, action: 'journey_created', entityType: 'journey', entityId: 'journey-1', summary: 'Created journey', before: null, after: null, previousHash: '', eventHash: '', createdAt: '2026-08-23T14:00:00.000Z' }],
      eventChainValid: true,
    } }),
  }));

  await page.goto('/');
  await skipOnboarding(page);
  await expect(page.getByRole('button', { name: 'Account settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Journey settings' }).click();
  await expect(page.locator('#member-list')).toContainText('Created by journey-owner');
  await expect(page.locator('#invitation-list')).toContainText('Invitation sent to invited@example.test');
  await expect(page.locator('.invitation-status')).toHaveText('Pending');

  invitationAccepted = true;
  await page.reload();
  await skipOnboarding(page);
  await expect(page.getByRole('button', { name: 'Account settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Journey settings' }).click();
  await expect(page.locator('#member-list')).toContainText('journey-member joined the journey');
  await expect(page.locator('.invitation-status')).toHaveText('Accepted');
});
