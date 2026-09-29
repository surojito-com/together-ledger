import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function beginBrowserLedger(page, { closeMoment = false } = {}) {
  await expect(page.getByRole('heading', { level: 1, name: 'Keep what matters, together.' })).toHaveCount(1);
  await page.getByRole('button', { name: /Begin your ledger/ }).first().click();
  await expect(page.locator('body')).toHaveAttribute('data-surface', 'ledger');
  await expect(page.getByRole('heading', { name: 'Hold a moment' })).toBeVisible();
  if (closeMoment) await page.getByRole('button', { name: 'Close', exact: true }).click();
}

test('the public welcome earns the first browser-only moment without making a privacy claim', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1, name: 'Keep what matters, together.' })).toBeVisible();
  await expect(page.locator('.ledger-preview')).toContainText('Three fictional moments, held between Maya and Theo');
  await expect(page.locator('.ledger-preview')).toContainText('Shared intentionally');
  await expect(page.locator('.welcome-boundary')).toContainText('Beginning here creates no account and uploads nothing.');
  await page.getByRole('link', { name: 'See how it works' }).click();
  await expect(page.getByRole('heading', { name: 'Not another place to post. A place to remember.' })).toBeVisible();

  const welcomeScan = await new AxeBuilder({ page }).include('#welcome').analyze();
  expect(welcomeScan.violations).toEqual([]);

  await beginBrowserLedger(page);
  await expect(page.getByRole('heading', { name: 'What can live here?' })).toBeVisible();
  await expect(page.locator('#moment-timeline')).toContainText('There are no examples here—only possibilities:');
  await expect(page.locator('#moment-timeline')).toContainText('Repair request');
  await expect(page.locator('#moment-timeline')).toContainText('Learned something');
  await expect(page.locator('#moment-timeline')).toContainText('Call me');
  await expect(page.locator('#moment-timeline')).toContainText('Called you');
  await expect(page.locator('.trip-bar')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Return-to conversations' })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'One question, if now is a good time.' })).toBeHidden();
  await expect(page.getByRole('button', { name: /See all \d+ moments/ })).toBeHidden();
  await expect(page.locator('body')).not.toContainText('Total trip cost');
  await expect(page.locator('body')).not.toContainText('Daily spending');

  await page.locator('#moment-form [name="kind"]').selectOption('heart-to-heart');
  await page.locator('#moment-form [name="occurredOn"]').fill('2026-08-17');
  await page.locator('#moment-form [name="title"]').fill('We made room to listen');
  await page.locator('#moment-form [name="detail"]').fill('We paused before trying to solve anything.');
  await page.locator('#moment-form [name="visibility"][value="share-later"]').check();
  await expect(page.locator('#moment-theme-options input')).toHaveCount(5);
  await page.getByLabel('Flexoki', { exact: true }).check();
  await expect(page.locator('#moment-theme-preview')).toHaveAttribute('data-moment-theme', 'flexoki');
  await page.locator('#moment-form [name="money"]').fill('19.95');
  await page.getByRole('button', { name: 'Hold this moment' }).click();

  await expect(page.locator('#moment-timeline')).toContainText('We made room to listen');
  await expect(page.locator('.trip-bar')).toBeVisible();
  await expect(page.locator('#moment-timeline')).toContainText('Share later');
  await expect(page.locator('#moment-timeline .moment-card[data-moment-theme="flexoki"]')).toContainText("Flexoki theme");
  await expect(page.locator('#moment-timeline')).toContainText('19.95 is held here as context, not a score.');
  await expect(page.locator('#moment-timeline')).toContainText('Practical money context');
  await expect(page.locator('#guidance')).toBeVisible();
  await expect(page.locator('#guidance')).not.toHaveAttribute('open', '');
  await page.locator('#guidance > summary').click();
  await page.getByRole('button', { name: 'End for today' }).click();
  await expect(page.locator('#guidance')).toBeHidden();

  await page.locator('#actor-select').selectOption('Your journeyer');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByLabel('Flexoki', { exact: true })).toBeChecked();
  await page.locator('#moment-form [name="detail"]').fill('We both returned to this moment with care.');
  await page.getByRole('button', { name: 'Save moment' }).click();
  await expect(page.locator('.moment-collaboration-badge')).toHaveText('Shaped by more than one journeyer');

  const accessibilityScan = await new AxeBuilder({ page }).include('main').analyze();
  expect(accessibilityScan.violations).toEqual([]);
  await page.reload();
  await expect(page.locator('#moment-timeline .moment-card[data-moment-theme="flexoki"]')).toContainText('We made room to listen');
});

