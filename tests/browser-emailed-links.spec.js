import { test, expect } from './browser-test.js';

// #261: an emailed link carries its one-time code after the #, which no browser sends to a server
// or puts in a Referer. A link sent before that carries it in the query (?verify=, ?recovery=,
// ?invite=), and an invitation lasts 14 days, so the page still reads that shape. Either way the
// code reaches our API only in a body, and is gone from the address before anything else happens.

const API = 'https://api.together-ledger.com/api/v1';
const CODE = 'emailed-one-time-code-abcdefghijklmnop';
const member = { id: 'link-member', username: 'link-member', displayName: 'link-member', email: 'member@example.test', emailVerified: true };

const json = (data, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(status < 400 ? { data } : { error: data }) });

function signedOut(page) {
  return page.route(`${API}/session`, (route) => route.fulfill(json({ code: 'authentication_required', message: 'Sign in to continue.' }, 401)));
}

function signedIn(page) {
  return Promise.all([
    page.route(`${API}/session`, (route) => route.fulfill(json({ user: member, csrfToken: 'csrf-test' }))),
    page.route(`${API}/journeys`, (route) => route.fulfill(json({ journeys: [] }))),
  ]);
}

// Every request the page makes, with its address and Referer, so a code can be looked for in both.
function watchRequests(page) {
  const seen = [];
  // The part after a # never goes on the wire, so it is not part of what a request sends.
  page.on('request', (request) => seen.push({ url: request.url().split('#')[0], referer: request.headers().referer || '' }));
  return seen;
}

// The address bar, and history's own copy of it, carry neither the code nor its key.
async function expectAddressClean(page, key) {
  await expect.poll(() => page.url()).not.toContain(CODE);
  const address = new URL(page.url());
  expect(address.searchParams.has(key)).toBe(false);
  expect(new URLSearchParams(address.hash.slice(1)).has(key)).toBe(false);
  expect(await page.evaluate(() => window.location.href)).not.toContain(CODE);
}

const SHAPES = [
  { name: 'after the #', link: (key) => `/#${key}=${CODE}`, sentToServer: false },
  { name: 'in the query, as a link sent before this change', link: (key) => `/?${key}=${CODE}`, sentToServer: true },
];

for (const shape of SHAPES) {
  test(`a verification link with its code ${shape.name} verifies once and leaves the address`, async ({ page }) => {
    const seen = watchRequests(page);
    await signedOut(page);
    const bodies = [];
    await page.route(`${API}/auth/verify-email`, async (route) => {
      bodies.push(route.request().postDataJSON());
      await route.fulfill(json({ user: member }));
    });

    await page.goto(shape.link('verify'));
    await expect(page.locator('#toast')).toContainText('Email verified.');
    expect(bodies).toEqual([{ token: CODE }]);
    await expectAddressClean(page, 'verify');
    expectCodeOnlyWhereTheShapePutsIt(seen, shape);
  });

  test(`a recovery link with its code ${shape.name} opens the new-password dialog and leaves the address`, async ({ page }) => {
    const seen = watchRequests(page);
    await signedOut(page);

    await page.goto(shape.link('recovery'));
    await expect(page.locator('#recovery-confirm-dialog')).toBeVisible();
    await expect(page.locator('#recovery-confirm-form [name="token"]')).toHaveValue(CODE);
    await expectAddressClean(page, 'recovery');
    expectCodeOnlyWhereTheShapePutsIt(seen, shape);
  });

  test(`an invitation link with its code ${shape.name} is accepted with the code in the body and leaves the address`, async ({ page }) => {
    const seen = watchRequests(page);
    await signedIn(page);
    const accepted = [];
    await page.route(`${API}/invitations/accept`, async (route) => {
      accepted.push(route.request().postDataJSON());
      await route.fulfill(json({ journeyId: 'journey-invited' }));
    });

    await page.goto(shape.link('invite'));
    await expect.poll(() => accepted).toEqual([{ token: CODE }]);
    await expectAddressClean(page, 'invite');
    expectCodeOnlyWhereTheShapePutsIt(seen, shape);
  });
}

