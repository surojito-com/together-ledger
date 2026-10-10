// Sign out everywhere, changing the password, and being signed out by either, on the web (#194).
// The service is faked at its production address; tests/account-sessions.test.js proves the routes.

import { test, expect } from './browser-test.js';

const API = 'https://api.together-ledger.com/api/v1';
const USER = { id: 'user-asha', username: 'asha', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, hasPassword: true };
const SIGNED_OUT = { error: { code: 'authentication_required', message: 'Sign in to continue.' } };
const SIGNED_OUT_EVERYWHERE = 'Signed out on every device, this one included. Sign in again to continue.';
const SIGNED_OUT_HERE = 'This device was signed out. This can happen when the password is changed, when Sign out everywhere is used, or when a sign-in runs out. Sign in again to continue.';

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// A page signed in as `user`, with no journeys yet. Returns what the page sent to the service.
async function signedInPage(page, { user = USER } = {}) {
  const sent = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(API)) return;
    sent.push({ method: request.method(), path: new URL(request.url()).pathname.replace('/api/v1', ''), csrf: request.headers()['x-together-csrf'], body: request.postDataJSON() ?? null });
  });
  await page.route(`${API}/session`, (route) => json(route, { data: { user, csrfToken: 'csrf-1' } }));
  await page.route(`${API}/journeys`, (route) => json(route, { data: { journeys: [] } }));
  await page.goto('/');
  await expect(page.locator('#account-button')).toHaveText('Account settings');
  return sent;
}

async function openAccount(page) {
  await page.locator('#account-button').click();
  await expect(page.locator('#signed-in-account')).toBeVisible();
}

test('Sign out everywhere asks first, in the consequence dialog, and keeps things as they are if not', async ({ page }) => {
  const sent = await signedInPage(page);
  await openAccount(page);
  await page.locator('#logout-everywhere-button').click();
  const dialog = page.locator('#consequence-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#consequence-dialog-title')).toHaveText('Sign out everywhere?');
  await expect(dialog.locator('#consequence-dialog-consequence')).toHaveText('Every device signed in to this account, this one included, will need to sign in again. Nothing in your journeys is deleted.');
  await expect(dialog.locator('#consequence-dialog-accept')).toHaveText('Sign out everywhere');
  // Signing in again undoes it, so it is not drawn as destruction.
  await expect(dialog.locator('#consequence-dialog-accept')).toHaveClass('button primary');
  await expect(dialog.locator('#consequence-dialog-cancel')).toBeFocused();
  await dialog.locator('#consequence-dialog-cancel').click();
  await expect(page.locator('#signed-in-account')).toBeVisible();
  expect(sent.filter((entry) => entry.path === '/auth/logout-everywhere')).toEqual([]);
});

test('Sign out everywhere ends this browser too, and lands on sign in saying so', async ({ page }) => {
  const sent = await signedInPage(page);
  await page.route(`${API}/auth/logout-everywhere`, (route) => route.fulfill({ status: 204 }));
  await openAccount(page);
  await page.locator('#logout-everywhere-button').click();
  await page.locator('#consequence-dialog-accept').click();
  await expect(page.locator('#login-form')).toBeVisible();
  await expect(page.locator('#signed-in-account')).toBeHidden();
  await expect(page.locator('#account-button')).toHaveText('Sign in');
  const status = page.locator('#account-dialog #status-banner');
  await expect(status).toBeVisible();
  await expect(status.locator('#status-banner-message')).toHaveText(SIGNED_OUT_EVERYWHERE);
  await expect(status).toHaveClass(/caution/);
  const asked = sent.filter((entry) => entry.path === '/auth/logout-everywhere');
  expect(asked).toEqual([{ method: 'POST', path: '/auth/logout-everywhere', csrf: 'csrf-1', body: null }]);
});

