// Continue with Google and Continue with Apple on the web (#216).
//
// Google's and Apple's own scripts are replaced here by small stand-ins served at the same
// addresses, so the page loads them exactly as it would in production and no request leaves the
// machine. The stand-ins do only what the page relies on: Google Identity Services' initialize()
// and renderButton(), which draws a 40px button as Google's does, and Sign in with Apple JS's
// init() and signIn(). A test answers for the provider by calling the callback the page gave
// Google, or by deciding what Apple's signIn() resolves to.

import AxeBuilder from '@axe-core/playwright';
import { test, expect } from './browser-test.js';

const API = 'https://api.together-ledger.com/api/v1';
const GOOGLE_SCRIPT = 'https://accounts.google.com/gsi/client';
const APPLE_SCRIPT = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
const GOOGLE_CLIENT = 'test-web-client.apps.googleusercontent.com';
const APPLE_SERVICES_ID = 'com.togetherledger.ledger.web';
const USER = { id: 'user-social', username: 'journeyer-1a2b3c4d', displayName: 'Asha Rao', email: 'asha@example.test', emailVerified: true, hasPassword: false };

const GOOGLE_STAND_IN = `
window.google = { accounts: { id: {
  initialize(config) { window.__google = config; },
  renderButton(element, options) {
    window.__googleRenders = (window.__googleRenders || 0) + 1;
    window.__googleOptions = options;
    const button = document.createElement('div');
    button.setAttribute('role', 'button');
    button.tabIndex = 0;
    button.textContent = 'Continue with Google';
    button.style.cssText = 'align-items:center;background:#fff;border:1px solid #747775;border-radius:20px;box-sizing:border-box;color:#1f1f1f;display:flex;font:500 14px Arial,sans-serif;height:40px;justify-content:center;width:' + options.width + 'px';
    element.replaceChildren(button);
  },
} } };`;

const APPLE_STAND_IN = `
window.AppleID = { auth: {
  init(config) { window.__apple = config; },
  signIn() {
    window.__appleSignIns = (window.__appleSignIns || 0) + 1;
    return window.__appleAnswer ? window.__appleAnswer(window.__apple) : Promise.reject({ error: 'popup_closed_by_user' });
  },
} };`;

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// A signed-out visitor on a server where both sign-ins are configured, unless `providers` says
// otherwise. Returns the provider script requests and the bodies sent to our sign-in routes.
async function signedOutPage(page, baseURL, { providers } = {}) {
  const seen = { scripts: [], signIns: [] };
  const origin = new URL(baseURL).origin;
  await page.route(`${API}/session`, (route) => json(route, { error: { code: 'authentication_required', message: 'Sign in to continue.' } }, 401));
  await page.route(`${API}/auth/providers`, (route) => json(route, { data: providers ?? { google: { clientId: GOOGLE_CLIENT }, apple: { clientId: APPLE_SERVICES_ID, redirectUri: `${origin}/` } } }));
  await page.route(`${API}/journeys`, (route) => json(route, { data: { journeys: [] } }));
  await page.route(GOOGLE_SCRIPT, (route) => { seen.scripts.push('google'); return route.fulfill({ contentType: 'text/javascript', body: GOOGLE_STAND_IN }); });
  await page.route(APPLE_SCRIPT, (route) => { seen.scripts.push('apple'); return route.fulfill({ contentType: 'text/javascript', body: APPLE_STAND_IN }); });
  return seen;
}

async function openSignIn(page) {
  // Reaching Sign in through the header is covered elsewhere; this is about the dialog it opens.
  await page.locator('[data-open-account]').first().dispatchEvent('click');
  await expect(page.locator('#account-dialog')).toBeVisible();
}

const googleButton = (page) => page.locator('#google-sign-in-button [role="button"]');
const appleButton = (page) => page.locator('#apple-sign-in-button');

