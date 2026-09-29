import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const responsiveCases = [
  { width: 320, height: 568 },
  { width: 374, height: 667 },
  { width: 375, height: 667 },
  { width: 479, height: 800 },
  { width: 480, height: 800 },
  { width: 620, height: 850 },
  { width: 767, height: 900 },
  { width: 768, height: 1024 },
  { width: 900, height: 900 },
  { width: 1023, height: 900 },
  { width: 1024, height: 768 },
  { width: 1439, height: 900 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];

test('the welcome stays contained at every agreed responsive boundary', async ({ page }) => {
  for (const viewport of responsiveCases) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Keep what matters, together.' })).toBeVisible();
    const size = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(size.scrollWidth, `${viewport.width}×${viewport.height} page overflow`).toBeLessThanOrEqual(size.clientWidth);
  }
});

test('the first laptop viewport contains the complete welcome decision', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const selectors = ['#welcome-title', '.welcome-intro', '.welcome-actions', '.welcome-boundary', '.ledger-preview'];
  for (const selector of selectors) {
    const box = await page.locator(selector).boundingBox();
    expect(box, `${selector} has a visible box`).not.toBeNull();
    expect(box.y + box.height, `${selector} is above the fold`).toBeLessThanOrEqual(900);
  }
});

test('mobile welcome actions remain large, reachable, and keyboard clear', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');

  const actionSizes = await page.locator('#welcome .button:visible').evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return { label: element.textContent.trim(), width: rect.width, height: rect.height };
  }));
  expect(actionSizes.length).toBeGreaterThan(1);
  for (const action of actionSizes) {
    expect(action.height, `${action.label} touch height`).toBeGreaterThanOrEqual(44);
    expect(action.width, `${action.label} touch width`).toBeGreaterThanOrEqual(44);
  }

  await page.locator('.welcome-menu > summary').focus();
  await expect(page.locator('.welcome-menu > summary')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.welcome-menu')).toHaveAttribute('open', '');
  await expect(page.locator('#mobile-theme-select')).toBeVisible();

  const accessibilityScan = await new AxeBuilder({ page }).include('header').include('#welcome').analyze();
  expect(accessibilityScan.violations).toEqual([]);
});

test('the four curated themes keep one registry, one meaning, and no decorative emoji', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const themes = await page.evaluate(() => window.TOGETHER_THEMES.map(({ id, label, base }) => ({ id, label, base })));
  expect(themes).toHaveLength(4);
  const optionLabels = await page.locator('#theme-select option').allTextContents();
  expect(optionLabels).toEqual(themes.map(({ label }) => label));
  expect(optionLabels.join('')).not.toMatch(/[☀️🌙🔴🟢🟣🔵🟤🟡🌸☕📜🌅🪷🐙🌤️🏙️]/u);

  for (const theme of themes) {
    await page.locator('#theme-select').selectOption(theme.id);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
    await expect(page.locator('html')).toHaveAttribute('data-theme-base', theme.base);
    await expect(page.locator('#mobile-theme-select')).toHaveValue(theme.id);
    await expect(page.locator('#workspace-theme-select')).toHaveValue(theme.id);
    await expect(page.locator('#settings-theme-select')).toHaveValue(theme.id);
  }

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', themes.at(-1).id);
});

test('a pending account action is announced and cannot be submitted twice', async ({ page }) => {
  let finishLogin;
  const loginMayFinish = new Promise((resolve) => { finishLogin = resolve; });
  await page.route('https://api.together-ledger.com/api/v1/session', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in first.' } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/auth/login', async (route) => {
    await loginMayFinish;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { user: { id: 'user-1', username: 'journeyer', displayName: 'Journeyer', email: 'journeyer@example.test', emailVerified: true }, csrfToken: 'csrf-test' } }),
    });
  });
  await page.route('https://api.together-ledger.com/api/v1/journeys', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: { journeys: [] } }),
  }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  await page.locator('#login-form [name="identifier"]').fill('journeyer');
  await page.locator('#login-form [name="password"]').fill('a-long-careful-password');
  await page.locator('#login-form').getByRole('button', { name: 'Sign in', exact: true }).click();

  const pendingButton = page.locator('#login-form').getByRole('button', { name: 'Signing in…' });
  await expect(pendingButton).toBeDisabled();
  await expect(pendingButton).toHaveAttribute('aria-busy', 'true');
  finishLogin();
  await expect(page.locator('#account-dialog')).not.toBeVisible();
});

