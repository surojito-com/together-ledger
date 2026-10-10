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

const { createAccountClient, OFFLINE_MESSAGE, UNREACHABLE_MESSAGE, UNAVAILABLE_MESSAGE } = await importMobile('src/api/client.ts');
const { accountMessage, ACCOUNT_FALLBACK_MESSAGE, NO_ROOM_ADDED_HERE } = await importMobile('src/auth/account-messages.ts');
const { sessionAnswered, sessionFailed, LEDGER_WHILE_OFFLINE, ACCOUNT_WHILE_OFFLINE, STILL_SIGNED_IN } = await importMobile('src/auth/session-state.ts');

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

const expired = reply(401, { error: { code: 'authentication_required', message: 'Sign in to continue.' } });

test('a refused refresh forgets the tokens and asks the person to sign in again', async () => {
  const tokens = memoryTokens(pair(1));
  const client = createAccountClient({ base: () => '/api/v1', tokens, fetch: async (url) => (url.endsWith('/auth/refresh') ? reply(401, { error: { code: 'invalid_token', message: 'Sign in again to continue.' } }) : expired) });
  await assert.rejects(client.session(), { code: 'authentication_required', status: 401 });
  assert.equal(tokens.held, null);
});

// #353: only the service refusing the tokens ends the sign-in. A refresh it could not answer
// keeps them, and is said the way being offline is said, never as being signed out.
test('a 500, a 429, a reply that is not JSON, or no pair at all keeps the tokens', async () => {
  const notJson = { ok: false, status: 403, json: async () => { throw new SyntaxError('Unexpected token <'); } };
  const cases = [
    ['a 500', reply(500, { error: { code: 'internal_error', message: 'The service could not complete that request.' } })],
    ['a 502 from the proxy', { ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <'); } }],
    ['a 429 from the rate limit', reply(429, { error: { code: 'rate_limited', message: 'Too many requests.' } })],
    ['a challenge page', notJson],
    ['a 401 that is not the service refusing the token', { ok: false, status: 401, json: async () => { throw new SyntaxError('Unexpected token <'); } }],
    ['a 200 with no pair', reply(200, { data: null })],
  ];
  for (const [name, answer] of cases) {
    const tokens = memoryTokens(pair(1));
    const client = createAccountClient({ base: () => '/api/v1', tokens, fetch: async (url) => (url.endsWith('/auth/refresh') ? answer : expired) });
    await assert.rejects(client.session(), { code: 'unreachable', message: UNREACHABLE_MESSAGE }, name);
    assert.deepEqual(tokens.held, pair(1), `${name} keeps the tokens`);
    assert.equal(sessionFailed({ status: 'signed-in', user: { id: 'u1' } }, await client.session().catch((error) => error)).status, 'signed-in', `${name} keeps the person signed in`);
  }
});

// The server's side of this is in tests/platform-api.test.js: a spent refresh token asked again
// before anyone uses its pair gets a fresh one. Here, the phone that never heard back.
test('a renewal whose reply was lost, asked again, stays signed in', async () => {
  const tokens = memoryTokens(pair(1));
  let issued = 1;
  let live = null; // access-1 has run out; the service accepts only the newest pair it issued
  let dropNextReply = true;
  const spent = new Set();
  const client = createAccountClient({ base: () => '/api/v1', tokens, fetch: async (url, init) => {
    if (url.endsWith('/auth/refresh')) {
      const { refreshToken } = JSON.parse(init.body);
      spent.add(refreshToken);
      const fresh = pair(++issued);
      live = fresh.token;
      if (dropNextReply) {
        dropNextReply = false;
        throw new TypeError('Network request failed');
      }
      return reply(200, { data: { user: { id: 'u1' }, ...fresh } });
    }
    return init.headers.Authorization === `Bearer ${live}` ? reply(200, { data: { user: { id: 'u1' } } }) : expired;
  } });
  await assert.rejects(client.session(), { code: 'offline' });
  assert.equal(tokens.held.refreshToken, 'refresh-1', 'the phone still holds the token it spent');
  assert.ok(spent.has('refresh-1'), 'the service did spend it');
  assert.deepEqual(await client.session(), { id: 'u1' });
  assert.equal(tokens.held.refreshToken, 'refresh-3', 'the pair from the retry, not the lost one');
});

// #352: opening the app with no connection must not look signed out while the phone holds a sign-in.
test('opening the app with the network failing says offline, not signed out', async () => {
  const loading = { status: 'loading', user: null };
  const offline = createAccountClient({ base: () => '/api/v1', tokens: memoryTokens(pair(1)), fetch: async () => { throw new TypeError('Network request failed'); } });
  assert.deepEqual(sessionFailed(loading, await offline.session().catch((error) => error)), { status: 'offline', user: null, reason: 'offline' });

  const down = createAccountClient({ base: () => '/api/v1', tokens: memoryTokens(pair(1)), fetch: async () => reply(503, { error: { code: 'unavailable', message: 'The service is unavailable.' } }) });
  assert.deepEqual(sessionFailed(loading, await down.session().catch((error) => error)), { status: 'offline', user: null, reason: 'unreachable' });

  // Only a refusal signs out, and a phone with no tokens never asks at all.
  assert.deepEqual(sessionFailed({ status: 'offline', user: null, reason: 'offline' }, { code: 'authentication_required' }), { status: 'signed-out', user: null });
  const empty = createAccountClient({ base: () => '/api/v1', tokens: memoryTokens(), fetch: async () => { throw new Error('never called'); } });
  assert.deepEqual(sessionAnswered(await empty.session()), { status: 'signed-out', user: null });

  // When the connection returns, the same check signs the person straight back in.
  assert.deepEqual(sessionAnswered({ id: 'u1' }), { status: 'signed-in', user: { id: 'u1' } });

  // And the screens say so instead of offering the password form.
  const read = (file) => readFile(new URL(file, mobile), 'utf8');
  const ledger = await read('app/ledger.tsx');
  assert.ok(ledger.indexOf("if (state.phase === 'offline') return <LedgerWhileOffline reason={state.reason}") < ledger.indexOf("if (state.phase === 'signed-out'"), 'the ledger says offline before it ever offers Sign in');
  assert.match(ledger, /function LedgerWhileOffline[\s\S]*?<Body>\{LEDGER_WHILE_OFFLINE\[reason\]\}<\/Body>/);
  assert.match(await read('app/account.tsx'), /if \(session\.status === 'offline'\) \{[\s\S]*?ACCOUNT_WHILE_OFFLINE\[session\.reason\]/);
  assert.match(await read('app/settings.tsx'), /session\.status === 'offline' \? \(\s*<Body>\{STILL_SIGNED_IN\[session\.reason\]\}<\/Body>/);
  for (const words of [...Object.values(LEDGER_WHILE_OFFLINE), ...Object.values(ACCOUNT_WHILE_OFFLINE), ...Object.values(STILL_SIGNED_IN)]) {
    assert.match(words, /still signed in/, 'every offline screen says the person is still signed in');
    assert.doesNotMatch(words, /\bwait/, 'and promises nothing waits');
  }
  assert.match(await read('src/journey/use-journey.ts'), /session\.status === 'offline'\s*\? \{ phase: 'offline', reason: session\.reason \}/);
});

// #352: on the phone, offline is said in the connection notice's words; "no service in this
// build" keeps the web's own words. The web keeps its own offline words.
test('offline and "no service in this build" stay two different messages', async () => {
  const offline = createAccountClient({ base: () => '/api/v1', tokens: memoryTokens(), fetch: async () => { throw new TypeError('Network request failed'); } });
  await assert.rejects(offline.requestRecovery('a@example.test'), { code: 'offline', message: OFFLINE_MESSAGE });
  const unconfigured = createAccountClient({ base: () => { throw new Error('EXPO_PUBLIC_API_ORIGIN is not set.'); }, tokens: memoryTokens(), fetch: async () => reply(200, {}) });
  await assert.rejects(unconfigured.requestRecovery('a@example.test'), { code: 'accounts_unavailable', message: UNAVAILABLE_MESSAGE });
  const webApi = await readFile(new URL('../src/api.js', import.meta.url), 'utf8');
  assert.ok(webApi.includes(`'${UNAVAILABLE_MESSAGE}'`), 'the phone uses the web client\'s words for a build with no service');
  assert.ok(webApi.includes("'Private sync is temporarily unreachable.'"), 'the web keeps its own offline words');
  assert.ok(!webApi.includes(OFFLINE_MESSAGE), 'and the phone\'s are its connection notice\'s, not the web\'s');
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
  // A moment still waiting on this phone (#352) is named last, only when there is one.
  assert.match(remove, /if \(!await shell\.confirmConsequence\(\{ title: 'Permanently delete this account\?', consequence: `This follows the journey ownership rules shown here and cannot be undone\. \$\{STORE_SUBSCRIPTION_NOT_CANCELLED\}\$\{unsent \? ` \$\{unsent\}` : ''\}`, confirmLabel: 'Permanently delete account', destructive: true \}\)\) return;\s*setPending\(true\);[\s\S]*session\.client\.deleteAccount\(asksForPassword \? password : null\)/, 'tap 3: the consequence dialog, in the web\'s words plus the store subscription, deletes; with no password for an account that has none (#217)');
  assert.match(remove, /import \{ STORE_SUBSCRIPTION_NOT_CANCELLED \} from '\.\.\/src\/billing\/store-products';/);
  assert.match(remove, /<Body>\{STORE_SUBSCRIPTION_NOT_CANCELLED\}<\/Body>/, 'and the screen says it before the dialog does');
  assert.doesNotMatch(remove, /Alert\.alert/, 'the consequence dialog, not the phone\'s stock pop-up (#243)');
  const web = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.ok(web.includes("confirmConsequence({ title: 'Permanently delete this account?', consequence: 'This follows the journey ownership rules shown here and cannot be undone.', confirmLabel: 'Permanently delete account', destructive: true })"), 'the phone asks what the web asks, then adds the store subscription');
  assert.match(remove, /shell\.showStatus\(accountMessage\(error\), \{ source: 'account-deletion' \}\)/, 'a wrong password goes to the status region');
  assert.match(remove, /What is deleted:/);
  assert.match(remove, /What stays:/);
});

// #355: the screen said the history keeps no email, and that any payment for capacity has to end
// first. Neither was true. What it says now is PRIVACY.md's own sentences, checked here word for word.
test('the Delete account screen says what is kept, and which payment stops a deletion, in the privacy policy\'s words', async () => {
  const remove = await readFile(new URL('app/delete-account.tsx', mobile), 'utf8');
  const policy = await readFile(new URL('../PRIVACY.md', import.meta.url), 'utf8');
  const keeps = /const DELETION_KEEPS = "What stays: ([^"]+)";/.exec(remove)?.[1];
  const waits = /const DELETION_WAITS_ON_WEB_PAYMENT = '([^']+)';/.exec(remove)?.[1];
  assert.ok(keeps && waits, 'both sentences are named constants');
  for (const sentence of keeps.split(/(?<=\.) /)) assert.ok(policy.includes(sentence), `PRIVACY.md says: ${sentence}`);
  assert.ok(policy.includes(waits), `PRIVACY.md says: ${waits}`);
  assert.match(remove, /<Body>\{DELETION_KEEPS\}<\/Body>\s*<Body>\{DELETION_WAITS_ON_WEB_PAYMENT\}<\/Body>/);
  assert.doesNotMatch(remove, /without your email|If you pay for capacity/);
  // Only a web subscription refuses a deletion: the server's own check reads Stripe's table alone.
  const billing = await readFile(new URL('../server/billing.js', import.meta.url), 'utf8');
  const check = billing.slice(billing.indexOf('async assertAccountDeletable('), billing.indexOf('billing_subscription_active'));
  assert.match(check, /FROM billing_subscriptions bs/);
  assert.match(check, /bs\.payer_user_id=\$1 OR j\.owner_user_id=\$1/);
  assert.doesNotMatch(check, /billing_store_purchases|source IN/);
  // And the store-subscription paragraph stays.
  assert.match(remove, /<Body>\{STORE_SUBSCRIPTION_NOT_CANCELLED\}<\/Body>/);
});