// Lets the page finish whatever it started when the dialog opened, so "still hidden" means hidden.
const settle = (page) => page.evaluate(() => new Promise((resolve) => { setTimeout(resolve, 250); }));

const NOT_READY = [
  { name: 'nothing is configured', providers: () => ({ google: null, apple: null }) },
  { name: 'only Apple is configured', providers: (origin) => ({ google: null, apple: { clientId: APPLE_SERVICES_ID, redirectUri: `${origin}/` } }) },
  { name: 'only Google is configured', providers: () => ({ google: { clientId: GOOGLE_CLIENT }, apple: null }) },
  // Apple answers only at its Return URL's own address, so on any other its button can't finish.
  { name: 'Apple returns to another address', providers: () => ({ google: { clientId: GOOGLE_CLIENT }, apple: { clientId: APPLE_SERVICES_ID, redirectUri: 'https://app.together-ledger.com/' } }) },
];

for (const { name, providers } of NOT_READY) {
  test(`neither button shows, and neither company is contacted, when ${name}`, async ({ page, baseURL }) => {
    const seen = await signedOutPage(page, baseURL, { providers: providers(new URL(baseURL).origin) });
    await page.goto('/');
    const asked = page.waitForRequest(`${API}/auth/providers`);
    await openSignIn(page);
    await asked;
    await settle(page);
    await expect(page.locator('#login-form')).toBeVisible();
    await expect(page.locator('#social-sign-in')).toBeHidden();
    expect(seen.scripts).toEqual([]);
  });
}

test('neither button shows when the server can\'t be asked, and nothing is said about it', async ({ page, baseURL }) => {
  const seen = await signedOutPage(page, baseURL);
  await page.route(`${API}/auth/providers`, (route) => route.abort('internetdisconnected'));
  await page.goto('/');
  const asked = page.waitForRequest(`${API}/auth/providers`);
  await openSignIn(page);
  await asked;
  await settle(page);
  await expect(page.locator('#social-sign-in')).toBeHidden();
  await expect(page.locator('#status-banner')).toBeHidden();
  expect(seen.scripts).toEqual([]);
});

test('neither button shows when a provider\'s script can\'t be loaded', async ({ page, baseURL }) => {
  await signedOutPage(page, baseURL);
  await page.route(APPLE_SCRIPT, (route) => route.abort('internetdisconnected'));
  await page.goto('/');
  const asked = page.waitForRequest(APPLE_SCRIPT);
  await openSignIn(page);
  await asked;
  await settle(page);
  await expect(page.locator('#social-sign-in')).toBeHidden();
  await expect(page.locator('#status-banner')).toBeHidden();
});

test('the providers are asked only once a signed-out person opens the dialog', async ({ page, baseURL }) => {
  const seen = await signedOutPage(page, baseURL);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  expect(seen.scripts).toEqual([]);
  await openSignIn(page);
  await expect(googleButton(page)).toBeVisible();
  expect(seen.scripts.sort()).toEqual(['apple', 'google']);
  await expect(page.locator('script[src^="https://accounts.google.com/gsi/client"]')).toHaveCount(1);
  await expect(page.locator(`script[src="${APPLE_SCRIPT}"]`)).toHaveCount(1);
  expect(await page.evaluate(() => ({ client: window.__google.client_id, mode: window.__google.ux_mode }))).toEqual({ client: GOOGLE_CLIENT, mode: 'popup' });
  const apple = await page.evaluate(() => window.__apple);
  expect(apple).toMatchObject({ clientId: APPLE_SERVICES_ID, redirectURI: `${new URL(baseURL).origin}/`, scope: 'name email', usePopup: true });
  expect(apple.state).toMatch(/^[0-9a-f-]{36}$/);
});

