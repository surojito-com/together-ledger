import { test, expect } from '@playwright/test';

// Adding a person is now held among the people already here (#169). These are the surfaces that
// decision is made on, and two of their properties are ethical rather than cosmetic: the product
// must not lean on how somebody answers, and a decline must not be dressed as a fault.

const owner = { id: 'consent-owner', username: 'owner', displayName: 'consent-owner', email: 'owner@example.test', emailVerified: true };

const members = [
  { id: 'consent-owner', displayName: 'consent-owner', role: 'owner', joinedAt: '2026-09-07T14:00:00.000Z' },
  { id: 'member-1', displayName: 'journeyer-1', role: 'member', joinedAt: '2026-09-07T15:00:00.000Z' },
  { id: 'member-2', displayName: 'journeyer-2', role: 'member', joinedAt: '2026-09-07T16:00:00.000Z' },
];

const base = {
  note: '', proposedByUserId: 'consent-owner', proposedByDisplayName: 'consent-owner', proposedByEmail: 'owner@example.test',
  proposedAt: '2026-09-01T09:00:00.000Z', expiresAt: '2026-10-01T09:00:00.000Z', closedAt: '2026-09-02T11:30:00.000Z',
  agreedCount: 1, declinedCount: 0, pendingCount: 2, askedCount: 3, viewerDecision: null, viewerMayDecide: false, decisions: [],
};

// Every state a proposal can reach, so none of them can quietly fall through to unstyled text.
const proposals = [
  {
    ...base, id: 'proposal-open', email: 'newcomer@example.test', note: 'My sister.', status: 'open',
    expiresAt: '2099-01-01T00:00:00.000Z', closedAt: null, viewerMayDecide: true,
    decisions: [
      { userId: 'member-1', displayName: 'journeyer-1', email: 'a@example.test', decision: 'agree', requestedAt: '2026-09-08T09:00:00.000Z', decidedAt: '2026-09-08T09:00:00.000Z' },
      { userId: owner.id, displayName: 'consent-owner', email: 'owner@example.test', decision: 'pending', requestedAt: '2026-09-08T09:00:00.000Z', decidedAt: null },
      { userId: 'member-2', displayName: 'journeyer-2', email: 'b@example.test', decision: 'decline', requestedAt: '2026-09-08T09:00:00.000Z', decidedAt: '2026-09-09T09:00:00.000Z' },
    ],
  },
  { ...base, id: 'p-agreed', email: 'a1@example.test', status: 'agreed' },
  { ...base, id: 'p-declined', email: 'a2@example.test', status: 'declined' },
  { ...base, id: 'p-withdrawn', email: 'a3@example.test', status: 'withdrawn' },
  { ...base, id: 'p-lapsed', email: 'a4@example.test', status: 'lapsed' },
];

const invitations = [
  { id: 'i1', email: 'i1@example.test', invitedByDisplayName: 'consent-owner', sentAt: '2026-09-05T09:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', status: 'pending' },
  { id: 'i2', email: 'i2@example.test', invitedByDisplayName: 'consent-owner', sentAt: '2026-09-05T09:00:00.000Z', expiresAt: '2026-09-06T09:00:00.000Z', status: 'accepted' },
  { id: 'i3', email: 'i3@example.test', invitedByDisplayName: 'consent-owner', sentAt: '2026-09-05T09:00:00.000Z', expiresAt: '2026-09-06T09:00:00.000Z', status: 'expired' },
  { id: 'i4', email: 'i4@example.test', invitedByDisplayName: 'consent-owner', sentAt: '2026-09-05T09:00:00.000Z', expiresAt: '2026-09-06T09:00:00.000Z', status: 'revoked' },
];