// #194: signing out everywhere, changing the password, and being signed out by either.
const { ACCOUNT_NOTICES } = await importMobile('src/auth/account-messages.ts');
const refused = reply(401, { error: { code: 'invalid_token', message: 'Sign in again to continue.' } });

test('a sign-in ended elsewhere tells the app once, however many requests find out together', async () => {
  const tokens = memoryTokens(pair(1));
  let told = 0;
  const client = createAccountClient({ base: () => '/api/v1', tokens, fetch: async (url) => (url.endsWith('/auth/refresh') ? refused : expired) });
  client.onSignedOut(() => { told += 1; });
  const results = await Promise.allSettled([client.session(), client.journeys(), client.snapshot('j1')]);
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason.code === 'authentication_required'));
  assert.equal(told, 1);
  assert.equal(tokens.held, null);
});

// #353 stays: only the service refusing the tokens is being signed out.
test('a renewal the network, a 500 or a 429 stopped never tells the app it was signed out', async () => {
  for (const answer of [() => { throw new TypeError('offline'); }, () => reply(500, { error: { code: 'internal_error' } }), () => reply(429, { error: { code: 'rate_limit_exceeded' } })]) {
    const tokens = memoryTokens(pair(1));
    let told = 0;
    const client = createAccountClient({ base: () => '/api/v1', tokens, fetch: async (url) => (url.endsWith('/auth/refresh') ? answer() : expired) });
    client.onSignedOut(() => { told += 1; });
    await assert.rejects(client.session(), (error) => error.code !== 'authentication_required');
    assert.equal(told, 0);
    assert.equal(tokens.held.refreshToken, 'refresh-1');
  }
});

