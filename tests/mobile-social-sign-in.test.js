import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

// Continue with Google and Apple on the phone (TL-S-04, #217): what the phone sends, what it keeps
// from Apple's first authorization, what stays silent, and that nothing shows until the server
// says it works on this phone.

const mobile = new URL('../apps/mobile/', import.meta.url);
const require = createRequire(import.meta.url);

// The phone's own TypeScript, compiled on the spot, as tests/mobile-account.test.js does.
async function importMobile(path) {
  const source = await readFile(new URL(path, mobile), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}
const { createAccountClient } = await importMobile('src/api/client.ts');
const social = await importMobile('src/auth/social-sign-in.ts');
const read = (path) => readFile(new URL(path, mobile), 'utf8');

const pair = { token: 'access-1', tokenExpiresAt: '2026-10-10T00:00:00.000Z', refreshToken: 'refresh-1', refreshTokenExpiresAt: '2026-11-10T00:00:00.000Z' };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function recording(answer = () => reply(200, { data: { user: { id: 'u1', hasPassword: false }, ...pair } })) {
  const calls = [];
  let held = null;
  const tokens = { read: async () => held, write: async (value) => { held = value; }, clear: async () => { held = null; } };
  const client = createAccountClient({ base: () => 'https://api.example.test/api/v1', tokens, fetch: async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    return answer(url, init);
  } });
  return { client, calls, tokens: () => held };
}

function memoryKept(initial = null) {
  let held = initial;
  return { read: async () => held, write: async (value) => { held = value; }, clear: async () => { held = null; }, get held() { return held; } };
}

// ---------------------------------------------------------------------------------------------
// The request shapes

