import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { loadConfig } from '../server/config.js';

// Where a development build of the phone sends its requests when nothing tells it otherwise (#283).
// It has to be the API server, not the static web server beside it, which answers every path with
// index.html and has no /api/v1.

const root = new URL('../', import.meta.url);
const mobile = new URL('apps/mobile/', root);

// The phone's own TypeScript, compiled on the spot, so the test exercises the code the app runs.
const source = await readFile(new URL('src/config/api.ts', mobile), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { apiOrigin, apiBase } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const apiPort = loadConfig({ PORT: undefined }).PORT;
const staticPort = Number((await readFile(new URL('scripts/dev.mjs', root), 'utf8')).match(/Number\(process\.env\.PORT\) \|\| (\d+)/)[1]);

function withEnvironment({ dev, origin }, run) {
  const saved = { dev: globalThis.__DEV__, origin: process.env.EXPO_PUBLIC_API_ORIGIN };
  globalThis.__DEV__ = dev;
  if (origin === undefined) delete process.env.EXPO_PUBLIC_API_ORIGIN;
  else process.env.EXPO_PUBLIC_API_ORIGIN = origin;
  try {
    return run();
  } finally {
    globalThis.__DEV__ = saved.dev;
    if (saved.origin === undefined) delete process.env.EXPO_PUBLIC_API_ORIGIN;
    else process.env.EXPO_PUBLIC_API_ORIGIN = saved.origin;
  }
}

test('the API and the static web server listen on different ports', () => {
  assert.equal(apiPort, 4174, 'server/config.js');
  assert.equal(staticPort, 4173, 'scripts/dev.mjs');
});

test('a development build with no origin set talks to the API server, not the static one', () => {
  withEnvironment({ dev: true, origin: undefined }, () => {
    assert.equal(new URL(apiOrigin()).port, String(apiPort));
    assert.equal(apiBase(), `http://localhost:${apiPort}/api/v1`);
  });
});

test('apps/mobile/.env.example points a local phone at the API server too', async () => {
  const example = await readFile(new URL('.env.example', mobile), 'utf8');
  const value = example.match(/^EXPO_PUBLIC_API_ORIGIN=(.+)$/m)[1].trim();
  assert.equal(new URL(value).port, String(apiPort));
  withEnvironment({ dev: true, origin: value }, () => assert.equal(apiOrigin(), value));
});

test('every other build is given its origin, and never falls back to a local one', async () => {
  withEnvironment({ dev: false, origin: undefined }, () => {
    assert.throws(() => apiOrigin(), /EXPO_PUBLIC_API_ORIGIN is not set/);
  });
  const eas = JSON.parse(await readFile(new URL('eas.json', mobile), 'utf8'));
  for (const profile of ['preview', 'production']) {
    assert.equal(eas.build[profile].env.EXPO_PUBLIC_API_ORIGIN, 'https://api.together-ledger.com', `${profile} supplies its own origin`);
  }
  withEnvironment({ dev: false, origin: 'https://api.together-ledger.com/' }, () => {
    assert.equal(apiOrigin(), 'https://api.together-ledger.com');
  });
});