test('a listener that stops listening is not told', async () => {
  const tokens = memoryTokens(pair(1));
  let told = 0;
  const client = createAccountClient({ base: () => '/api/v1', tokens, fetch: async (url) => (url.endsWith('/auth/refresh') ? refused : expired) });
  const stop = client.onSignedOut(() => { told += 1; });
  stop();
  await assert.rejects(client.session(), { code: 'authentication_required' });
  assert.equal(told, 0);
});

test('signing out everywhere forgets this phone\'s tokens once the service has done it, and not before', async () => {
  const seen = [];
  const done = memoryTokens(pair(1));
  const client = createAccountClient({ base: () => '/api/v1', tokens: done, fetch: async (url, init) => { seen.push(`${init.method} ${url} ${init.headers.Authorization}`); return reply(204, null); } });
  await client.logoutEverywhere();
  assert.deepEqual(seen, ['POST /api/v1/auth/logout-everywhere Bearer access-1']);
  assert.equal(done.held, null);
  // Out of reach: nothing was signed out anywhere, so this phone says so and stays as it was.
  const offline = memoryTokens(pair(1));
  const unreachable = createAccountClient({ base: () => '/api/v1', tokens: offline, fetch: async () => { throw new TypeError('offline'); } });
  await assert.rejects(unreachable.logoutEverywhere(), { code: 'offline' });
  assert.equal(offline.held.refreshToken, 'refresh-1');
  const limited = memoryTokens(pair(1));
  const tooMany = createAccountClient({ base: () => '/api/v1', tokens: limited, fetch: async () => reply(429, { error: { code: 'rate_limit_exceeded', message: 'Too many requests. Wait and try again.' } }) });
  await assert.rejects(tooMany.logoutEverywhere(), { code: 'rate_limit_exceeded', message: 'Too many requests. Wait and try again.' });
  assert.equal(limited.held.refreshToken, 'refresh-1');
});