async function openJourneySettings(page) {
  await page.route('https://api.together-ledger.com/api/v1/session', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { user: owner, csrfToken: 'csrf-test' } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { journeys: [{ id: 'consent-journey' }] } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys/consent-journey/snapshot', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: {
      journey: { id: 'consent-journey', name: 'A journey held together', location: '', startDate: '', startDateStatus: 'unknown', endDate: '', endDateStatus: 'forever', budgetCents: 0, version: 1, role: 'owner', createdAt: '2026-09-07T14:00:00.000Z', updatedAt: '2026-09-08T09:00:00.000Z' },
      members, invitations, inviteProposals: proposals, expenses: [], moments: [], concerns: [], milestones: [], events: [], eventChainValid: true,
      capacity: { peopleHere: 3, openInvitations: 0, canInvite: true, mode: 'test-groups' },
    } }),
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Journey settings' }).click();
  await expect(page.locator('#invite-proposal-list')).toContainText('newcomer@example.test');
}

const roles = (page) => page.evaluate(() => {
  const read = (name) => { const probe = document.createElement('span'); probe.style.color = `var(${name})`; document.body.appendChild(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; };
  return { positive: read('--positive'), caution: read('--caution'), private: read('--private'), destructive: read('--destructive'), accent: read('--accent'), ink: read('--ink') };
});

const chips = (page) => page.evaluate(() => [...document.querySelectorAll('#invite-proposal-list .invitation-status, #invitation-list .invitation-status')]
  .map((element) => ({ label: element.textContent.trim(), state: element.className.replace('invitation-status', '').trim(), colour: getComputedStyle(element).color })));

test('a proposal tells its state through the roles that mean it, in every state it can reach', async ({ page }) => {
  await openJourneySettings(page);
  const role = await roles(page);
  const painted = await chips(page);

  // Five proposal states and two decision states used to fall through to plain ink, so Waiting
  // was the only coloured thing in the record and Agreed looked exactly like Declined.
  for (const chip of painted) {
    expect([role.positive, role.caution, role.private], `${chip.state} (“${chip.label}”) must carry a semantic role, not default text`)
      .toContain(chip.colour);
  }

  const byState = Object.fromEntries(painted.map((chip) => [chip.state, chip.colour]));
  expect(byState.open, 'a live proposal is waiting').toBe(role.caution);
  expect(byState.agreed, 'a settled yes').toBe(role.positive);
  expect(byState.agree, 'one person agreeing').toBe(role.positive);

  // A decline is somebody's considered answer about another person. Dressing it in the colour
  // reserved for what cannot be undone would make it read as an accusation.
  expect(byState.declined, 'declining is not a fault').not.toBe(role.destructive);
  expect(byState.decline, 'declining is not a fault').not.toBe(role.destructive);

  // Time running out must read as an expiry rather than a refusal, so lapsing sits in the same
  // receded tier as withdrawing rather than beside anything louder.
  expect(byState.lapsed, 'lapsing reads as expiry').toBe(role.private);
  expect(byState.withdrawn).toBe(role.private);
  expect(byState.declined).toBe(role.private);
});

test('the product does not lean on how a journeyer answers', async ({ page }) => {
  await openJourneySettings(page);

  const decision = await page.evaluate(() => {
    const find = (attribute) => document.querySelector(`#invite-proposal-list [data-${attribute}-proposal]`);
    const describe = (element) => { const style = getComputedStyle(element); const box = element.getBoundingClientRect();
      return { background: style.backgroundColor, color: style.color, height: Math.round(box.height), weight: style.fontWeight }; };
    return { agree: describe(find('agree')), decline: describe(find('decline')) };
  });

  // Agreeing carried a solid accent while declining was a transparent outline, which is the
  // product expressing a preference about a decision that is not its own.
  expect(decision.agree.background, 'agreeing must not be the visual default').toBe(decision.decline.background);
  expect(decision.agree.color).toBe(decision.decline.color);
  expect(decision.agree.height).toBe(decision.decline.height);
  expect(decision.agree.height, 'both remain full-sized targets').toBeGreaterThanOrEqual(44);
});