test('both buttons are the same size, at least 44px, side by side or stacked, in every theme', async ({ page, baseURL }) => {
  await signedOutPage(page, baseURL);
  for (const viewport of [{ width: 1280, height: 900 }, { width: 320, height: 640 }]) {
    await page.setViewportSize(viewport);
    for (const theme of ['light', 'dark', 'green', 'flexoki']) {
      await page.goto('/');
      await page.evaluate((id) => window.applyTogetherTheme(id), theme);
      await openSignIn(page);
      await expect(googleButton(page)).toBeVisible();
      const label = `${theme} at ${viewport.width}px`;
      const google = await googleButton(page).boundingBox();
      const apple = await appleButton(page).boundingBox();
      expect(apple.height, `${label}: Apple height`).toBeGreaterThanOrEqual(44);
      expect(Math.abs(google.height - apple.height), `${label}: equal heights`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(google.width - apple.width), `${label}: equal widths`).toBeLessThanOrEqual(2);
      if (viewport.width === 320) expect(apple.y, `${label}: stacked`).toBeGreaterThan(google.y);
      else expect(Math.abs(apple.y - google.y), `${label}: side by side`).toBeLessThanOrEqual(0.5);
      // Above the forms, so Apple is never below the fold when Google isn't.
      expect(apple.y, `${label}: above the sign-in form`).toBeLessThan((await page.locator('#login-form').boundingBox()).y);

      // Apple's button in one of the colours Apple allows, with its title in the other.
      const painted = await appleButton(page).evaluate((element) => {
        const style = getComputedStyle(element);
        const root = getComputedStyle(document.documentElement);
        return {
          background: style.backgroundColor, color: style.color, border: style.borderTopColor, height: style.height,
          tokens: ['--apple-button-bg', '--apple-button-fg', '--apple-button-outline'].map((token) => root.getPropertyValue(token).trim()),
        };
      });
      expect(painted.background, label).toBe('rgb(255, 255, 255)');
      expect(painted.color, label).toBe('rgb(0, 0, 0)');
      const outlined = theme === 'light' || theme === 'flexoki';
      expect(painted.border, label).toBe(outlined ? 'rgb(0, 0, 0)' : 'rgba(0, 0, 0, 0)');
      expect(painted.tokens, label).toEqual(['#FFFFFF', '#000000', outlined ? '#000000' : 'transparent']);
      await expect(appleButton(page)).toHaveText('Continue with Apple');
      expect(await page.evaluate(() => window.__googleOptions)).toMatchObject({ text: 'continue_with', size: 'large', shape: 'pill', theme: 'outline' });
    }
  }
  const scan = await new AxeBuilder({ page }).include('#account-dialog').analyze();
  expect(scan.violations).toEqual([]);
});