test('changing the password keeps this phone\'s tokens, and a wrong one is said as it is, without signing out', async () => {
  const tokens = memoryTokens(pair(1));
  const sent = [];
  let told = 0;
  const client = createAccountClient({ base: () => '/api/v1', tokens, fetch: async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    const { currentPassword } = JSON.parse(init.body);
    return currentPassword === 'right one, twelve+'
      ? reply(200, { data: { user: { id: 'u1', hasPassword: true } } })
      : reply(401, { error: { code: 'invalid_credentials', message: 'Username, email, or password is incorrect.' } });
  } });
  client.onSignedOut(() => { told += 1; });
  await assert.rejects(client.changePassword('wrong', 'new password, twelve+'), { code: 'invalid_credentials', message: 'Username, email, or password is incorrect.' });
  assert.deepEqual(await client.changePassword('right one, twelve+', 'new password, twelve+'), { id: 'u1', hasPassword: true });
  assert.deepEqual(sent.map((entry) => entry.url), ['/api/v1/account/password', '/api/v1/account/password'], 'no refresh was spent on a wrong password');
  assert.deepEqual(sent[1].body, { currentPassword: 'right one, twelve+', newPassword: 'new password, twelve+' });
  assert.equal(sent[1].auth, 'Bearer access-1');
  assert.deepEqual(tokens.held, pair(1), 'the same tokens: nothing re-issued, nothing forgotten');
  assert.equal(told, 0);
});

