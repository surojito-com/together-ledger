import test from 'node:test';
import assert from 'node:assert/strict';
import { TogetherApi } from '../src/api.js';

function withBrowser({ hostname, apiOrigin = '', accountsEnabled = false }, run) {
  const originalLocation = globalThis.location;
  const originalDocument = globalThis.document;
  globalThis.location = new URL(`https://${hostname}/`);
  globalThis.document = {
    querySelector: (selector) => {
      if (selector === 'meta[name="together-api-origin"]') return { content: apiOrigin };
      if (selector === 'meta[name="together-accounts-enabled"]') return { content: String(accountsEnabled) };
      return null;
    },
  };
  try {
    run();
  } finally {
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
}

test('a hosted API page enables its same-origin private account service', () => {
  withBrowser({ hostname: 'preview.example.test', accountsEnabled: true }, () => {
    const api = new TogetherApi();
    assert.equal(api.accountsAvailable, true);
    assert.equal(api.base, '/api/v1');
    assert.equal(api.crossOrigin, false);
  });
});

test('an unrelated public host does not enable accounts without an API origin', () => {
  withBrowser({ hostname: 'together-ledger.com' }, () => {
    const api = new TogetherApi();
    assert.equal(api.accountsAvailable, false);
  });
});

function withFetch(responses, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init.body });
    const { status, body } = responses.shift();
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return run(calls).finally(() => { globalThis.fetch = original; });
}

test('accepting an invitation sends the token in the body, never in the address', async () => {
  await withFetch([{ status: 200, body: { data: { journeyId: 'j1' } } }], async (calls) => {
    assert.deepEqual(await new TogetherApi('/api/v1').acceptInvitation('secret-token'), { journeyId: 'j1' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/v1/invitations/accept');
    assert.equal(calls[0].url.includes('secret-token'), false);
    assert.deepEqual(JSON.parse(calls[0].body), { token: 'secret-token' });
  });
});

test('an API that predates the body route falls back to the path form, once', async () => {
  const routeMissing = { status: 404, body: { message: 'Route POST:/api/v1/invitations/accept not found', error: 'Not Found', statusCode: 404 } };
  await withFetch([routeMissing, { status: 200, body: { data: { journeyId: 'j1' } } }], async (calls) => {
    assert.deepEqual(await new TogetherApi('/api/v1').acceptInvitation('secret-token'), { journeyId: 'j1' });
    assert.deepEqual(calls.map((call) => call.url), ['/api/v1/invitations/accept', '/api/v1/invitations/secret-token/accept']);
  });
});

test('a real invitation error is shown, not retried on the older route', async () => {
  const invalid = { status: 400, body: { error: { code: 'invalid_invitation', message: 'This invitation is invalid, expired, or belongs to another email address.' } } };
  await withFetch([invalid], async (calls) => {
    await assert.rejects(new TogetherApi('/api/v1').acceptInvitation('secret-token'), { code: 'invalid_invitation', status: 400 });
    assert.equal(calls.length, 1);
  });
});

// #194: the page is told once when the service refuses the session it is signed in with, and never
// for a wrong password, for a visitor who never signed in, or for a session it has already left.
test('a refused session is noticed once, only for the session the request was sent with', async (t) => {
  const answers = [];
  t.mock.method(globalThis, 'fetch', async () => {
    const [status, body] = answers.shift();
    return { ok: status < 300, status, json: async () => body };
  });
  const refused = [401, { error: { code: 'authentication_required', message: 'Sign in to continue.' } }];
  const api = new TogetherApi('/api/v1');
  let told = 0;
  api.onSignedOut = () => { told += 1; };

  // Not signed in: a refusal is just that.
  answers.push(refused);
  await assert.rejects(api.request('/session'), (error) => error.sessionEnded === false);
  assert.equal(told, 0);

  // Signed in: a wrong password is not being signed out.
  api.csrfToken = 'csrf-1';
  answers.push([401, { error: { code: 'invalid_credentials', message: 'Username, email, or password is incorrect.' } }]);
  await assert.rejects(api.changePassword('wrong', 'a new long passphrase'), (error) => error.sessionEnded === false);
  assert.equal(told, 0);
  assert.equal(api.csrfToken, 'csrf-1');

  // Two requests refused together: both say so, the page is told once.
  answers.push(refused, refused);
  const results = await Promise.allSettled([api.request('/journeys'), api.request('/journeys/j1/snapshot')]);
  assert.ok(results.every((result) => result.reason.sessionEnded === true));
  assert.equal(told, 1);
  assert.equal(api.csrfToken, '');

  // A refusal arriving after the page signed in again ends nothing.
  api.csrfToken = 'csrf-old';
  answers.push(refused);
  const late = api.request('/journeys');
  api.csrfToken = 'csrf-new';
  await assert.rejects(late, (error) => error.sessionEnded === true);
  assert.equal(api.csrfToken, 'csrf-new');
  assert.equal(told, 1);
});