test('the browser-only starter holds the requested everyday moment kinds', async ({ page }) => {
  await page.goto('/');
  await beginBrowserLedger(page);
  await page.locator('#moment-form [name="kind"]').selectOption('called-you');
  await page.locator('#moment-form [name="title"]').fill('I called when I said I would');
  await page.getByRole('button', { name: 'Hold this moment' }).click();

  await expect(page.locator('#moment-timeline')).toContainText('Called you');
  await expect(page.locator('#moment-timeline')).toContainText('I called when I said I would');
});

test('a browser-only moment can hold a first included place and paid additional places', async ({ page }) => {
  await page.goto('/');
  await beginBrowserLedger(page);
  await page.locator('#moment-form [name="title"]').fill('We stopped to watch the clouds');
  await page.locator('#manual-location').fill('Lookout Mountain');
  await page.getByRole('button', { name: 'Add place' }).click();
  await expect(page.locator('#moment-locations')).toContainText('Lookout Mountain');
  await expect(page.locator('#moment-locations')).toContainText('Included');
  await page.locator('#manual-location').fill('Golden, Colorado');
  await page.getByRole('button', { name: 'Add place' }).click();
  await expect(page.locator('#moment-locations')).toContainText('$1/month');
  await page.getByRole('button', { name: 'Hold this moment' }).click();
  await expect(page.locator('#moment-timeline')).toContainText('Lookout Mountain · Golden, Colorado');
});