test('the phone says signing out everywhere as signing out is said, and names moments still waiting', async () => {
  const { signOutEverywhereConsequence, signOutConsequence, SIGN_OUT_EVERYWHERE_CONSEQUENCE } = await importMobile('src/journey/waiting-moments.ts');
  assert.deepEqual(signOutEverywhereConsequence(0), { title: 'Sign out everywhere?', consequence: 'Every device signed in to this account, this one included, will need to sign in again. Nothing in your journeys is deleted.', confirmLabel: 'Sign out everywhere', destructive: false });
  assert.deepEqual(signOutEverywhereConsequence(1), { title: 'Sign out everywhere with moments waiting?', consequence: `${SIGN_OUT_EVERYWHERE_CONSEQUENCE} ${signOutConsequence(1).consequence}`, confirmLabel: 'Sign out everywhere and remove it', destructive: true });
  assert.equal(signOutEverywhereConsequence(3).consequence, `${SIGN_OUT_EVERYWHERE_CONSEQUENCE} 3 moments you held haven’t been sent yet. Signing out removes them from this phone, and they can’t be sent later.`);
  assert.equal(signOutEverywhereConsequence(3).confirmLabel, 'Sign out everywhere and remove them');
  const web = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.ok(web.includes(`const SIGN_OUT_EVERYWHERE_CONSEQUENCE = '${SIGN_OUT_EVERYWHERE_CONSEQUENCE}';`), 'the web asks in the same words');
  assert.ok(web.includes("confirmConsequence({ title: 'Sign out everywhere?', consequence: SIGN_OUT_EVERYWHERE_CONSEQUENCE, confirmLabel: 'Sign out everywhere' })"));
});

