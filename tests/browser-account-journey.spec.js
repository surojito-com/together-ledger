// A hosted journey borrows the view and gives it back.
//
// Signing in at the app's own home shows an account's journey in place of the
// browser-only ledger, and signing out returns the browser's own ledger
// unchanged. The two stores stay separate: nothing held in this browser is
// uploaded by signing in, and nothing is erased by signing out.
//
// This runs against a hosted target that offers accounts:
//
//   QA_BASE_URL=https://app.together-ledger.com \
//   QA_ACCOUNT_USERNAME=... QA_ACCOUNT_PASSWORD=... npx playwright test browser-account-journey
//
// Without those it skips, so the ordinary local browser run is unaffected.

import { test, expect } from '@playwright/test';

const username = process.env.QA_ACCOUNT_USERNAME || '';
const password = process.env.QA_ACCOUNT_PASSWORD || '';
const STORAGE_KEY = 'together-ledger-v3';
const BROWSER_ONLY_MOMENT = 'Held in this browser alone';

const browserLedger = (page) => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);

test.describe('TC-10970: a hosted journey borrows the view and gives it back', () => {
  test.skip(!username || !password, 'Set QA_ACCOUNT_USERNAME and QA_ACCOUNT_PASSWORD to run the signed-in checks.');

  test('signing in and out never changes the browser-only ledger', async ({ page }) => {
    await page.goto('/');

    const accountsEnabled = await page.locator('meta[name="together-accounts-enabled"]').getAttribute('content');
    test.skip(accountsEnabled !== 'true', 'This target does not offer accounts.');

    // Something held in this browser alone, before any account is involved.
    await page.locator('[data-begin-ledger]').first().click();
    await expect(page.locator('#moment-dialog')).toBeVisible();
    await page.locator('#moment-form [name="kind"]').selectOption('memory');
    await page.locator('#moment-form [name="occurredOn"]').fill('2026-09-14');
    await page.locator('#moment-form [name="title"]').fill(BROWSER_ONLY_MOMENT);
    await page.locator('#moment-form [name="detail"]').fill('This moment is never uploaded by signing in.');
    await page.locator('#save-moment').click();
    await expect(page.locator('#moment-timeline')).toContainText(BROWSER_ONLY_MOMENT);
    await expect(page.locator('#sync-badge')).toHaveText('Browser only');

    const beforeSignIn = await browserLedger(page);
    expect(beforeSignIn).toContain(BROWSER_ONLY_MOMENT);

    await page.locator('#account-button').click();
    await page.locator('#login-form [name="identifier"]').fill(username);
    await page.locator('#login-form [name="password"]').fill(password);
    await page.locator('#login-form button.primary').click();

    // Signing in takes over the view and uploads nothing: the browser ledger
    // is unchanged byte for byte while an account's journey is on screen.
    await expect(page.locator('#account-button')).toHaveText('Account settings');
    await expect(page.locator('#sync-badge')).not.toHaveText('Browser only');
    await expect(page.locator('#moment-timeline')).not.toContainText(BROWSER_ONLY_MOMENT);
    expect(await browserLedger(page)).toBe(beforeSignIn);

    await page.locator('#account-button').click();
    await page.locator('#logout-button').click();

    // Sign-out ends the hosted view and gives this browser its own ledger back.
    await expect(page.locator('#account-button')).toHaveText('Sign in');
    await expect(page.locator('#sync-badge')).toHaveText('Browser only');
    await expect(page.locator('#moment-timeline')).toContainText(BROWSER_ONLY_MOMENT);
    expect(await browserLedger(page)).toBe(beforeSignIn);

    await page.reload();
    await expect(page.locator('#moment-timeline')).toContainText(BROWSER_ONLY_MOMENT);
    expect(await browserLedger(page)).toBe(beforeSignIn);
  });
});