test('the phone asks the providers read about itself: its platform and its Google client', async () => {
  const { client, calls } = recording(() => reply(200, { data: { google: { clientId: 'ios.apps.googleusercontent.com' }, apple: { clientId: 'com.togetherledger.ledger' } } }));
  assert.deepEqual(await client.providers('ios', 'ios.apps.googleusercontent.com'), { google: { clientId: 'ios.apps.googleusercontent.com' }, apple: { clientId: 'com.togetherledger.ledger' } });
  await client.providers('android', null);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.url}`), [
    'GET https://api.example.test/api/v1/auth/providers?platform=ios&googleClientId=ios.apps.googleusercontent.com',
    'GET https://api.example.test/api/v1/auth/providers?platform=android',
  ]);
  assert.equal(calls[0].headers['x-together-client'], 'app');
  assert.equal(calls[0].headers.Authorization, undefined, 'no session is needed or sent');
});

test('a providers answer the phone can\'t read is nothing offered', async () => {
  const { client } = recording(() => reply(200, { data: { google: {}, apple: 'yes' } }));
  assert.deepEqual(await client.providers('ios', 'ios.apps.googleusercontent.com'), { google: null, apple: null });
});

test('Google sends only the ID token, Apple the ID token, the authorizationCode and the first name, and both keep the token pair', async () => {
  const { client, calls, tokens } = recording();
  const user = await client.signInWithGoogle({ idToken: 'google-id-token' });
  assert.deepEqual(user, { id: 'u1', hasPassword: false });
  assert.deepEqual(tokens(), pair, 'stored the same way a password sign-in is, in the keychain (#180)');
  await client.signInWithApple({ idToken: 'apple-id-token', authorizationCode: 'apple-code', displayName: 'Asha Rao' });
  assert.deepEqual(calls.map(({ method, url, body }) => ({ method, url, body })), [
    { method: 'POST', url: 'https://api.example.test/api/v1/auth/google', body: { idToken: 'google-id-token' } },
    { method: 'POST', url: 'https://api.example.test/api/v1/auth/apple', body: { idToken: 'apple-id-token', authorizationCode: 'apple-code', displayName: 'Asha Rao' } },
  ]);
  for (const call of calls) assert.equal(call.headers['x-together-client'], 'app', 'the server answers the app with tokens, not a cookie');
});

test('linking sends the same sign-in with the password, and Apple\'s code with it', async () => {
  const { client, calls } = recording();
  await client.linkIdentity('google', { idToken: 'google-id-token' }, 'password-1');
  await client.linkIdentity('apple', { idToken: 'apple-id-token', authorizationCode: 'apple-code', displayName: 'Asha' }, 'password-2');
  assert.deepEqual(calls.map(({ url, body }) => ({ url, body })), [
    { url: 'https://api.example.test/api/v1/auth/link', body: { provider: 'google', idToken: 'google-id-token', password: 'password-1' } },
    { url: 'https://api.example.test/api/v1/auth/link', body: { provider: 'apple', idToken: 'apple-id-token', authorizationCode: 'apple-code', password: 'password-2' } },
  ]);
});

test('link_required comes back with the email the password is for, in the server\'s own words', async () => {
  const message = 'You already have an account with this email. Enter its password once to connect it.';
  const { client, tokens } = recording(() => reply(409, { error: { code: 'link_required', message, details: { email: 'asha@example.test' } } }));
  await assert.rejects(client.signInWithGoogle({ idToken: 'google-id-token' }), { code: 'link_required', message, details: { email: 'asha@example.test' } });
  assert.equal(tokens(), null);
});

test('an account without a password is deleted by typing DELETE alone; one with a password still sends it', async () => {
  // Deleting is signed in, so each deletion follows a sign-in that holds a token.
  const signedIn = recording((url) => (url.endsWith('/account') ? reply(204, null) : reply(200, { data: { user: { id: 'u1' }, ...pair } })));
  await signedIn.client.signInWithApple({ idToken: 't', authorizationCode: 'c' });
  await signedIn.client.deleteAccount(null);
  await signedIn.client.signInWithApple({ idToken: 't', authorizationCode: 'c' });
  await signedIn.client.deleteAccount('a long password');
  const deletions = signedIn.calls.filter((call) => call.method === 'DELETE');
  assert.deepEqual(deletions.map((call) => call.body), [{ confirmation: 'DELETE' }, { password: 'a long password', confirmation: 'DELETE' }]);
});

// ---------------------------------------------------------------------------------------------
// Apple's first authorization

test('the name Apple gives on the first authorization is sent, and kept until the server has it', async () => {
  const kept = memoryKept();
  const first = { user: 'apple-user-1', identityToken: 'id-1', authorizationCode: 'code-1', fullName: { givenName: 'Asha', familyName: 'Rao' }, email: 'asha@privaterelay.appleid.com' };
  assert.deepEqual(await social.appleSignInBody(first, kept), { idToken: 'id-1', authorizationCode: 'code-1', displayName: 'Asha Rao' });
  assert.deepEqual(kept.held, { user: 'apple-user-1', displayName: 'Asha Rao' });

  // That sign-in never reached the server. Apple doesn't give the name again; the kept one goes instead.
  const again = { user: 'apple-user-1', identityToken: 'id-2', authorizationCode: 'code-2', fullName: { givenName: null, familyName: null }, email: null };
  assert.deepEqual(await social.appleSignInBody(again, kept), { idToken: 'id-2', authorizationCode: 'code-2', displayName: 'Asha Rao' });

  // Never someone else's name.
  const stranger = { ...again, user: 'apple-user-2' };
  assert.deepEqual(await social.appleSignInBody(stranger, kept), { idToken: 'id-2', authorizationCode: 'code-2' });
});

test('the email from Apple\'s first authorization is never sent from the phone: the server reads it from the signed ID token', async () => {
  const kept = memoryKept();
  const body = await social.appleSignInBody({ user: 'u', identityToken: 'id', authorizationCode: 'code', fullName: null, email: 'asha@example.test' }, kept);
  assert.deepEqual(body, { idToken: 'id', authorizationCode: 'code' });
  assert.equal(kept.held, null, 'nothing to keep without a name');
  const platform = await readFile(new URL('../server/platform.js', import.meta.url), 'utf8');
  assert.match(platform, /async socialSignIn\(provider, \{ idToken, displayName, authorizationCode \} = \{\}/, 'the server takes no email from the body');
});

test('Apple\'s answer without either credential sends nothing, and a keychain that refuses doesn\'t stop the sign-in', async () => {
  assert.equal(await social.appleSignInBody({ user: 'u', identityToken: null, authorizationCode: 'c', fullName: null, email: null }, memoryKept()), null);
  assert.equal(await social.appleSignInBody({ user: 'u', identityToken: 'i', authorizationCode: null, fullName: null, email: null }, memoryKept()), null);
  const refusing = { read: async () => { throw new Error('locked'); }, write: async () => { throw new Error('locked'); }, clear: async () => {} };
  assert.deepEqual(await social.appleSignInBody({ user: 'u', identityToken: 'i', authorizationCode: 'c', fullName: { givenName: 'Asha' }, email: null }, refusing), { idToken: 'i', authorizationCode: 'c', displayName: 'Asha' });
  assert.deepEqual(await social.appleSignInBody({ user: 'u', identityToken: 'i', authorizationCode: 'c', fullName: null, email: null }, refusing), { idToken: 'i', authorizationCode: 'c' });
});

test('the kept name lives in the keychain like the tokens, and is cleared once a sign-in with Apple succeeds', async () => {
  const store = await read('src/auth/kept-apple-name.ts');
  assert.match(store, /from 'expo-secure-store'/);
  assert.match(store, /WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
  const component = await read('src/components/social-sign-in.tsx');
  assert.match(component, /const user = await signIn\(\);\s*if \(provider === 'apple'\) await keptAppleName\.clear\(\)/);
  assert.match(component, /appleSignInBody\(credential, keptAppleName\)/);
  assert.match(component, /requestedScopes: \[AppleAuthentication\.AppleAuthenticationScope\.FULL_NAME, AppleAuthentication\.AppleAuthenticationScope\.EMAIL\]/);
});

// ---------------------------------------------------------------------------------------------
// Cancelling

test('closing Apple\'s or Google\'s sheet is recognised as a cancel, and nothing else is', () => {
  assert.equal(social.appleCancelled({ code: 'ERR_REQUEST_CANCELED' }), true);
  assert.equal(social.appleCancelled({ code: 'ERR_REQUEST_FAILED' }), false);
  assert.equal(social.appleCancelled(null), false);
  const quiet = ['SIGN_IN_CANCELLED', 'IN_PROGRESS'];
  assert.equal(social.googleCancelled({ type: 'cancelled', data: null }, quiet), true);
  assert.equal(social.googleCancelled({ code: 'SIGN_IN_CANCELLED' }, quiet), true);
  assert.equal(social.googleCancelled({ code: 'IN_PROGRESS' }, quiet), true);
  assert.equal(social.googleCancelled({ code: 'PLAY_SERVICES_NOT_AVAILABLE' }, quiet), false);
  assert.equal(social.googleCancelled({ type: 'success', data: { idToken: 't' } }, quiet), false);
  assert.equal(social.googleIdToken({ type: 'success', data: { idToken: 'google-id-token' } }), 'google-id-token');
  assert.equal(social.googleIdToken({ type: 'success', data: { idToken: null } }), null);
  assert.equal(social.googleIdToken({ type: 'cancelled', data: null }), null);
});

test('a cancel says nothing and sends nothing; a failure in the sheet is said in the account\'s fallback words', async () => {
  const component = await read('src/components/social-sign-in.tsx');
  // Google: a cancelled answer returns before anything is sent; a cancel that throws is not said.
  assert.match(component, /const outcome = await GoogleSignin\.signIn\(\);\s*if \(googleCancelled\(outcome, GOOGLE_QUIET\)\) return;/);
  assert.match(component, /if \(!googleCancelled\(error, GOOGLE_QUIET\)\) setNotice\(accountMessage\(null\)\);/);
  assert.match(component, /const GOOGLE_QUIET = \[statusCodes\.SIGN_IN_CANCELLED, statusCodes\.IN_PROGRESS\];/);
  // Apple: the sheet's cancel lands in the catch, and is not said.
  assert.match(component, /if \(!appleCancelled\(error\)\) setNotice\(accountMessage\(null\)\);/);
});

// ---------------------------------------------------------------------------------------------
// Hidden until ready

test('nothing shows until the server says it works; an iPhone shows both or neither, Android Google alone', () => {
  const both = { google: { clientId: 'g' }, apple: { clientId: 'com.togetherledger.ledger' } };
  const none = { google: false, apple: false };
  assert.deepEqual(social.offeredSignIns('ios', null, { appleSheet: true }), none, 'not asked yet, or not answered');
  assert.deepEqual(social.offeredSignIns('ios', both, { appleSheet: true }), { google: true, apple: true });
  assert.deepEqual(social.offeredSignIns('ios', { google: { clientId: 'g' }, apple: null }, { appleSheet: true }), none, 'guideline 4.8: no Google without Apple on an iPhone');
  assert.deepEqual(social.offeredSignIns('ios', { google: null, apple: both.apple }, { appleSheet: true }), none, 'and both, or neither');
  assert.deepEqual(social.offeredSignIns('ios', both, { appleSheet: false }), none, 'Apple\'s sheet has to be there too');
  assert.deepEqual(social.offeredSignIns('android', { google: { clientId: 'g' }, apple: null }), { google: true, apple: false });
  assert.deepEqual(social.offeredSignIns('android', both), { google: true, apple: false }, 'never Apple on Android until its web flow can finish there');
  assert.deepEqual(social.offeredSignIns('android', { google: null, apple: null }), none);
});

test('the buttons draw nothing until then, and an unanswered or failed read leaves only email sign-in', async () => {
  const component = await read('src/components/social-sign-in.tsx');
  assert.match(component, /useState<Offer>\(NOTHING_OFFERED\)/);
  assert.match(component, /if \(!offer\.google && !offer\.apple\) return null;/);
  assert.match(component, /const answer = await client\.providers\(phonePlatform, googleClientId\);\s*const offered = offeredSignIns\(phonePlatform, answer, \{ appleSheet \}\);/);
  assert.match(component, /\}\)\(\)\.catch\(\(\) => \{\s*\/\/ Not ready, or not reachable/);
});

test('the Google client comes from the build\'s public config, never the source', async () => {
  assert.equal(social.googleClientIdFor('ios', { ios: ' 123-abc.apps.googleusercontent.com ', web: 'w.apps.googleusercontent.com' }), '123-abc.apps.googleusercontent.com');
  assert.equal(social.googleClientIdFor('android', { ios: 'i.apps.googleusercontent.com', web: '456-def.apps.googleusercontent.com' }), '456-def.apps.googleusercontent.com');
  assert.equal(social.googleClientIdFor('ios', { ios: '', web: null }), null);
  assert.equal(social.googleClientIdFor('android', { web: 'not a client id' }), null);
  const config = await read('src/config/google.ts');
  assert.match(config, /process\.env\.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID/);
  assert.match(config, /process\.env\.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID/);
  for (const file of ['src/config/google.ts', 'src/components/social-sign-in.tsx', 'src/auth/social-sign-in.ts', 'app.json']) {
    assert.doesNotMatch(await read(file), /\d+-[a-z0-9]+\.apps\.googleusercontent\.com/, `${file} holds a real Google client ID`);
  }
  const { googleUrlScheme } = require('../apps/mobile/app.config.js');
  assert.equal(googleUrlScheme({ EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: '123-abc.apps.googleusercontent.com' }), 'com.googleusercontent.apps.123-abc');
  assert.equal(googleUrlScheme({}), null);
  assert.equal(googleUrlScheme({ EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: 'com.googleusercontent.apps.123' }), null);
});

test('the buttons sit on the same screens as email sign-in, equal in size and over the 44-point minimum', async () => {
  const account = await read('app/account.tsx');
  const register = await read('app/register.tsx');
  assert.match(account, /<Screen title="Sign in"[^>]*>\s*\{\/\*[^]*?\*\/\}\s*<SocialSignIn \/>/);
  assert.match(register, /<SocialSignIn onSignedIn=\{\(\) => router\.replace\('\/account'\)\} \/>/);
  const component = await read('src/components/social-sign-in.tsx');
  const size = /const PROVIDER_BUTTON = \{ width: '100%', maxWidth: 400, height: (\d+), alignSelf: 'center' \} as const;/.exec(component);
  assert.ok(size && Number(size[1]) >= 44);
  assert.equal(component.match(/style=\{(?:\[)?PROVIDER_BUTTON/g)?.length, 2, 'both buttons take the same size');
});

// ---------------------------------------------------------------------------------------------
// After signing in

test('an Apple account with no email shows plain words, on the phone and the web alike', async () => {
  assert.equal(social.accountEmailLabel('apple-0f9e8d7c-1234-4abc-9def-001122334455@no-email.invalid'), 'Apple didn’t share an email address.');
  assert.equal(social.accountEmailLabel('asha@privaterelay.appleid.com'), 'asha@privaterelay.appleid.com');
  assert.equal(social.accountEmailLabel('asha@example.test'), 'asha@example.test');
  const web = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.ok(web.includes(`const APPLE_SHARED_NO_EMAIL = '${social.APPLE_SHARED_NO_EMAIL}';`), 'the same words on the web');
  const platform = await readFile(new URL('../server/platform.js', import.meta.url), 'utf8');
  assert.ok(platform.includes('`${provider}-${userId}@no-email.invalid`'), 'the placeholder the server gives is the one recognised');
  assert.match(await read('app/account.tsx'), /\{accountEmailLabel\(user\.email\)\}/);
});

test('deleting an account opened with Apple or Google asks for no password, and stays three taps', async () => {
  const remove = await read('app/delete-account.tsx');
  assert.match(remove, /const asksForPassword = session\.status !== 'signed-in' \|\| session\.user\.hasPassword !== false;/);
  assert.match(remove, /\{asksForPassword \? <Field label="Current password"/);
  assert.match(remove, /disabled=\{\(asksForPassword && !password\) \|\| typed !== 'DELETE'\}/);
  assert.match(remove, /session\.client\.deleteAccount\(asksForPassword \? password : null\)/);
});