// The status region is deliberately placed above the work so nothing is covered. A modal dialog
// is the one surface where that stopped being true: it paints over the page and dims it, so a
// refused sign-in wrote its reason behind the dialog that asked for it. The region is one region;
// it has to follow the work into the dialog and leave with it.
test('a problem raised inside a dialog is shown inside that dialog', async ({ page }) => {
  await page.route('https://api.together-ledger.com/api/v1/session', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in first.' } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/auth/login', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'invalid_credentials', message: 'Those details did not match.' } }),
  }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  await page.locator('#login-form [name="identifier"]').fill('journeyer');
  await page.locator('#login-form [name="password"]').fill('a-long-careful-password');
  await page.locator('#login-form').getByRole('button', { name: 'Sign in', exact: true }).click();

  const banner = page.locator('#status-banner');
  await expect(banner).toBeVisible();
  // Inside the dialog, and genuinely the topmost thing at its own position rather than merely
  // present in the DOM behind a backdrop.
  await expect(page.locator('#account-dialog #status-banner')).toBeVisible();
  expect(await page.evaluate(() => {
    const element = document.querySelector('#status-banner');
    const box = element.getBoundingClientRect();
    const onTop = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return !!(onTop && element.contains(onTop));
  }), 'the reason must not be painted behind the dialog reporting it').toBe(true);

  // Closing the dialog takes its problem with it and returns the region above the work.
  await page.locator('[data-close-account]').first().click();
  await expect(banner).toBeHidden();
  await expect(page.locator('#account-dialog #status-banner')).toHaveCount(0);
});

test('a journey owner sees only the approved test billing controls', async ({ page }) => {
  const owner = { id: 'user-1', username: 'journeyer', displayName: 'Journeyer', email: 'journeyer@example.test', emailVerified: true };
  await page.route('https://api.together-ledger.com/api/v1/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: { user: owner, csrfToken: 'csrf-test' } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: { journeys: [{ id: 'journey-billing' }] } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys/journey-billing/snapshot', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: {
      journey: { id: 'journey-billing', name: 'A wider circle', location: '', startDate: '', startDateStatus: 'unknown', endDate: '', endDateStatus: 'forever', budgetCents: 0, version: 1, role: 'owner', createdAt: '2026-09-07T18:00:00.000Z', updatedAt: '2026-09-07T18:00:00.000Z' },
      members: [{ id: owner.id, displayName: owner.displayName, role: 'owner', joinedAt: '2026-09-07T18:00:00.000Z' }],
      invitations: [], expenses: [], moments: [], concerns: [], milestones: [],
      events: [{ id: 'event-1', sequence: 1, actorUserId: owner.id, action: 'journey_created', entityType: 'journey', entityId: 'journey-billing', summary: 'Created journey', before: null, after: null, previousHash: '', eventHash: '', createdAt: '2026-09-07T18:00:00.000Z' }],
      eventChainValid: true,
    } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys/journey-billing/billing', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: {
      enabled: true,
      portalEnabled: true,
      environment: 'test',
      journey: { id: 'journey-billing', name: 'A wider circle' },
      offers: [{ id: 'additional-person-monthly', label: 'Another person', cadence: 'month', currency: 'USD', unitAmount: 100 }],
      entitlement: { state: 'active', quantity: 1, expiresAt: '2026-10-07T18:00:00.000Z' },
      subscription: { status: 'active', paidCapacity: 1, currentPeriodEnd: '2026-10-07T18:00:00.000Z', cancelAtPeriodEnd: false },
      invoices: [],
    } }),
  }));

  await page.goto('/');
  await page.getByRole('button', { name: 'Account settings', exact: true }).first().click();
  await expect(page.locator('#billing-panel')).toBeVisible();
  await expect(page.locator('#billing-environment')).toContainText('Test mode — checkout cannot create a real charge.');
  await expect(page.locator('#billing-status')).toContainText('1 additional person is covered');
  // Covered and needing attention must not read alike; the state carries a tone, not just words.
  await expect(page.locator('#billing-status')).toHaveClass(/settled/);
  await expect(page.locator('.billing-status-glyph')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add another person · $1.00 USD / month' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Manage payment and cancellation' })).toBeVisible();
  await expect(page.locator('.billing-boundary')).toContainText('Apple App Store and future Google Play purchases remain with those stores');
  const accessibilityScan = await new AxeBuilder({ page }).include('#account-dialog').analyze();
  expect(accessibilityScan.violations).toEqual([]);
});