test('the browser-only starter offers a named add-your-own moment', async ({ page }) => {
  await page.goto('/');
  await beginBrowserLedger(page, { closeMoment: true });

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
  await beginBrowserLedger(page);
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
  await expect(page.getByRole('button', { name: 'Account settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Journey settings' }).click();

  await expect(page.locator('#sharing-copy')).toHaveText('Your account is ready. Create a private journey to invite another journeyer.');
  await page.locator('#sharing-create-journey-button').click();
  await expect(page.getByRole('heading', { name: 'Begin a shared journey' })).toBeVisible();
});

test('a hosted journey can hold a private moment and deliberately share one later', async ({ page }) => {
  const owner = { id: 'visibility-owner', username: 'visibility-owner', displayName: 'visibility-owner', email: 'owner@example.test', emailVerified: true };
  const moments = [{
    id: 'moment-later', journeyId: 'journey-visibility', kind: 'memory', kindLabel: '', occurredOn: '2026-08-30', title: 'Ready when I choose', detail: '', visibility: 'share-later', moneyCents: null, moneyCurrency: '', createdByUserId: owner.id, createdBy: owner.displayName, updatedBy: owner.displayName, shapedByBoth: false, version: 1, createdAt: '2026-08-30T12:00:00.000Z', updatedAt: '2026-08-30T12:00:00.000Z',
  }];
  const mutationBodies = [];
  await page.route('https://api.together-ledger.com/api/v1/session', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { user: owner, csrfToken: 'csrf-test' } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { journeys: [{ id: 'journey-visibility' }] } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys/journey-visibility/snapshot', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: {
      journey: { id: 'journey-visibility', name: 'A private shared journey', location: '', startDate: '', startDateStatus: 'unknown', endDate: '', endDateStatus: 'forever', budgetCents: 0, version: 1, role: 'owner', createdAt: '2026-08-30T11:00:00.000Z', updatedAt: '2026-08-30T12:00:00.000Z' },
      members: [{ id: owner.id, displayName: owner.displayName, role: 'owner', joinedAt: '2026-08-30T11:00:00.000Z' }], invitations: [], expenses: [], moments, concerns: [], milestones: [],
      events: [{ id: 'event-1', sequence: 1, actorUserId: owner.id, action: 'journey_created', entityType: 'journey', entityId: 'journey-visibility', summary: 'Created journey', before: null, after: null, previousHash: '', eventHash: '', createdAt: '2026-08-30T11:00:00.000Z' }], eventChainValid: true,
    } }),
  }));
  await page.route(/\/api\/v1\/journeys\/journey-visibility\/moments(?:\/[^/]+)?$/, async (route) => {
    const body = route.request().postDataJSON();
    mutationBodies.push(body);
    if (route.request().method() === 'POST') {
      moments.push({ ...body, id: 'moment-private', journeyId: 'journey-visibility', createdByUserId: owner.id, createdBy: owner.displayName, updatedBy: owner.displayName, shapedByBoth: false, version: 1, createdAt: '2026-08-30T12:30:00.000Z', updatedAt: '2026-08-30T12:30:00.000Z' });
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ data: { moment: moments.at(-1) } }) });
      return;
    }
    const moment = moments.find((item) => item.id === 'moment-later');
    Object.assign(moment, body, { version: moment.version + 1 });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { moment } }) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Hold a moment/ }).first().click();
  await expect(page.locator('#moment-visibility-field')).toBeVisible();
  await expect(page.locator('#moment-visibility-help')).toContainText('Private stays with you');
  await page.locator('#moment-form [name="visibility"][value="private"]').check();
  await page.locator('#moment-form [name="title"]').fill('Mine until I decide');
  await page.getByRole('button', { name: 'Hold this moment' }).click();
  expect(mutationBodies[0].visibility).toBe('private');
  await expect(page.locator('.moment-card.private')).toContainText('Mine until I decide');

  await page.locator('.moment-card.share-later').getByRole('button', { name: 'Share now' }).click();
  // The consequence is stated, and the confirming button names the act rather than saying OK.
  await expect(page.locator('#consequence-dialog')).toBeVisible();
  await expect(page.locator('#consequence-dialog-consequence')).toContainText('including anyone who joins later');
  await expect(page.locator('#consequence-dialog-cancel')).toBeFocused();
  await page.locator('#consequence-dialog').getByRole('button', { name: 'Share this moment' }).click();
  await expect.poll(() => mutationBodies.at(-1)?.visibility).toBe('shared-now');
  await expect(page.locator('.moment-card.shared-now')).toContainText('Ready when I choose');
  await expect(page.getByRole('button', { name: 'Share now' })).toHaveCount(0);
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
  await expect(page.getByRole('button', { name: 'Account settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Journey settings' }).click();
  await expect(page.locator('#member-list')).toContainText('Created by journey-owner');
  await expect(page.locator('#invitation-list')).toContainText('Invitation sent to invited@example.test');
  await expect(page.locator('.invitation-status')).toHaveText('Pending');
  await expect(page.locator('#invite-form')).toContainText('Everyone already in this journey has to agree');
  await expect(page.locator('#invite-form')).toContainText('they learn nothing about the journey');
  await expect(page.locator('#invitation-list')).toContainText('Time left to join');

  invitationAccepted = true;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Account settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Journey settings' }).click();
  await expect(page.locator('#member-list')).toContainText('journey-member joined the journey');
  await expect(page.locator('.invitation-status')).toHaveText('Accepted');
});

