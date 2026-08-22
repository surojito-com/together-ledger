import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function skipOnboarding(page) {
  if (await page.locator('#onboarding-dialog').getAttribute('open') !== null) await page.locator('#skip-onboarding').click();
}

test('the first browser-only screen begins empty and explains what can be held', async ({ page }) => {
  await page.goto('/');
  await skipOnboarding(page);

  await expect(page.getByRole('heading', { name: 'What can live here?' })).toBeVisible();
  await expect(page.locator('#moment-timeline')).toContainText('There are no examples here—only possibilities:');
  await expect(page.locator('#moment-timeline')).toContainText('Repair request');
  await expect(page.locator('.trip-bar')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Begin' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Return-to conversations' })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'One question, if now is a good time.' })).toBeHidden();
  await expect(page.getByRole('button', { name: /See all \d+ moments/ })).toBeHidden();
  await expect(page.locator('body')).not.toContainText('Total trip cost');
  await expect(page.locator('body')).not.toContainText('Daily spending');

  await page.getByRole('button', { name: 'Begin' }).click();
  await page.locator('#moment-form [name="kind"]').selectOption('heart-to-heart');
  await page.locator('#moment-form [name="occurredOn"]').fill('2026-08-17');
  await page.locator('#moment-form [name="title"]').fill('We made room to listen');
  await page.locator('#moment-form [name="detail"]').fill('We paused before trying to solve anything.');
  await page.locator('#moment-form [name="visibility"][value="share-later"]').check();
  await page.locator('#moment-form [name="money"]').fill('19.95');
  await page.getByRole('button', { name: 'Hold this moment' }).click();

  await expect(page.locator('#moment-timeline')).toContainText('We made room to listen');
  await expect(page.locator('.trip-bar')).toBeVisible();
  await expect(page.locator('#moment-timeline')).toContainText('share later');
  await expect(page.locator('#moment-timeline')).toContainText('19.95 is held here as context, not a score.');
  await expect(page.locator('#moment-timeline')).toContainText('Practical money context');
  await expect(page.locator('#guidance')).toBeVisible();
  await expect(page.locator('#guidance')).not.toHaveAttribute('open', '');
  await page.locator('#guidance > summary').click();
  await page.getByRole('button', { name: 'End for today' }).click();
  await expect(page.locator('#guidance')).toBeHidden();

  const accessibilityScan = await new AxeBuilder({ page }).include('main').analyze();
  expect(accessibilityScan.violations).toEqual([]);
});

test('the browser-only starter offers a named add-your-own moment', async ({ page }) => {
  await page.goto('/');
  await skipOnboarding(page);

  await page.getByRole('button', { name: '+ Add your own moment' }).click();
  await expect(page.locator('#moment-kind-label-field')).toBeVisible();
  await page.locator('#moment-form [name="kindLabel"]').fill('A small win');
  await page.locator('#moment-form [name="title"]').fill('We paused before replying');
  await page.getByRole('button', { name: 'Hold this moment' }).click();

  await expect(page.locator('#moment-timeline')).toContainText('A small win');
  await expect(page.locator('#moment-timeline')).toContainText('We paused before replying');
});

test('a selected practical-context currency is shown without inventing one', async ({ page }) => {
  await page.goto('/');
  await skipOnboarding(page);

  await page.getByRole('button', { name: 'Begin' }).click();
  await page.locator('#moment-form [name="title"]').fill('A practical promise');
  await page.locator('#moment-form [name="money"]').fill('2.50');
  await page.locator('#moment-form [name="moneyCurrency"]').selectOption('EUR');
  await page.getByRole('button', { name: 'Hold this moment' }).click();

  await expect(page.locator('#moment-timeline')).toContainText('€2.50 is held here as context, not a score.');
});