test('a journey owner without paid capacity can choose 1-99 additional places before checkout', async ({ page }) => {
  const owner = { id: 'user-1', username: 'journeyer', displayName: 'Journeyer', email: 'journeyer@example.test', emailVerified: true };
  let lastCheckoutBody = null;
  await page.route('https://api.together-ledger.com/api/v1/session', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: { user: owner, csrfToken: 'csrf-test' } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: { journeys: [{ id: 'journey-billing' }] } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys/journey-billing/snapshot', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: {
      journey: { id: 'journey-billing', name: 'A wider circle', location: '', startDate: '', startDateStatus: 'unknown', endDate: '', endDateStatus: 'forever', budgetCents: 0, version: 1, role: 'owner', createdAt: '2026-09-07T18:00:00.000Z', updatedAt: '2026-09-07T18:00:00.000Z' },
      members: [{ id: owner.id, displayName: owner.displayName, role: 'owner', joinedAt: '2026-09-07T18:00:00.000Z' }],
      invitations: [], expenses: [], moments: [], concerns: [], milestones: [],
      events: [{ id: 'event-1', sequence: 1, actorUserId: owner.id, action: 'journey_created', entityType: 'journey', entityId: 'journey-billing', summary: 'Created journey', before: null, after: null, previousHash: '', eventHash: '', createdAt: '2026-09-07T18:00:00.000Z' }],
      eventChainValid: true,
    } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys/journey-billing/billing', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ data: {
      enabled: true,
      portalEnabled: false,
      environment: 'test',
      journey: { id: 'journey-billing', name: 'A wider circle' },
      offers: [{ id: 'additional-person-monthly', label: 'Another person', cadence: 'month', currency: 'USD', unitAmount: 100 }],
      entitlement: null,
      subscription: null,
      invoices: [],
    } }),
  }));
  await page.route('https://api.together-ledger.com/api/v1/journeys/journey-billing/billing/checkout-sessions', async (route) => {
    lastCheckoutBody = route.request().postDataJSON();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { url: 'https://checkout.stripe.com/c/pay/test', environment: 'test' } }) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Account settings', exact: true }).first().click();
  await expect(page.locator('#billing-panel')).toBeVisible();
  const range = page.locator('#billing-capacity-range');
  const number = page.locator('#billing-capacity-number');
  await expect(range).toBeVisible();
  await expect(range).toHaveAttribute('min', '1');
  await expect(range).toHaveAttribute('max', '99');
  await expect(number).toHaveValue('1');
  await expect(page.locator('#billing-capacity-total')).toContainText('$1.00');

  await number.fill('99');
  await number.dispatchEvent('change');
  await expect(range).toHaveValue('99');
  await expect(page.locator('#billing-capacity-total')).toContainText('$99.00');

  await number.fill('150');
  await number.dispatchEvent('change');
  await expect(number).toHaveValue('99');
  await expect(range).toHaveValue('99');

  await number.fill('12');
  await number.dispatchEvent('change');
  await expect(range).toHaveValue('12');
  await expect(page.locator('#billing-capacity-total')).toContainText('$12.00');

  const accessibilityScan = await new AxeBuilder({ page }).include('#account-dialog').analyze();
  expect(accessibilityScan.violations).toEqual([]);

  await page.getByRole('button', { name: 'Add another person · $1.00 USD / month' }).click();
  await expect.poll(() => lastCheckoutBody?.paidCapacity).toBe(12);
});

