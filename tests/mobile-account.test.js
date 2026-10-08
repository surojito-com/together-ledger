import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const mobile = new URL('../apps/mobile/', import.meta.url);

// The phone's own TypeScript, compiled on the spot, so these tests exercise the code the app runs.
export async function importMobile(path) {
  const source = await readFile(new URL(path, mobile), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

const { createAccountClient, OFFLINE_MESSAGE, UNAVAILABLE_MESSAGE } = await importMobile('src/api/client.ts');
const { accountMessage, ACCOUNT_FALLBACK_MESSAGE, NO_ROOM_ADDED_HERE } = await importMobile('src/auth/account-messages.ts');

function memoryTokens(initial = null) {
  let held = initial;
  return { read: async () => held, write: async (tokens) => { held = tokens; }, clear: async () => { held = null; }, get held() { return held; } };
}

const pair = (n) => ({ token: `access-${n}`, tokenExpiresAt: '2026-10-01T00:00:00.000Z', refreshToken: `refresh-${n}`, refreshTokenExpiresAt: '2026-10-30T00:00:00.000Z' });
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('every request says it is the app, and only a signed-in request carries a token', async () => {
  const calls = [];
  const tokens = memoryTokens(pair(1));
  const client = createAccountClient({ base: () => 'https://api.example.test/api/v1', tokens, fetch: async (url, init) => { calls.push({ url, init }); return reply(200, { data: { user: { id: 'u1' } } }); } });
  await client.requestRecovery('someone@example.test');
  await client.session();
  assert.equal(calls[0].init.headers['x-together-client'], 'app');
  assert.equal(calls[0].init.headers.Authorization, undefined, 'recovery never sends a token');
  assert.equal(calls[1].url, 'https://api.example.test/api/v1/session');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer access-1');
});

test('an expired access token is refreshed once, the new pair is kept, and the request retried', async () => {
  const tokens = memoryTokens(pair(1));
  const seen = [];
  const client = createAccountClient({ base: () => '/api/v1', tokens, fetch: async (url, init) => {
    seen.push(`${url} ${init.headers.Authorization || ''}`.trim());
    if (url.endsWith('/auth/refresh')) return reply(200, { data: { user: { id: 'u1' }, ...pair(2) } });
    return init.headers.Authorization === 'Bearer access-2' ? reply(200, { data: { user: { id: 'u1' } } }) : reply(401, { error: { code: 'authentication_required', message: 'Sign in to continue.' } });
  } });
  assert.deepEqual(await client.session(), { id: 'u1' });
  assert.deepEqual(seen, ['/api/v1/session Bearer access-1', '/api/v1/auth/refresh', '/api/v1/session Bearer access-2']);
  assert.equal(tokens.held.refreshToken, 'refresh-2', 'the rotated refresh token replaces the spent one');
});

test('two requests that expire together spend the refresh token only once', async () => {
  const tokens = memoryTokens(pair(1));
  let refreshes = 0;
  const client = createAccountClient({ base: () => '/api/v1', tokens, fetch: async (url, init) => {
    if (url.endsWith('/auth/refresh')) { refreshes += 1; return reply(200, { data: { user: { id: 'u1' }, ...pair(2) } }); }
    return init.headers.Authorization === 'Bearer access-2' ? reply(200, { data: { user: { id: 'u1' }, delivered: true } }) : reply(401, { error: { code: 'authentication_required', message: 'Sign in to continue.' } });
  } });
  await Promise.all([client.session(), client.resendVerification()]);
  assert.equal(refreshes, 1);
});

test('a refused refresh forgets the tokens and asks the person to sign in again', async () => {
  const tokens = memoryTokens(pair(1));
  const client = createAccountClient({ base: () => '/api/v1', tokens, fetch: async (url) => (url.endsWith('/auth/refresh') ? reply(200, { data: null }) : reply(401, { error: { code: 'authentication_required', message: 'Sign in to continue.' } })) });
  await assert.rejects(client.session(), { code: 'authentication_required', status: 401 });
  assert.equal(tokens.held, null);
});

test('offline and "no service in this build" stay two different messages, in the web\'s words', async () => {
  const offline = createAccountClient({ base: () => '/api/v1', tokens: memoryTokens(), fetch: async () => { throw new TypeError('Network request failed'); } });
  await assert.rejects(offline.requestRecovery('a@example.test'), { code: 'offline', message: OFFLINE_MESSAGE });
  const unconfigured = createAccountClient({ base: () => { throw new Error('EXPO_PUBLIC_API_ORIGIN is not set.'); }, tokens: memoryTokens(), fetch: async () => reply(200, {}) });
  await assert.rejects(unconfigured.requestRecovery('a@example.test'), { code: 'accounts_unavailable', message: UNAVAILABLE_MESSAGE });
  const webApi = await readFile(new URL('../src/api.js', import.meta.url), 'utf8');
  assert.ok(webApi.includes(`'${OFFLINE_MESSAGE}'`) && webApi.includes(`'${UNAVAILABLE_MESSAGE}'`), 'the phone uses the web client\'s exact words');
});

test('an offline refresh keeps the tokens, so a network drop never signs anyone out', async () => {
  const tokens = memoryTokens(pair(1));
  const client = createAccountClient({ base: () => '/api/v1', tokens, fetch: async (url) => { if (url.endsWith('/auth/refresh')) throw new TypeError('offline'); return reply(401, { error: { code: 'authentication_required', message: 'Sign in to continue.' } }); } });
  await assert.rejects(client.session(), { code: 'offline' });
  assert.equal(tokens.held.refreshToken, 'refresh-1');
});

test('a wrong password is shown as it is, without spending the refresh token', async () => {
  const tokens = memoryTokens(pair(1));
  const seen = [];
  const client = createAccountClient({ base: () => '/api/v1', tokens, fetch: async (url) => {
    seen.push(url);
    return reply(401, { error: { code: 'invalid_credentials', message: 'Password confirmation failed.' } });
  } });
  await assert.rejects(client.deleteAccount('wrong'), { code: 'invalid_credentials', message: 'Password confirmation failed.' });
  assert.deepEqual(seen, ['/api/v1/account']);
  assert.equal(tokens.held.refreshToken, 'refresh-1');
});

test('signing out forgets this phone\'s tokens even when the service cannot be told', async () => {
  const tokens = memoryTokens(pair(1));
  const client = createAccountClient({ base: () => '/api/v1', tokens, fetch: async () => { throw new TypeError('offline'); } });
  await assert.rejects(client.logout(), { code: 'offline' });
  assert.equal(tokens.held, null);
});

test('accountMessage shows the service\'s own words, and the web\'s fallback otherwise', async () => {
  assert.equal(accountMessage({ code: 'invalid_credentials', message: 'Password confirmation failed.' }), 'Password confirmation failed.');
  assert.equal(accountMessage(new Error('boom')), ACCOUNT_FALLBACK_MESSAGE);
  const web = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.ok(web.includes(`return '${ACCOUNT_FALLBACK_MESSAGE}';`));
  const notices = await readFile(new URL('src/auth/account-messages.ts', mobile), 'utf8');
  // The phone's words for a moment with no room are its own on purpose: the web's point at a
  // payment the app does not offer (#268). Everything else is the web's.
  const phoneOnly = new Set(Object.values(NO_ROOM_ADDED_HERE));
  for (const phrase of [...notices.matchAll(/:\s*'([^']+)',/g)].map((match) => match[1]).filter((phrase) => !phoneOnly.has(phrase))) {
    assert.ok(web.includes(phrase), `"${phrase}" is not the web's wording`);
  }
});

test('tokens live in the keychain, never in plain storage, and never move to another phone', async () => {
  const storage = await readFile(new URL('src/auth/token-storage.ts', mobile), 'utf8');
  assert.match(storage, /from 'expo-secure-store'/);
  assert.match(storage, /WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
  const everything = await Promise.all(['src/auth/session.tsx', 'src/api/client.ts', 'src/auth/token-storage.ts'].map((file) => readFile(new URL(file, mobile), 'utf8')));
  assert.doesNotMatch(everything.join('\n'), /from '@react-native-async-storage|localStorage\.|AsyncStorage\./);
});

test('account deletion is three taps from settings, and says what goes and what stays', async () => {
  const settings = await readFile(new URL('app/settings.tsx', mobile), 'utf8');
  const remove = await readFile(new URL('app/delete-account.tsx', mobile), 'utf8');
  assert.match(settings, /label="Delete account" onPress=\{\(\) => router\.push\('\/delete-account'\)\}/, 'tap 1: settings opens the deletion screen');
  assert.match(remove, /label="Permanently delete account"[^\n]*onPress=\{confirm\}/, 'tap 2: the deletion button asks to confirm');
  // The web's words, and then the one thing the web has no need to say: a store subscription
  // carries on until it is cancelled with Apple or Google (owner, Oct 8, 2026; Guideline 5.1.1(v)).
  assert.match(remove, /if \(!await shell\.confirmConsequence\(\{ title: 'Permanently delete this account\?', consequence: `This follows the journey ownership rules shown here and cannot be undone\. \$\{STORE_SUBSCRIPTION_NOT_CANCELLED\}`, confirmLabel: 'Permanently delete account', destructive: true \}\)\) return;\s*setPending\(true\);[\s\S]*session\.client\.deleteAccount\(password\)/, 'tap 3: the consequence dialog, in the web\'s words plus the store subscription, deletes');
  assert.match(remove, /import \{ STORE_SUBSCRIPTION_NOT_CANCELLED \} from '\.\.\/src\/billing\/store-products';/);
  assert.match(remove, /<Body>\{STORE_SUBSCRIPTION_NOT_CANCELLED\}<\/Body>/, 'and the screen says it before the dialog does');
  assert.doesNotMatch(remove, /Alert\.alert/, 'the consequence dialog, not the phone\'s stock pop-up (#243)');
  const web = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.ok(web.includes("confirmConsequence({ title: 'Permanently delete this account?', consequence: 'This follows the journey ownership rules shown here and cannot be undone.', confirmLabel: 'Permanently delete account', destructive: true })"), 'the phone asks what the web asks, then adds the store subscription');
  assert.match(remove, /shell\.showStatus\(accountMessage\(error\), \{ source: 'account-deletion' \}\)/, 'a wrong password goes to the status region');
  assert.match(remove, /What is deleted:/);
  assert.match(remove, /What stays:/);
});