test('Continue with Google signs in with the same cookie and CSRF pair as a password, and stores nothing', async ({ page, baseURL }) => {
  await signedOutPage(page, baseURL);
  let sent = null;
  let logoutCsrf = null;
  await page.route(`${API}/auth/google`, (route) => {
    sent = route.request().postDataJSON();
    return json(route, { data: { user: USER, csrfToken: 'csrf-google' } });
  });
  await page.route(`${API}/auth/logout`, (route) => {
    logoutCsrf = route.request().headers()['x-together-csrf'];
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  await openSignIn(page);
  await expect(googleButton(page)).toBeVisible();

  await page.evaluate(() => window.__google.callback({ credential: 'google-id-token' }));
  await expect(page.locator('#account-dialog')).toBeHidden();
  expect(sent).toEqual({ idToken: 'google-id-token' });
  await expect(page.locator('#account-button')).toHaveText('Account settings');
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain('google-id-token');
  expect(stored).not.toContain('csrf-google');

  // An account opened with Google has no password, so deleting it asks only for DELETE.
  await page.locator('#account-button').click();
  await expect(page.locator('#delete-account-password')).toBeHidden();
  await expect(page.locator('#delete-account-form [name="confirmation"]')).toBeVisible();

  // And the CSRF token the sign-in returned is the one the next change carries.
  await page.locator('#logout-button').click();
  await expect(page.locator('#account-button')).toHaveText('Sign in');
  expect(logoutCsrf).toBe('csrf-google');
});

test('closing Apple\'s window puts the person back where they were, with nothing said', async ({ page, baseURL }) => {
  await signedOutPage(page, baseURL);
  const calls = [];
  await page.route(`${API}/auth/apple`, (route) => { calls.push(route.request().postDataJSON()); return json(route, { data: { user: USER, csrfToken: 'csrf-apple' } }); });
  await page.goto('/');
  await openSignIn(page);
  await expect(appleButton(page)).toBeVisible();

  for (const error of ['popup_closed_by_user', 'user_cancelled_authorize']) {
    await page.evaluate((code) => { window.__appleAnswer = () => Promise.reject({ error: code }); }, error);
    await appleButton(page).click();
    await expect.poll(() => page.evaluate(() => window.__appleSignIns)).toBeGreaterThan(0);
    await expect(page.locator('#status-banner')).toBeHidden();
    await expect(page.locator('#account-dialog')).toBeVisible();
    await expect(appleButton(page)).toBeEnabled();
  }
  expect(calls).toEqual([]);

  // Anything else Apple answers is said in the account service's own words.
  await page.evaluate(() => { window.__appleAnswer = () => Promise.reject({ error: 'popup_blocked_by_browser' }); });
  await appleButton(page).click();
  await expect(page.locator('#account-dialog #status-banner')).toContainText('The account service could not complete that request.');

  // An answer that isn't for this page's request is refused the same way, and never sent on.
  await page.evaluate(() => { window.__appleAnswer = () => Promise.resolve({ authorization: { state: 'someone-elses', code: 'c', id_token: 't' } }); });
  await appleButton(page).click();
  await expect(page.locator('#account-dialog #status-banner')).toContainText('The account service could not complete that request.');
  expect(calls).toEqual([]);
});

test('Continue with Apple sends the token, the one-time code and the first sign-in\'s name', async ({ page, baseURL }) => {
  await signedOutPage(page, baseURL);
  let sent = null;
  await page.route(`${API}/auth/apple`, (route) => { sent = route.request().postDataJSON(); return json(route, { data: { user: USER, csrfToken: 'csrf-apple' } }); });
  await page.goto('/');
  await openSignIn(page);
  await page.evaluate(() => {
    window.__appleAnswer = (config) => Promise.resolve({
      authorization: { state: config.state, code: 'apple-code', id_token: 'apple-id-token' },
      user: { email: 'asha@example.test', name: { firstName: 'Asha', lastName: 'Rao' } },
    });
  });
  await appleButton(page).click();
  await expect(page.locator('#account-dialog')).toBeHidden();
  expect(sent).toEqual({ idToken: 'apple-id-token', authorizationCode: 'apple-code', displayName: 'Asha Rao' });
  await expect(page.locator('#account-button')).toHaveText('Account settings');
});

test('an email that already has a password account asks for that password once, then links', async ({ page, baseURL }) => {
  await signedOutPage(page, baseURL);
  const message = 'You already have an account with this email. Enter its password once to connect it.';
  let linked = null;
  await page.route(`${API}/auth/apple`, (route) => json(route, { error: { code: 'link_required', message, details: { email: 'asha@example.test' } } }, 409));
  await page.route(`${API}/auth/link`, (route) => {
    linked = route.request().postDataJSON();
    if (linked.password !== 'right-password1') return json(route, { error: { code: 'invalid_credentials', message: 'Username, email, or password is incorrect.' } }, 401);
    return json(route, { data: { user: { ...USER, hasPassword: true }, csrfToken: 'csrf-linked' } });
  });
  await page.goto('/');
  await openSignIn(page);
  await page.evaluate(() => {
    window.__appleAnswer = (config) => Promise.resolve({ authorization: { state: config.state, code: 'apple-code', id_token: 'apple-id-token' } });
  });
  await appleButton(page).click();

  // The server's own words, in the dialog, and the password asked for right there.
  await expect(page.locator('#account-dialog #status-banner')).toContainText(message);
  const form = page.locator('#link-identity-form');
  await expect(form).toBeVisible();
  await expect(page.locator('#link-identity-title')).toHaveText('Connect Apple to your account');
  await expect(page.locator('#link-identity-email')).toHaveText('asha@example.test');
  await expect(form.locator('[name="password"]')).toBeFocused();

  await form.locator('[name="password"]').fill('wrong-password1');
  await form.getByRole('button', { name: 'Connect and sign in' }).click();
  await expect(page.locator('#account-dialog #status-banner')).toContainText('Username, email, or password is incorrect.');
  await expect(form).toBeVisible();

  await form.locator('[name="password"]').fill('right-password1');
  await form.getByRole('button', { name: 'Connect and sign in' }).click();
  await expect(page.locator('#account-dialog')).toBeHidden();
  expect(linked).toEqual({ provider: 'apple', idToken: 'apple-id-token', authorizationCode: 'apple-code', password: 'right-password1' });
  await expect(page.locator('#account-button')).toHaveText('Account settings');
  // A linked account keeps its password, so deleting it still asks for one.
  await page.locator('#account-button').click();
  await expect(page.locator('#delete-account-password')).toBeVisible();
});

test('an email held by an account without a password is refused in the server\'s words, and Not now forgets the sign-in', async ({ page, baseURL }) => {
  await signedOutPage(page, baseURL);
  let answer = { error: { code: 'email_in_use', message: 'An account already uses this email. Sign in the way you did before.' } };
  await page.route(`${API}/auth/google`, (route) => json(route, answer, 409));
  await page.goto('/');
  await openSignIn(page);
  await expect(googleButton(page)).toBeVisible();

  await page.evaluate(() => window.__google.callback({ credential: 'google-id-token' }));
  await expect(page.locator('#account-dialog #status-banner')).toContainText('An account already uses this email. Sign in the way you did before.');
  await expect(page.locator('#link-identity-form')).toBeHidden();

  answer = { error: { code: 'link_required', message: 'You already have an account with this email. Enter its password once to connect it.', details: { email: 'asha@example.test' } } };
  await page.evaluate(() => window.__google.callback({ credential: 'google-id-token' }));
  await expect(page.locator('#link-identity-form')).toBeVisible();
  await expect(page.locator('#link-identity-title')).toHaveText('Connect Google to your account');
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.locator('#link-identity-form')).toBeHidden();
  await expect(page.locator('#status-banner')).toBeHidden();
  await expect(page.locator('#account-dialog')).toBeVisible();
});

// An Apple account that shared no usable email holds a placeholder made from its own id. Account
// settings says so in words, not with an address that is nobody's (#217). A real address shows as is.
test('an Apple account with no email says so in Account settings, instead of its placeholder', async ({ page, baseURL }) => {
  await signedOutPage(page, baseURL);
  const placeholder = 'apple-0f9e8d7c-1234-4abc-9def-001122334455@no-email.invalid';
  await page.route(`${API}/auth/apple`, (route) => json(route, { data: { user: { ...USER, email: placeholder, emailVerified: false }, csrfToken: 'csrf-apple' } }));
  await page.goto('/');
  await openSignIn(page);
  await page.evaluate(() => {
    window.__appleAnswer = (config) => Promise.resolve({ authorization: { state: config.state, code: 'apple-code', id_token: 'apple-id-token' } });
  });
  await appleButton(page).click();
  await expect(page.locator('#account-dialog')).toBeHidden();
  await page.locator('#account-button').click();
  await expect(page.locator('#account-email')).toHaveText('Apple didn’t share an email address.');
  await expect(page.locator('#account-dialog')).not.toContainText('no-email.invalid');
});