test('beginning locally keeps the account and hosted privacy boundaries separate', async ({ page }) => {
  const mutations = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET') mutations.push(`${request.method()} ${request.url()}`);
  });
  await page.goto('/');
  await expect(page.locator('#privacy')).toContainText('Signing in never uploads or merges the ledger already held in this browser.');

  const begin = page.getByRole('button', { name: /Begin your ledger/ }).first();
  await begin.click();
  await expect(page.locator('#moment-dialog')).toBeVisible();
  await expect(page.locator('#moment-dialog-copy')).toContainText('local cue, not separate-account privacy');
  await expect(page.locator('#moment-visibility-help')).toContainText('Private and Share later are local cues');
  expect(mutations.filter((request) => request.includes('/api/'))).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(page.locator('#moment-dialog')).not.toBeVisible();
  await expect(page.locator('#moments-title')).toBeFocused();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.account-boundary')).toContainText('never uploads, merges, or removes the ledger already held in this browser');
  await page.getByRole('button', { name: 'Close account settings' }).click();
  await page.getByRole('button', { name: 'Journey settings' }).click();
  await expect(page.locator('#settings-storage-copy')).toContainText('Browser-only journeys stay on this device');
  await expect(page.locator('#backup-privacy-copy')).toContainText('private journey content');
  await expect(page.locator('#restore-boundary-copy')).toContainText('Import replaces this browser’s current ledger only after the whole file passes validation');
  await expect(page.getByRole('button', { name: 'Import and replace' })).toBeVisible();
});

test('the working ledger remains contained with long content at mobile and desktop widths', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Begin your ledger/ }).first().click();
  await page.locator('#moment-form [name="kind"]').selectOption('other');
  await page.locator('#moment-form [name="kindLabel"]').fill('A deliberately long kind of moment that still belongs here');
  await page.locator('#moment-form [name="title"]').fill('A long private sentence that should wrap without forcing the shared journey sideways on a small screen');
  await page.locator('#moment-form [name="detail"]').fill('Words can be long because people do not edit their lives to fit a breakpoint. '.repeat(8));
  await page.getByRole('button', { name: 'Hold this moment' }).click();

  for (const viewport of [{ width: 320, height: 568 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    const size = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(size.scrollWidth, `${viewport.width} working-ledger overflow`).toBeLessThanOrEqual(size.clientWidth);
    await expect(page.getByText('A long private sentence that should wrap without forcing the shared journey sideways on a small screen')).toBeVisible();
  }
});

