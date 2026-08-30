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

test('all sixteen personal themes keep one registry, one meaning, and no decorative emoji', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const themes = await page.evaluate(() => window.TOGETHER_THEMES.map(({ id, label, base }) => ({ id, label, base })));
  expect(themes).toHaveLength(16);
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
  await page.route('https://api.together-ledger.com/api/v1/session', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in first.' } }),
  }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page).toHaveScreenshot('welcome-light-desktop.png', { fullPage: true, animations: 'disabled' });

  await page.locator('#theme-select').selectOption('solar-red');
  await expect(page.locator('#toast')).not.toHaveClass(/show/, { timeout: 4_000 });
  await expect(page).toHaveScreenshot('welcome-solar-red-desktop.png', { fullPage: true, animations: 'disabled' });

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
  await page.locator('#workspace-theme-select').selectOption('solar-red');
  await expect(page.locator('#toast')).not.toHaveClass(/show/, { timeout: 4_000 });
  await page.getByRole('button', { name: 'Journey settings' }).click();
  await expect(page).toHaveScreenshot('settings-solar-red-desktop.png', { animations: 'disabled' });
});