test('a refused Sign out everywhere says why, and this browser stays signed in', async ({ page }) => {
  await signedInPage(page);
  await page.route(`${API}/auth/logout-everywhere`, (route) => json(route, { error: { code: 'rate_limit_exceeded', message: 'Too many requests. Wait and try again.' } }, 429));
  await openAccount(page);
  await page.locator('#logout-everywhere-button').click();
  await page.locator('#consequence-dialog-accept').click();
  await expect(page.locator('#account-dialog #status-banner-message')).toHaveText('Too many requests. Wait and try again.');
  await expect(page.locator('#signed-in-account')).toBeVisible();
  await expect(page.locator('#logout-everywhere-button')).toBeEnabled();
});

test('a session ended elsewhere takes the person to sign in with why, instead of a half-loaded page', async ({ page }) => {
  await signedInPage(page);
  // Ended on another device: from now on every request with this cookie is refused.
  await page.route(`${API}/journeys`, (route) => json(route, SIGNED_OUT, 401));
  await page.route(`${API}/journeys/*/billing`, (route) => json(route, SIGNED_OUT, 401));
  await openAccount(page);
  await page.locator('#refresh-sync-button').click();
  await expect(page.locator('#login-form')).toBeVisible();
  await expect(page.locator('#signed-in-account')).toBeHidden();
  await expect(page.locator('#account-button')).toHaveText('Sign in');
  const status = page.locator('#account-dialog #status-banner');
  await expect(status.locator('#status-banner-message')).toHaveText(SIGNED_OUT_HERE);
  await expect(status).toHaveClass(/caution/);
  await expect(page.locator('#account-dialog')).not.toContainText('Sign in to continue.');
});

test('a wrong password is never mistaken for being signed out', async ({ page }) => {
  await signedInPage(page);
  await page.route(`${API}/account/password`, (route) => json(route, { error: { code: 'invalid_credentials', message: 'Username, email, or password is incorrect.' } }, 401));
  await openAccount(page);
  const form = page.locator('#change-password-form');
  await form.locator('[name=currentPassword]').fill('not the password at all');
  await form.locator('[name=newPassword]').fill('a different, longer passphrase');
  await form.locator('[name=confirmPassword]').fill('a different, longer passphrase');
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(page.locator('#account-dialog #status-banner-message')).toHaveText('Username, email, or password is incorrect.');
  await expect(page.locator('#signed-in-account')).toBeVisible();
  await expect(page.locator('#account-button')).toHaveText('Account settings');
});

test('Change password sends the current and new password, keeps this browser signed in, and says so', async ({ page }) => {
  const sent = await signedInPage(page);
  await page.route(`${API}/account/password`, (route) => json(route, { data: { user: USER } }));
  await openAccount(page);
  const section = page.locator('#change-password-section');
  await expect(section).toBeVisible();
  await expect(section).toContainText('Changing your password signs out every other device. This one stays signed in, and we email you to say the password changed.');
  const form = page.locator('#change-password-form');
  await form.locator('[name=currentPassword]').fill('correct horse battery staple');
  await form.locator('[name=newPassword]').fill('a different, longer passphrase');
  await form.locator('[name=confirmPassword]').fill('not the same passphrase');
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(page.locator('#account-dialog #status-banner-message')).toHaveText('The new passwords do not match.');
  expect(sent.filter((entry) => entry.path === '/account/password')).toEqual([]);
  await form.locator('[name=confirmPassword]').fill('a different, longer passphrase');
  await form.getByRole('button', { name: 'Change password' }).click();
  await expect(page.locator('#toast')).toHaveText('Password changed. Every other device was signed out, and this one stays signed in.');
  await expect(form.locator('[name=currentPassword]')).toHaveValue('');
  await expect(page.locator('#signed-in-account')).toBeVisible();
  expect(sent.filter((entry) => entry.path === '/account/password')).toEqual([
    { method: 'POST', path: '/account/password', csrf: 'csrf-1', body: { currentPassword: 'correct horse battery staple', newPassword: 'a different, longer passphrase' } },
  ]);
});

test('an account opened with Google or Apple is not offered Change password, and can still sign out everywhere', async ({ page }) => {
  await signedInPage(page, { user: { ...USER, hasPassword: false } });
  await openAccount(page);
  await expect(page.locator('#change-password-section')).toBeHidden();
  await expect(page.locator('#change-password-form input').first()).toBeDisabled();
  await expect(page.locator('#logout-everywhere-button')).toBeVisible();
});