test('a signed-out person opening an invitation is asked to sign in, and the code still leaves the address', async ({ page }) => {
  await signedOut(page);
  await page.goto(`/#invite=${CODE}`);
  await expect(page.locator('#account-dialog')).toBeVisible();
  await expect(page.locator('#toast')).toContainText('Sign in with the invited email, then reopen the invitation link.');
  await expectAddressClean(page, 'invite');
});

test('a link pasted into a tab already open on the app is read too, though only the part after the # changed', async ({ page }) => {
  const seen = watchRequests(page);
  await signedOut(page);
  await page.goto('/');
  await expect(page.locator('#recovery-confirm-dialog')).toBeHidden();

  await page.goto(`/#recovery=${CODE}`);
  await expect(page.locator('#recovery-confirm-dialog')).toBeVisible();
  await expect(page.locator('#recovery-confirm-form [name="token"]')).toHaveValue(CODE);
  await expectAddressClean(page, 'recovery');
  expectCodeOnlyWhereTheShapePutsIt(seen, SHAPES[0]);
});

test('taking the code out keeps whatever else the address carries', async ({ page }) => {
  await signedOut(page);
  await page.route(`${API}/auth/verify-email`, (route) => route.fulfill(json({ user: member })));
  await page.goto(`/?keep=1#verify=${CODE}`);
  await expect(page.locator('#toast')).toContainText('Email verified.');
  await expectAddressClean(page, 'verify');
  expect(new URL(page.url()).searchParams.get('keep')).toBe('1');
});

// After the #, the code is in no request's address and no Referer, on any host. In the query it is
// in the first page load, and in the Referer of the page's own first files, which is why links
// moved: nothing the page does can take it back from those.
function expectCodeOnlyWhereTheShapePutsIt(seen, shape) {
  const carrying = seen.filter((request) => request.url.includes(CODE) || request.referer.includes(CODE));
  if (!shape.sentToServer) {
    expect(carrying).toEqual([]);
    return;
  }
  expect(carrying.length).toBeGreaterThan(0);
  for (const request of carrying) {
    expect(new URL(request.url).hostname).toBe('127.0.0.1');
  }
}

// #266: an invitation's link has its own path, /invite, so the phone app can claim that link and
// nothing else. On the web it is the same page, the code still after the #, and the address goes
// back to the app's home once the code is taken.
test('an invitation link at /invite is accepted with the code in the body, and the address returns home', async ({ page }) => {
  const seen = watchRequests(page);
  await signedIn(page);
  const accepted = [];
  await page.route(`${API}/invitations/accept`, async (route) => {
    accepted.push(route.request().postDataJSON());
    await route.fulfill(json({ journeyId: 'journey-invited' }));
  });

  await page.goto(`/invite#invite=${CODE}`);
  await expect.poll(() => accepted).toEqual([{ token: CODE }]);
  await expectAddressClean(page, 'invite');
  expect(new URL(page.url()).pathname).toBe('/');
  expectCodeOnlyWhereTheShapePutsIt(seen, SHAPES[0]);
  // Its files load from the app's own folder, as at /.
  expect(seen.some((request) => new URL(request.url).pathname === '/src/app.js')).toBe(true);
});

test('a signed-out person opening an invitation at /invite is asked to sign in, and the code still leaves the address', async ({ page }) => {
  await signedOut(page);
  await page.goto(`/invite#invite=${CODE}`);
  await expect(page.locator('#account-dialog')).toBeVisible();
  await expect(page.locator('#toast')).toContainText('Sign in with the invited email, then reopen the invitation link.');
  await expectAddressClean(page, 'invite');
  expect(new URL(page.url()).pathname).toBe('/');
});

test('a verification link is never moved to /invite, and /invite with no code is left as it is', async ({ page }) => {
  await signedOut(page);
  await page.route(`${API}/auth/verify-email`, (route) => route.fulfill(json({ user: member })));
  await page.goto(`/#verify=${CODE}`);
  await expect(page.locator('#toast')).toContainText('Email verified.');
  expect(new URL(page.url()).pathname).toBe('/');
  await page.goto('/invite');
  await expect(page.locator('#welcome-title')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/invite');
});
