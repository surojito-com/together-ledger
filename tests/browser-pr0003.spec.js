import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const mailboxUrl = 'http://127.0.0.1:8025/';
const password = 'correct horse battery staple';

async function skipOnboarding(page) {
  if (await page.locator('#onboarding-dialog').getAttribute('open') !== null) await page.locator('#skip-onboarding').click();
}

async function createAccount(page, { name, email }) {
  await page.goto('/');
  await skipOnboarding(page);
  await page.locator('#account-button').click();
  await page.locator('#register-form [name="displayName"]').fill(name);
  await page.locator('#register-form [name="email"]').fill(email);
  await page.locator('#register-form [name="password"]').fill(password);
  await page.locator('#register-form .button.primary').click();
  await expect(page.locator('#account-button')).toHaveText(name);
}

async function mailboxLink(request, parameter, recipient) {
  let match = '';
  await expect.poll(async () => {
    const response = await request.get(mailboxUrl);
    const { messages } = await response.json();
    match = messages.filter((message) => message.to.includes(recipient)).flatMap((message) => message.links).find((link) => link.includes(`?${parameter}=`)) || '';
    return match;
  }).not.toBe('');
  return match;
}

async function verifyAccount(page, request, email) {
  await page.goto(await mailboxLink(request, 'verify', email));
  await expect(page.locator('#verification-status')).toContainText('verified');
}

test('private journeys use separate accounts and leave browser-only data untouched', async ({ browser, request }) => {
  const runId = `${Date.now()}-${process.pid}`;
  const aliceEmail = `alice.browser.${runId}@example.test`;
  const bobEmail = `bob.browser.${runId}@example.test`;
  await request.delete(mailboxUrl);
  const aliceContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const bobContext = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();

  await createAccount(alice, { name: 'Alice QA', email: aliceEmail });
  const browserLedgerBefore = await alice.evaluate(() => localStorage.getItem('together-ledger-v2'));
  await verifyAccount(alice, request, aliceEmail);

  await alice.locator('#new-journey-button').click();
  await alice.locator('#journey-form [name="name"]').fill('Private coast QA');
  await alice.locator('#journey-form [name="location"]').fill('Synthetic coast');
  await alice.locator('#journey-form [name="startDate"]').fill('2026-08-07');
  await alice.locator('#journey-form [name="endDate"]').fill('2026-08-09');
  await alice.locator('#journey-form [name="budget"]').fill('500');
  await alice.locator('#save-journey-button').click();
  await expect(alice.locator('#trip-name')).toHaveText('Private coast QA');
  await expect(alice.locator('#sync-badge')).toHaveText('Private sync');

  await alice.locator('.journey-actions [data-open-expense]').click();
  await alice.locator('#expense-form [name="merchant"]').fill('Shared ferry');
  await alice.locator('#expense-form [name="category"]').selectOption('Transportation');
  await alice.locator('#expense-form [name="amount"]').fill('10');
  await alice.locator('#expense-form [name="occurredOn"]').fill('2026-08-08');
  await alice.locator('#save-expense').click();
  await expect(alice.locator('#ledger')).toContainText('Shared ferry');

  await createAccount(bob, { name: 'Bob QA', email: bobEmail });
  await verifyAccount(bob, request, bobEmail);

  await alice.locator('#settings-button').click();
  await expect(alice.locator('#invite-form')).toBeVisible();
  await alice.locator('#invite-form [name="email"]').fill(bobEmail);
  await alice.locator('#invite-form .button.primary').click();
  const inviteLink = await mailboxLink(request, 'invite', bobEmail);
  await bob.goto(inviteLink);
  await expect(bob.locator('#trip-name')).toHaveText('Private coast QA');
  await expect(bob.locator('#sync-badge')).toHaveText('Private sync');

  await alice.locator('[data-close-settings]').click();
  await alice.locator('#ledger [data-edit]').click();
  await bob.locator('#ledger [data-edit]').click();
  await bob.locator('#expense-form [name="amount"]').fill('20');
  await bob.locator('#save-expense').click();
  await expect(bob.locator('#ledger')).toContainText('$20.00');
  await alice.locator('#expense-form [name="amount"]').fill('30');
  await alice.locator('#save-expense').click();
  await expect(alice.locator('#toast')).toContainText('another device');
  await expect(alice.locator('#expense-dialog')).toBeVisible();
  await alice.getByRole('button', { name: 'Cancel' }).click();

  await bob.locator('#event-manager-button').click();
  await expect(bob.locator('#event-manager-copy')).toContainText('Server-authoritative');
  await expect(bob.locator('#event-list')).toContainText('Alice QA');
  await expect(bob.locator('#event-list')).toContainText('Bob QA');
  await expect(bob.locator('#event-list')).toContainText('Hash');
  await bob.locator('#event-dialog .icon-button').click();

  const accessibility = await new AxeBuilder({ page: alice }).analyze();
  expect(accessibility.violations.filter((violation) => ['critical', 'serious'].includes(violation.impact))).toEqual([]);
  await alice.screenshot({ path: '/tmp/together-ledger-pr0003-desktop.png', fullPage: true });

  const themeOptions = await alice.locator('#theme-select option').evaluateAll((options) => options.map((option) => option.value));
  expect(themeOptions).toHaveLength(16);
  for (const theme of themeOptions) {
    await alice.locator('#theme-select').selectOption(theme);
    await expect(alice.locator('html')).toHaveAttribute('data-theme', theme);
  }

  await alice.setViewportSize({ width: 390, height: 844 });
  const finalSections = await alice.locator('.workspace > details').evaluateAll((items) => items.map((item) => item.textContent.trim().replace(/\s+/g, ' ')));
  expect(finalSections[0]).toContain('The ledger');
  expect(finalSections[1]).toContain('Daily spending');
  await alice.screenshot({ path: '/tmp/together-ledger-pr0003-mobile.png', fullPage: true });

  await alice.locator('#account-button').click();
  await alice.locator('#logout-button').click();
  await expect(alice.locator('#sync-badge')).toHaveText('Browser only');
  await expect(alice.locator('#trip-name')).toHaveText('Coastal Weekend');
  expect(await alice.evaluate(() => localStorage.getItem('together-ledger-v2'))).toBe(browserLedgerBefore);

  await bob.locator('#account-button').click();
  await bob.locator('#recovery-button').click();
  await expect(bob.locator('#recovery-request-dialog')).toBeVisible();
  await bob.locator('#recovery-request-form [name="email"]').fill(bobEmail);
  await bob.locator('#recovery-request-form .button.primary').click();
  const recoveryLink = await mailboxLink(request, 'recovery', bobEmail);
  await bob.goto(recoveryLink);
  await expect(bob.locator('#recovery-confirm-dialog')).toBeVisible();
  await bob.locator('#recovery-confirm-form [name="password"]').fill('a new correct horse battery staple');
  await bob.locator('#recovery-confirm-form [name="confirmPassword"]').fill('a new correct horse battery staple');
  await bob.locator('#recovery-confirm-form .button.primary').click();
  await expect(bob.locator('#sync-badge')).toHaveText('Browser only');

  await aliceContext.close();
  await bobContext.close();
});
