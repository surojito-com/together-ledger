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
