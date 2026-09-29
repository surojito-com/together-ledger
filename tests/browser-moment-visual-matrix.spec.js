import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const owner = { id: 'visual-owner', username: 'visual-owner', displayName: 'Avery', email: 'avery@example.test', emailVerified: true };
const journey = {
  id: 'journey-visual-matrix', name: 'A calm visual record', location: '', startDate: '', startDateStatus: 'unknown', endDate: '', endDateStatus: 'forever',
  budgetCents: 0, version: 1, role: 'owner', createdAt: '2026-09-14T12:00:00.000Z', updatedAt: '2026-09-14T12:00:00.000Z',
};

const momentCases = [
  { id: 'inherited', theme: '', title: 'The page can hold this one', detail: 'An inherited treatment stays with the journeyer who chose the page around it.', occurredOn: '2026-09-14' },
  { id: 'light', theme: 'light', title: 'A little more room', detail: 'The light treatment remains calm beside a darker page.', occurredOn: '2026-09-13' },
  { id: 'dark', theme: 'dark', title: 'A quiet evening', detail: 'The dark treatment remains legible beside a lighter page.', occurredOn: '2026-09-12' },
  { id: 'green', theme: 'green', title: 'A photo held with care', detail: 'The attachment stays readable as a named part of the moment.', occurredOn: '2026-09-11' },
  { id: 'long-form', theme: 'flexoki', title: 'Words may take the room they need', detail: 'A long moment does not ask someone to shorten what happened just to fit a card. '.repeat(7), occurredOn: '2026-09-10' },
].map((moment) => ({
  ...moment, journeyId: journey.id, kind: 'memory', kindLabel: '', visibility: 'shared-now', moneyCents: null, moneyCurrency: '', locations: [],
  createdByUserId: owner.id, createdBy: owner.displayName, updatedBy: owner.displayName, shapedByBoth: false, version: 1,
  createdAt: `${moment.occurredOn}T12:00:00.000Z`, updatedAt: `${moment.occurredOn}T12:00:00.000Z`,
}));

const image = { id: 'image-green', momentId: 'green', filename: 'a-small-window.png', contentType: 'image/png', sizeBytes: 68, createdAt: '2026-09-11T12:00:00.000Z', deletedAt: null };
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function prepareVisualJourney(page) {
  await page.route('https://api.together-ledger.com/api/v1/session', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { user: owner, csrfToken: 'visual-csrf' } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: { journeys: [{ id: journey.id }] } }),
  }));
  await page.route(`https://api.together-ledger.com/api/v1/journeys/${journey.id}/snapshot`, (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ data: {
      journey, members: [{ id: owner.id, displayName: owner.displayName, role: 'owner', joinedAt: journey.createdAt }], invitations: [], expenses: [], moments: momentCases,
      images: [image], concerns: [], milestones: [], events: [{ id: 'visual-event', sequence: 1, actorUserId: owner.id, action: 'journey_created', entityType: 'journey', entityId: journey.id, summary: 'Created journey', before: null, after: null, previousHash: '', eventHash: '', createdAt: journey.createdAt }], eventChainValid: true,
    } }),
  }));
  await page.route(`https://api.together-ledger.com/api/v1/journeys/${journey.id}/billing`, (route) => route.fulfill({
    status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'billing_unavailable', message: 'Billing is not available for this review fixture.' } }),
  }));
  await page.route(`https://api.together-ledger.com/api/v1/journeys/${journey.id}/moments/green/images/${image.id}`, (route) => route.fulfill({ contentType: 'image/png', body: tinyPng }));
  await page.goto('/');
  await expect(page.locator('#moment-timeline .moment-card')).toHaveCount(3);
  await page.getByRole('button', { name: 'See all 5 moments' }).click();
  await expect(page.locator('#moment-timeline .moment-card')).toHaveCount(5);
  await expect(page.locator('.moment-image-attachment img')).toHaveJSProperty('complete', true);
}

async function expectNoHorizontalOverflow(page, label) {
  const size = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(size.scrollWidth, `${label} has no horizontal overflow`).toBeLessThanOrEqual(size.clientWidth);
}

async function selectThemeForReview(page, theme) {
  await page.locator('#workspace-theme-select').selectOption(theme);
  await expect(page.locator('#toast')).not.toHaveClass(/show/, { timeout: 4_000 });
}

test('the approved moment treatments keep a reviewed desktop and mobile visual matrix', async ({ page }) => {
  await prepareVisualJourney(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await selectThemeForReview(page, 'light');
  await expectNoHorizontalOverflow(page, 'light desktop');
  await expect(page).toHaveScreenshot('moment-matrix-light-desktop.png', { fullPage: true, animations: 'disabled' });

  await selectThemeForReview(page, 'dark');
  await expectNoHorizontalOverflow(page, 'dark desktop');
  await expect(page).toHaveScreenshot('moment-matrix-dark-desktop.png', { fullPage: true, animations: 'disabled' });

  await page.setViewportSize({ width: 320, height: 568 });
  await selectThemeForReview(page, 'light');
  await expectNoHorizontalOverflow(page, '320-pixel light mobile');
  await expect(page).toHaveScreenshot('moment-matrix-light-mobile-320.png', { fullPage: true, animations: 'disabled' });

  await page.setViewportSize({ width: 390, height: 844 });
  await selectThemeForReview(page, 'dark');
  await expectNoHorizontalOverflow(page, '390-pixel dark mobile');
  await expect(page).toHaveScreenshot('moment-matrix-dark-mobile-390.png', { fullPage: true, animations: 'disabled' });

  const accessibilityScan = await new AxeBuilder({ page }).include('main').analyze();
  expect(accessibilityScan.violations).toEqual([]);

  const edit = page.locator('#moment-timeline .moment-card').last().getByRole('button', { name: 'Edit' });
  await page.evaluate(() => document.activeElement?.blur());
  for (let tab = 0; tab < 80 && !await edit.evaluate((element) => element.matches(':focus-visible')); tab += 1) await page.keyboard.press('Tab');
  await expect(edit).toBeFocused();
  await expect(edit).toHaveCSS('outline-style', 'solid');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('body')).toHaveCSS('transition-duration', '0s');
  await page.locator('#moment-timeline .moment-card').last().getByRole('button', { name: 'Edit' }).hover();
  await expect(page.locator('#moment-timeline .moment-card').last().getByRole('button', { name: 'Edit' })).toHaveCSS('transform', 'none');

  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await expect.poll(() => page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
  await expect(page.locator('#moment-timeline .moment-card').first()).toHaveCSS('border-left-width', '5px');
  await expect(page).toHaveScreenshot('moment-matrix-forced-colors-mobile-390.png', { fullPage: true, animations: 'disabled' });
});
