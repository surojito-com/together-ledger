import { test, expect } from './browser-test.js';

// The owner's evening, Oct 7 at 20:14 in New York, when it was already Oct 8 in UTC (#336).
test.use({ timezoneId: 'America/New_York' });
const EVENING_IN_NEW_YORK = new Date('2026-10-08T00:14:00Z');

const user = { id: 'user-local-day', username: 'local-day', displayName: 'local-day', email: 'local-day@example.test', emailVerified: true };

test('"today" is the person\'s own day, and a journey can begin on a date still to come (#336, #358)', async ({ page }) => {
  await page.clock.setFixedTime(EVENING_IN_NEW_YORK);
  let journeys = [];
  let sent = null;
  const created = { id: 'journey-planned', name: 'The trip we are planning', location: '', startDate: '2027-06-01', startDateStatus: 'exact', endDate: null, endDateStatus: 'forever', budgetCents: 0, version: 1, role: 'owner', createdAt: EVENING_IN_NEW_YORK.toISOString(), updatedAt: EVENING_IN_NEW_YORK.toISOString() };
  await page.route('https://api.together-ledger.com/api/v1/session', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { user, csrfToken: 'csrf-test' } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys', (route) => {
    if (route.request().method() === 'POST') {
      sent = route.request().postDataJSON();
      journeys = [{ id: created.id }];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { journey: created } }) });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { journeys } }) });
  });
  await page.route(`https://api.together-ledger.com/api/v1/journeys/${created.id}/snapshot`, (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: {
      journey: created,
      members: [{ id: user.id, displayName: user.displayName, role: 'owner', joinedAt: created.createdAt }],
      invitations: [], expenses: [], moments: [], concerns: [], milestones: [], events: [], eventChainValid: true,
    } }),
  }));

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Account settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Journey settings' }).click();
  await page.locator('#sharing-create-journey-button').click();
  await expect(page.getByRole('heading', { name: 'Begin a shared journey' })).toBeVisible();

  const form = page.locator('#journey-form');
  const start = form.locator('[name="startDateStatus"]');
  await expect(start.locator('option:checked')).toHaveText('I know the date');
  await expect(start).toHaveValue('exact', { message: 'the stored value is still exact' });
  await expect(form.locator('[name="startDate"]')).toHaveValue('2026-10-07', { message: '8 pm on Oct 7 in New York is Oct 7, not the UTC day' });
  await expect(form.locator('#start-date-field')).toBeVisible();

  await form.locator('[name="name"]').fill('The trip we are planning');
  await form.locator('[name="startDate"]').fill('2027-06-01');
  await page.locator('#save-journey-button').click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent).toMatchObject({ startDateStatus: 'exact', startDate: '2027-06-01', endDateStatus: 'forever', endDate: null });
  await expect(page.locator('#journey-dialog')).not.toHaveAttribute('open', '');
});

test('a new moment starts on the person\'s own day, and a name of only spaces is caught at its field (#336, #354)', async ({ page }) => {
  await page.clock.setFixedTime(EVENING_IN_NEW_YORK);
  await page.goto('/');
  await page.getByRole('button', { name: /Begin your ledger/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Hold a moment' })).toBeVisible();

  const form = page.locator('#moment-form');
  await expect(form.locator('[name="occurredOn"]')).toHaveValue('2026-10-07');

  await form.locator('[name="title"]').fill('   ');
  await page.getByRole('button', { name: 'Hold this moment' }).click();
  await expect(page.locator('#status-banner-message')).toHaveText('Give this moment a short name.');
  await expect(form.locator('[name="title"]')).toBeFocused();
  await expect(page.locator('#moment-timeline .moment-card')).toHaveCount(0);

  await form.locator('[name="title"]').fill('We made room to listen');
  await page.getByRole('button', { name: 'Hold this moment' }).click();
  await expect(page.locator('#moment-timeline')).toContainText('We made room to listen');
  await expect(page.locator('#moment-timeline')).toContainText('Oct 7');
  // One moment is already on the ledger, so there is nothing more to see (the owner, on #337).
  await expect(page.locator('#toggle-moments-button')).toBeHidden();
});

test('"See all" appears only once the ledger is not showing every moment (#337)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Begin your ledger/ }).first().click();
  const form = page.locator('#moment-form');
  for (const [index, title] of ['First', 'Second', 'Third', 'Fourth'].entries()) {
    if (index > 0) await page.locator('[data-open-moment]:visible').first().click();
    await form.locator('[name="title"]').fill(`${title} moment`);
    await page.getByRole('button', { name: 'Hold this moment' }).click();
    await expect(page.locator('#moment-timeline')).toContainText(`${title} moment`);
    if (index < 3) await expect(page.locator('#toggle-moments-button')).toBeHidden();
  }
  await expect(page.locator('#moment-timeline .moment-card')).toHaveCount(3);
  await page.getByRole('button', { name: 'See all 4 moments', exact: true }).click();
  await expect(page.locator('#moment-timeline .moment-card')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Show recent', exact: true })).toBeVisible();
});