// Both warnings about moments still waiting live in one file: leaving a journey's (#387) and
// signing out everywhere's (#194). Each keeps its own words, and neither borrows the other's.
test('leaving and signing out everywhere each warn about waiting moments in their own words', async () => {
  const { unsentWhenLeaving, signOutEverywhereConsequence } = await importMobile('src/journey/waiting-moments.ts');
  assert.equal(unsentWhenLeaving(0), '');
  assert.equal(unsentWhenLeaving(1), 'One moment you held for this journey hasn’t been sent yet. Leaving removes it from this phone, and it can’t be sent later.');
  assert.equal(unsentWhenLeaving(2), '2 moments you held for this journey haven’t been sent yet. Leaving removes them from this phone, and they can’t be sent later.');
  assert.doesNotMatch(signOutEverywhereConsequence(2).consequence, /Leaving/);
  const settings = await readFile(new URL('app/journey-settings.tsx', mobile), 'utf8');
  assert.match(settings, /unsentWhenLeaving\(waiting\.moments\.filter\(\(moment\) => moment\.journeyId === journeyId\)\.length/, 'leaving still counts only that journey\'s moments');
});

test('the account screen offers Sign out everywhere behind the consequence dialog, and Change password only with a password', async () => {
  const account = await readFile(new URL('app/account.tsx', mobile), 'utf8');
  assert.match(account, /label="Sign out everywhere"[^\n]*onPress=\{async \(\) => \{\s*const held = waiting\.moments\.length;\s*if \(!await shell\.confirmConsequence\(signOutEverywhereConsequence\(held\)\)\) return;/);
  // The moments go only after the service has signed everything out.
  assert.match(account, /await session\.client\.logoutEverywhere\(\);\s*if \(held\) await waiting\.clear\(\);\s*session\.setUser\(null\);\s*return ACCOUNT_NOTICES\.signedOutEverywhere;/);
  assert.match(account, /\{user\.hasPassword !== false \? <Button kind="quiet" label="Change password" onPress=\{\(\) => router\.push\('\/change-password'\)\} \/> : null\}/);
  const change = await readFile(new URL('app/change-password.tsx', mobile), 'utf8');
  assert.match(change, /if \(session\.status !== 'signed-in' \|\| session\.user\.hasPassword === false\) return <Redirect href="\/account" \/>;/);
  assert.match(change, /session\.client\.changePassword\(currentPassword, newPassword\)/);
  assert.match(change, /ACCOUNT_NOTICES\.passwordChangedHere/);
  assert.doesNotMatch(change, /Alert\.alert/);
  const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const lead = /lead="([^"]+)"/.exec(change)[1];
  assert.ok(index.includes(`<p>${lead}</p>`), 'the phone says what the web says above the form');
  const layout = await readFile(new URL('app/_layout.tsx', mobile), 'utf8');
  assert.match(layout, /<Stack\.Screen name="change-password" options=\{\{ title: 'Change password' \}\} \/>/);
});

test('a refused sign-in takes the person to sign in, and says why, from whatever screen was open', async () => {
  const layout = await readFile(new URL('app/_layout.tsx', mobile), 'utf8');
  assert.match(layout, /function SignedOutWatch\(\) \{[\s\S]*client\.onSignedOut\(\(\) => \{\s*if \(router\.canDismiss\(\)\) router\.dismissAll\(\);\s*router\.push\(\{ pathname: '\/account', params: \{ notice: 'signedOutHere' \} \}\);/);
  assert.match(layout, /<SignedOutWatch \/>/);
  const session = await readFile(new URL('src/auth/session.tsx', mobile), 'utf8');
  assert.match(session, /useEffect\(\(\) => client\.onSignedOut\(\(\) => setState\(sessionAnswered\(null\)\)\), \[\]\);/);
  const account = await readFile(new URL('app/account.tsx', mobile), 'utf8');
  assert.match(account, /carried && carried in ACCOUNT_NOTICES \? ACCOUNT_NOTICES\[carried\]/, 'the notice it carries is shown on the sign-in form');
  assert.equal(ACCOUNT_NOTICES.signedOutHere, 'This device was signed out. This can happen when the password is changed, when Sign out everywhere is used, or when a sign-in runs out. Sign in again to continue.');
});