test('Journey settings welcomes a group without exposing an internal ceiling', async ({ page }) => {
  let ownershipRequest = null;
  const owner = { id: 'group-owner', username: 'group-owner', displayName: 'group-owner', email: 'owner@example.test', emailVerified: true };
  const members = [
    { id: owner.id, displayName: owner.displayName, role: 'owner', joinedAt: '2026-09-07T14:00:00.000Z' },
    { id: 'group-two', displayName: 'second-person', role: 'member', joinedAt: '2026-09-07T15:00:00.000Z' },
    { id: 'group-three', displayName: 'third-person', role: 'member', joinedAt: '2026-09-07T16:00:00.000Z' },
  ];
  await page.route('https://api.together-ledger.com/api/v1/session', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { user: owner, csrfToken: 'csrf-test' } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { journeys: [{ id: 'group-journey' }] } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys/group-journey/snapshot', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: {
      journey: { id: 'group-journey', name: 'A wider circle', location: '', startDate: '', startDateStatus: 'unknown', endDate: '', endDateStatus: 'forever', budgetCents: 0, version: 1, role: 'owner', createdAt: '2026-09-07T14:00:00.000Z', updatedAt: '2026-09-07T16:00:00.000Z' },
      members, invitations: [], expenses: [], moments: [], concerns: [], milestones: [], events: [], eventChainValid: true,
      capacity: { peopleHere: 3, openInvitations: 0, canInvite: true, mode: 'test-groups' },
    } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys/group-journey/ownership', async (route) => {
    ownershipRequest = route.request().postDataJSON();
    await route.fulfill({ status: 204, body: '' });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Journey settings' }).click();
  await expect(page.locator('#sharing-copy')).toHaveText('3 people are here. There is room to add another person, and everybody here has to agree to them. Each person signs in separately.');
  await expect(page.locator('#invite-form')).toBeVisible();
  await expect(page.locator('#member-list')).toContainText('third-person joined the journey');
  await expect(page.getByRole('button', { name: 'Make owner' })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(2);
  await expect(page.locator('#sharing-settings')).not.toContainText(/99|seat|license/i);
  const accessibilityScan = await new AxeBuilder({ page }).include('#sharing-settings').analyze();
  expect(accessibilityScan.violations).toEqual([]);

  // Membership is where someone acts on another person, so its controls carry the same
  // target floor as the rest of the product rather than shrinking because they sit in a list.
  const undersized = await page.evaluate(() => [...document.querySelectorAll('#sharing-settings button, #sharing-settings input, #sharing-settings select')]
    .filter((element) => element.offsetParent !== null && element.getBoundingClientRect().height < 44)
    .map((element) => element.textContent.trim() || element.id || element.type));
  expect(undersized).toEqual([]);

  await page.locator('.journey-record-row').filter({ hasText: 'second-person' }).getByRole('button', { name: 'Make owner' }).click();
  await page.locator('#consequence-dialog').getByRole('button', { name: 'Transfer ownership' }).click();
  await expect.poll(() => ownershipRequest).toEqual({ userId: 'group-two' });
});

test('A proposal names who was asked, what they decided, and when', async ({ page }) => {
  let decisionRequest = null;
  const owner = { id: 'consent-owner', username: 'consent-owner', displayName: 'consent-owner', email: 'owner@example.test', emailVerified: true };
  const members = [
    { id: owner.id, displayName: 'consent-owner', role: 'owner', joinedAt: '2026-09-07T14:00:00.000Z' },
    { id: 'consent-two', displayName: 'second-person', role: 'member', joinedAt: '2026-09-07T15:00:00.000Z' },
    { id: 'consent-three', displayName: 'third-person', role: 'member', joinedAt: '2026-09-07T16:00:00.000Z' },
  ];
  const proposals = [
    {
      id: 'proposal-open', email: 'newcomer@example.test', note: 'My sister, who has been asking after you both.',
      proposedByUserId: 'consent-two', proposedByDisplayName: 'second-person', proposedByEmail: 'second@example.test',
      status: 'open', proposedAt: '2026-09-08T09:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', closedAt: null,
      agreedCount: 1, declinedCount: 0, pendingCount: 2, askedCount: 3, viewerDecision: null, viewerMayDecide: true,
      decisions: [
        { userId: 'consent-two', displayName: 'second-person', email: 'second@example.test', decision: 'agree', requestedAt: '2026-09-08T09:00:00.000Z', decidedAt: '2026-09-08T09:00:00.000Z' },
        { userId: owner.id, displayName: 'consent-owner', email: 'owner@example.test', decision: 'pending', requestedAt: '2026-09-08T09:00:00.000Z', decidedAt: null },
        { userId: 'consent-three', displayName: 'third-person', email: 'third@example.test', decision: 'pending', requestedAt: '2026-09-08T09:00:00.000Z', decidedAt: null },
      ],
    },
    {
      id: 'proposal-declined', email: 'earlier@example.test', note: '',
      proposedByUserId: owner.id, proposedByDisplayName: 'consent-owner', proposedByEmail: 'owner@example.test',
      status: 'declined', proposedAt: '2026-09-01T09:00:00.000Z', expiresAt: '2026-10-01T09:00:00.000Z', closedAt: '2026-09-02T11:30:00.000Z',
      agreedCount: 1, declinedCount: 1, pendingCount: 1, askedCount: 3, viewerDecision: 'agree', viewerMayDecide: false,
      decisions: [
        { userId: owner.id, displayName: 'consent-owner', email: 'owner@example.test', decision: 'agree', requestedAt: '2026-09-01T09:00:00.000Z', decidedAt: '2026-09-01T09:00:00.000Z' },
        { userId: 'consent-three', displayName: 'third-person', email: 'third@example.test', decision: 'decline', requestedAt: '2026-09-01T09:00:00.000Z', decidedAt: '2026-09-02T11:30:00.000Z' },
        { userId: 'consent-two', displayName: 'second-person', email: 'second@example.test', decision: 'pending', requestedAt: '2026-09-01T09:00:00.000Z', decidedAt: null },
      ],
    },
  ];
  await page.route('https://api.together-ledger.com/api/v1/session', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { user: owner, csrfToken: 'csrf-test' } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { journeys: [{ id: 'consent-journey' }] } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys/consent-journey/snapshot', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: {
      journey: { id: 'consent-journey', name: 'A journey held together', location: '', startDate: '', startDateStatus: 'unknown', endDate: '', endDateStatus: 'forever', budgetCents: 0, version: 1, role: 'owner', createdAt: '2026-09-07T14:00:00.000Z', updatedAt: '2026-09-08T09:00:00.000Z' },
      members, invitations: [], inviteProposals: proposals, expenses: [], moments: [], concerns: [], milestones: [], events: [], eventChainValid: true,
      capacity: { peopleHere: 3, openInvitations: 0, canInvite: true, mode: 'test-groups' },
    } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys/consent-journey/invite-proposals/proposal-open/decision', async (route) => {
    decisionRequest = route.request().postDataJSON();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { invitationSent: false } }) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Journey settings' }).click();
  const proposalList = page.locator('#invite-proposal-list');
  await expect(proposalList).toContainText('newcomer@example.test');
  await expect(proposalList).toContainText('Proposed by second-person');
  await expect(proposalList).toContainText('My sister, who has been asking after you both.');
  await expect(proposalList).toContainText('1 of 3 have agreed · 2 still to answer');
  await expect(proposalList).toContainText('Time left to answer');

  // The detail is folded away by default and holds the record, rather than the record being
  // reduced to a count that nobody can check.
  const record = proposalList.locator('details.proposal-detail').first();
  await expect(record).not.toHaveAttribute('open', '');
  await record.locator('summary').click();
  await expect(record).toContainText('second-person');
  await expect(record).toContainText('Asked');

  // A decline is attributed and dated, which is the point: it is somebody's decision.
  const declined = proposalList.locator('details.proposal-detail').nth(1);
  await declined.locator('summary').click();
  await expect(declined).toContainText('third-person');
  await expect(declined).toContainText('declined');

  // Agreeing is a consequence that is read before it is agreed to, like every other one here.
  await page.getByRole('button', { name: 'Agree to add them' }).click();
  await expect(page.locator('#consequence-dialog')).toContainText('every moment this journey has shared');
  await page.locator('#consequence-dialog-accept').click();
  await expect.poll(() => decisionRequest).toEqual({ decision: 'agree' });

  const accessibilityScan = await new AxeBuilder({ page }).include('#sharing-settings').analyze();
  expect(accessibilityScan.violations).toEqual([]);
});
