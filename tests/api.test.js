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
