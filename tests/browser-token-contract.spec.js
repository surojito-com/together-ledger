import { test, expect } from '@playwright/test';

// The theme gate proves the token values are right. A screenshot proves the layout is right.
// Neither proves a component reads the token that carries its meaning, and a screenshot cannot:
// Playwright's default per-pixel threshold treats two pale colours as the same, which is how
// six committed images came to depict colours the product no longer rendered (#140).
// So colour is asserted here, against the token, rather than photographed.

const THEMES = ['light', 'dark', 'green', 'flexoki'];

// Resolves a custom property the way the browser does, through a real element, so the answer
// is the painted colour rather than the declaration text.
async function token(page, name) {
  return page.evaluate((property) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${property})`;
    probe.style.position = 'absolute';
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
}

const colourOf = (page, selector, property) => page.evaluate(
  ([target, prop]) => getComputedStyle(document.querySelector(target))[prop],
  [selector, property],
);

test('every theme paints the shell from the role that carries its meaning', async ({ page }) => {
  await page.goto('/');

  for (const theme of THEMES) {
    await page.locator('#theme-select').selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    expect(await colourOf(page, '.button.primary', 'backgroundColor'), `${theme}: primary action`)
      .toBe(await token(page, '--accent'));
    const pageBackground = await token(page, '--bg');
    await expect.poll(() => colourOf(page, 'body', 'backgroundColor'), { message: `${theme}: page` })
      .toBe(pageBackground);
  }
});

test('a moment paints its privacy state from the privacy roles, in every theme', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Begin your ledger/ }).first().click();

  for (const [visibility, role] of [['private', '--private'], ['share-later', '--share-later'], ['shared-now', '--shared-now']]) {
    await page.locator('#moment-form [name="title"]').fill(`A moment held ${visibility}`);
    await page.locator(`#moment-form [name="visibility"][value="${visibility}"]`).check();
    await page.getByRole('button', { name: 'Hold this moment' }).click();
    await expect(page.locator(`.moment-card.${visibility}`).first()).toBeVisible();
    await page.locator('[data-open-moment]').first().click();
  }
  await page.keyboard.press('Escape');

  for (const theme of THEMES) {
    await page.locator('#workspace-theme-select').selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    for (const [visibility, role] of [['private', '--private'], ['share-later', '--share-later'], ['shared-now', '--shared-now']]) {
      const expected = await token(page, role);
      expect(await colourOf(page, `.moment-card.${visibility}`, 'borderLeftColor'), `${theme}: ${visibility} card edge`)
        .toBe(expected);
      expect(await colourOf(page, `.visibility-chip.${visibility}`, 'color'), `${theme}: ${visibility} label`)
        .toBe(expected);
    }

    // The three states must also differ from each other, or a shared contract would pass while
    // every state looked identical.
    const painted = await Promise.all(['private', 'share-later', 'shared-now']
      .map((visibility) => colourOf(page, `.moment-card.${visibility}`, 'borderLeftColor')));
    expect(new Set(painted).size, `${theme}: privacy states must not collapse`).toBe(3);
  }
});

test('a destructive action never borrows the ordinary accent', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Begin your ledger/ }).first().click();
  // Saving a moment is what settles the ledger surface; closing the dialog by hand races it.
  await page.locator('#moment-form [name="title"]').fill('Something to hold');
  await page.getByRole('button', { name: 'Hold this moment' }).click();
  await expect(page.locator('#moment-timeline')).toContainText('Something to hold');
  await page.locator('#settings-button').click();
  await expect(page.locator('.button.danger').first()).toBeVisible();

  for (const theme of THEMES) {
    await page.locator('#settings-theme-select').selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    const destructive = await colourOf(page, '.button.danger', 'backgroundColor');
    expect(destructive, `${theme}: destructive action`).toBe(await token(page, '--destructive'));
    expect(destructive, `${theme}: destructive must not read as the accent`).not.toBe(await token(page, '--accent'));
  }
});

// The destructive role only means something if it is rare. A `--red` alias pointed at it and was
// then borrowed for a section label, a selected day and a location glyph, none of which destroy
// anything — and two of those had already been patched back to the accent by hand rather than the
// alias being fixed. The label it reached is the worst possible one: the notice that reassures a
// visitor no name, email or password has left the screen, titled in the colour of alarm.
test('the destructive colour is spent only on what cannot be undone', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  await page.evaluate(() => document.querySelector('#account-unavailable').removeAttribute('hidden'));
  const notice = page.locator('#account-unavailable .eyebrow');
  await expect(notice).toBeVisible();

  for (const theme of THEMES) {
    await page.locator('#theme-select').selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

    const label = await colourOf(page, '#account-unavailable .eyebrow', 'color');
    expect(label, `${theme}: a reassurance is not a warning`).not.toBe(await token(page, '--destructive'));
    expect(label, `${theme}: a section label carries the accent`).toBe(await token(page, '--accent'));
  }
});