test('a complete browser-only journey remains reachable at the narrowest supported width', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/');
  await page.getByRole('button', { name: /Begin your ledger/ }).first().click();

  await page.locator('#moment-form [name="kind"]').selectOption('called-you');
  await page.locator('#moment-form [name="title"]').fill('I called when I said I would');
  await page.getByRole('button', { name: 'Hold this moment' }).click();
  await expect(page.locator('#moment-timeline')).toContainText('I called when I said I would');

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.locator('#moment-form [name="detail"]').fill('We kept the promise gently.');
  await page.getByRole('button', { name: 'Save moment' }).click();
  await expect(page.locator('#moment-timeline')).toContainText('We kept the promise gently.');

  await page.getByRole('button', { name: 'Journey settings' }).click();
  await expect(page.getByRole('button', { name: 'Export all journeys' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import and replace' })).toBeVisible();
  await page.getByRole('button', { name: 'Close settings' }).click();

  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.account-boundary')).toBeVisible();
  await page.getByRole('button', { name: 'Close account settings' }).click();

  const size = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(size.scrollWidth).toBeLessThanOrEqual(size.clientWidth);

  const accessibilityScan = await new AxeBuilder({ page }).include('header').include('main').analyze();
  expect(accessibilityScan.violations).toEqual([]);
});

test('representative light, dark, and high-chroma surfaces keep their visual contract', async ({ page }) => {
  // Hold a moment prefills its date from the clock, so a live clock would bake the run's own
  // date into the committed image and fail every day after. Timers still run; only Date is fixed.
  await page.clock.setFixedTime(new Date('2026-09-14T12:00:00.000Z'));
  await page.route('https://api.together-ledger.com/api/v1/session', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in first.' } }),
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page).toHaveScreenshot('welcome-light-desktop.png', { fullPage: true, animations: 'disabled' });

  await page.locator('#theme-select').selectOption('green');
  await expect(page.locator('#toast')).not.toHaveClass(/show/, { timeout: 4_000 });
  await expect(page).toHaveScreenshot('welcome-green-desktop.png', { fullPage: true, animations: 'disabled' });

  await page.setViewportSize({ width: 320, height: 568 });
  await page.locator('.welcome-menu > summary').click();
  await page.locator('#mobile-theme-select').selectOption('dark');
  await expect(page.locator('#toast')).not.toHaveClass(/show/, { timeout: 4_000 });
  await expect(page).toHaveScreenshot('welcome-dark-mobile.png', { fullPage: true, animations: 'disabled' });

  await page.locator('.welcome-menu > summary').click();
  await page.getByRole('button', { name: /Begin your ledger/ }).first().click();
  await expect(page).toHaveScreenshot('moment-dark-mobile.png', { animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(page).toHaveScreenshot('ledger-dark-mobile.png', { fullPage: true, animations: 'disabled' });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('#workspace-theme-select').selectOption('green');
  await expect(page.locator('#toast')).not.toHaveClass(/show/, { timeout: 4_000 });
  await page.getByRole('button', { name: 'Journey settings' }).click();
  await expect(page).toHaveScreenshot('settings-green-desktop.png', { animations: 'disabled' });
});

test('the small screen keeps one primary action and its own section navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /Begin your ledger/ }).first().click();
  await page.locator('#moment-form [name="title"]').fill('A first small truth');
  await page.getByRole('button', { name: 'Hold this moment' }).click();
  await expect(page.locator('#moment-timeline')).toContainText('A first small truth');

  // The desktop layout offers the same action three times. A small screen keeps the one in
  // the persistent bar and stands the inline copies down, rather than stacking them.
  const actions = page.locator('[data-open-moment]:visible');
  await expect(actions).toHaveCount(1);
  await expect(page.locator('.mobile-action [data-open-moment]')).toBeVisible();

  const sections = page.locator('.ledger-sections a');
  await expect(sections).toHaveCount(2);
  await expect(sections.first()).toHaveAttribute('href', '#moments');
  await expect(sections.last()).toHaveAttribute('href', '#threads');

  // A personal view setting stays in reach on a phone rather than moving behind journey settings.
  await expect(page.locator('#workspace-theme-select')).toBeVisible();

  const undersized = await page.evaluate(() => [...document.querySelectorAll('.ledger-sections a, .mobile-action button, .header-actions button, .header-actions select')]
    .filter((element) => element.offsetParent !== null && element.getBoundingClientRect().height < 44)
    .map((element) => element.textContent.trim() || element.id));
  expect(undersized).toEqual([]);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const accessibilityScan = await new AxeBuilder({ page }).include('header').include('main').analyze();
  expect(accessibilityScan.violations).toEqual([]);
});
