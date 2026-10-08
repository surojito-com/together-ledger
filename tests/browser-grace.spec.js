import { test, expect } from './browser-test.js';
import AxeBuilder from '@axe-core/playwright';

// A journey waiting on a payment (the Book, 4.7): everyone in it is told, in the caution role,
// the payer can ask for another week, and the owner sees the resting order the server saved.

const API = 'https://api.together-ledger.com/api/v1';
const sam = { id: 'grace-sam', displayName: 'Sam' };
const alex = { id: 'grace-alex', displayName: 'Alex' };
const bo = { id: 'grace-bo', displayName: 'Bo' };
const members = [
  { ...sam, role: 'owner', joinedAt: '2026-09-07T14:00:00.000Z' },
  { ...alex, role: 'member', joinedAt: '2026-09-07T15:00:00.000Z' },
  { ...bo, role: 'member', joinedAt: '2026-09-07T16:00:00.000Z' },
];
const grace = {
  active: true, endsAt: '2026-10-13T12:00:00.000Z', daysLeft: 5, payer: sam, calendarYear: 2026,
  requestsUsed: 2, requestsPerYear: 7, requestDays: 7, canRequest: true, keepAdding: [sam, alex],
};

async function openJourney(page, viewer, { role, capacity }) {
  const requests = { grace: 0, restOrder: null };
  await page.route(`${API}/session`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: { user: { id: viewer.id, username: viewer.id, displayName: viewer.displayName, email: `${viewer.id}@example.test`, emailVerified: true }, csrfToken: 'csrf-test' } }),
  }));
  await page.route(`${API}/journeys`, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { journeys: [{ id: 'grace-journey' }] } }) }));
  await page.route(`${API}/journeys/grace-journey/snapshot`, (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: {
      journey: { id: 'grace-journey', name: 'A journey waiting on a payment', location: '', startDate: '', startDateStatus: 'unknown', endDate: '', endDateStatus: 'forever', budgetCents: 0, version: 1, role, createdAt: '2026-09-07T14:00:00.000Z', updatedAt: '2026-09-08T09:00:00.000Z' },
      members, invitations: [], inviteProposals: [], expenses: [], moments: [], concerns: [], milestones: [], events: [], eventChainValid: true,
      capacity: { peopleHere: 3, openInvitations: 0, canInvite: false, mode: 'billing', restingMemberIds: [], grace, ...capacity },
    } }),
  }));
  await page.route(`${API}/journeys/grace-journey/billing`, (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { enabled: false, portalEnabled: false, environment: 'test', offers: [], entitlement: null, subscription: null, invoices: [] } }),
  }));
  await page.route(`${API}/journeys/grace-journey/grace-requests`, async (route) => {
    requests.grace += 1;
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ data: { capacity: {} } }) });
  });
  await page.route(`${API}/journeys/grace-journey/unpaid-capacity`, async (route) => {
    requests.restOrder = route.request().postDataJSON();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { capacity: {} } }) });
  });
  await page.goto('/');
  return requests;
}

const role = (page, name) => page.evaluate((property) => {
  const probe = document.createElement('span');
  probe.style.color = `var(${property})`;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}, name);

test('everyone in a journey in grace is told who pays and who can still add, in the caution role', async ({ page }) => {
  await openJourney(page, bo, { role: 'member', capacity: {} });
  const banner = page.locator('#grace-banner');
  await expect(banner).toBeVisible();
  await expect(page.locator('#grace-banner-message')).toHaveText("This journey is waiting on a payment from Sam. 5 days left · 2 of 7 extra weeks used this year. If it isn't paid, only Sam and Alex can add new moments. Everyone else can still see everything, and nothing is lost. Paying again brings everyone back.");
  // Only the payer is offered the ask.
  await expect(page.locator('#grace-request-button')).toBeHidden();

  // Waiting on a payment is not a failure: the edge and the glyph are the caution role.
  const edge = await banner.evaluate((element) => getComputedStyle(element).borderLeftColor);
  expect(edge).toBe(await role(page, '--caution'));
  expect(edge).not.toBe(await role(page, '--destructive'));
  expect(await page.locator('.grace-banner-glyph').evaluate((element) => getComputedStyle(element).color)).toBe(await role(page, '--caution'));
  const scan = await new AxeBuilder({ page }).include('#grace-banner').analyze();
  expect(scan.violations).toEqual([]);
});

test('the payer asks for another week from the banner', async ({ page }) => {
  const requests = await openJourney(page, sam, { role: 'owner', capacity: { restOrder: [bo.id, alex.id] } });
  await expect(page.locator('#grace-banner-message')).toContainText('waiting on a payment from you.');
  await expect(page.locator('#grace-banner-message')).toContainText('only you and Alex can add new moments.');
  const ask = page.getByRole('button', { name: 'Ask for 7 more days' });
  await expect(ask).toBeVisible();
  expect((await ask.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await ask.click();
  await expect.poll(() => requests.grace).toBe(1);
});

test('the owner sees the saved resting order, the person who keeps adding, and no choice to pause', async ({ page }) => {
  const requests = await openJourney(page, sam, { role: 'owner', capacity: { restOrder: [bo.id, alex.id] } });
  await page.getByRole('button', { name: 'Journey settings' }).click();
  const section = page.locator('#unpaid-capacity-rest');
  await expect(section).toBeVisible();
  await expect(section.getByRole('heading', { name: 'If the payment lapses' })).toBeVisible();
  await expect(section.locator('input[type="radio"]')).toHaveCount(0);
  await expect(section).not.toContainText(/pause/i);
  // The server's order, not the order people joined in (#281): Bo joined last but is listed first.
  const rows = section.locator('.journey-record-row');
  await expect(rows.nth(0)).toContainText('Bo');
  await expect(rows.nth(1)).toContainText('Alex');
  await expect(rows.nth(1)).toContainText('Keeps adding with you');
  await rows.nth(1).getByRole('button', { name: 'Rest earlier' }).click();
  await expect.poll(() => requests.restOrder).toEqual({ restOrder: [alex.id, bo.id] });
});
