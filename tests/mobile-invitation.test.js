import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// An invitation on the phone (TL-M-14, #266): reading the code from a tapped or pasted link in
// every shape it has been sent in, keeping it through signing in and registering, and what the
// phone says about each kind of invitation. What the server answers is proven through this same
// client in tests/platform-api.test.js; the link files in tests/app-links.test.js.

const mobile = new URL('../apps/mobile/', import.meta.url);
const read = (path) => readFile(new URL(path, mobile), 'utf8');

// The phone's own TypeScript, compiled on the spot, with its relative imports compiled the same way.
async function importMobile(path) {
  const url = new URL(path, mobile);
  let { outputText } = ts.transpileModule(await readFile(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  for (const [whole, specifier] of [...outputText.matchAll(/from '(\.{1,2}\/[^']+)'/g)]) {
    const dependency = await importMobileUrl(new URL(`${specifier}.ts`, url));
    outputText = outputText.replace(whole, `from '${dependency}'`);
  }
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}
async function importMobileUrl(url) {
  const { outputText } = ts.transpileModule(await readFile(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`;
}

const links = await importMobile('src/invitations/invitation-link.ts');
const pendingModule = await importMobile('src/invitations/pending-invitation.ts');
const words = await importMobile('src/invitations/invitation-words.ts');
const intent = await importMobile('app/+native-intent.tsx');
const { createAccountClient } = await importMobile('src/api/client.ts');

// A code as the server makes one: 32 random bytes, base64url.
const CODE = 'q3Zx-7Hn_Lm2Pd9Rt4Vw8Yk1Bc6Fg0Js5Nu3Ae7Ix2O';

test('a pasted invitation is read in every shape a link has been sent in, and as the code alone', () => {
  const shapes = [
    `https://app.together-ledger.com/invite#invite=${CODE}`, // since #266
    `https://app.together-ledger.com/#invite=${CODE}`, // #261
    `https://app.together-ledger.com/?invite=${CODE}`, // before #261
    `https://app.together-ledger.com/?keep=1#invite=${CODE}`,
    `app.together-ledger.com/invite#invite=${CODE}`, // copied without its scheme
    `  <https://app.together-ledger.com/invite#invite=${CODE}>.\n`, // with what surrounded it
    CODE,
    `“${CODE}”`,
    ` ${CODE}. `,
  ];
  for (const shape of shapes) assert.deepEqual(links.readPastedInvitation(shape), { code: CODE }, JSON.stringify(shape));
});

test('pasted text that is not an invitation says what it is instead, and is never taken for one', () => {
  assert.deepEqual(links.readPastedInvitation(''), { problem: 'empty' });
  assert.deepEqual(links.readPastedInvitation('   '), { problem: 'empty' });
  assert.deepEqual(links.readPastedInvitation(`https://app.together-ledger.com/#verify=${CODE}`), { problem: 'verification-link' });
  assert.deepEqual(links.readPastedInvitation(`https://app.together-ledger.com/?recovery=${CODE}`), { problem: 'recovery-link' });
  assert.deepEqual(links.readPastedInvitation('https://app.together-ledger.com/'), { problem: 'not-an-invitation' });
  assert.deepEqual(links.readPastedInvitation('https://app.together-ledger.com/invite#invite=short'), { problem: 'not-an-invitation' });
  assert.deepEqual(links.readPastedInvitation('hello there'), { problem: 'not-an-invitation' });
  assert.deepEqual(links.readPastedInvitation(`javascript://x#invite=${CODE}`), { problem: 'not-an-invitation' });
  for (const problem of ['empty', 'not-an-invitation', 'verification-link', 'recovery-link']) assert.ok(words.INVITATION_WORDS.pasted[problem], problem);
});

test('a link the phone opens with is taken only at /invite, and its code read from after the #', () => {
  assert.equal(links.openedInvitation(`https://app.together-ledger.com/invite#invite=${CODE}`), CODE);
  assert.equal(links.openedInvitation(`https://app.together-ledger.com/invite/#invite=${CODE}`), CODE);
  assert.equal(links.openedInvitation(`/invite#invite=${CODE}`), CODE, 'the router may hand over only the path');
  assert.equal(links.openedInvitation(`togetherledger://invite#invite=${CODE}`), CODE);
  assert.equal(links.openedInvitation('https://app.together-ledger.com/invite'), null, 'the invitation screen, with nothing to read');
  // Not ours to take: the router gets them as they came.
  for (const other of ['https://app.together-ledger.com/', `https://app.together-ledger.com/#invite=${CODE}`, `https://app.together-ledger.com/#verify=${CODE}`, '/verify-email?token=abc', 'togetherledger://ledger', '/']) {
    assert.equal(links.openedInvitation(other), undefined, other);
  }

  assert.equal(intent.redirectSystemPath({ path: `https://app.together-ledger.com/invite#invite=${CODE}`, initial: true }), `/invite?code=${CODE}`);
  assert.equal(intent.redirectSystemPath({ path: 'https://app.together-ledger.com/invite', initial: false }), '/invite');
  assert.equal(intent.redirectSystemPath({ path: '/recovery-confirm?token=abc', initial: false }), '/recovery-confirm?token=abc');
  assert.equal(intent.redirectSystemPath({ path: 'togetherledger://ledger', initial: true }), 'togetherledger://ledger');
});

function memoryStorage() {
  const held = new Map();
  return {
    held,
    getItem: async (key) => held.get(key) ?? null,
    setItem: async (key, value) => { held.set(key, value); },
    removeItem: async (key) => { held.delete(key); },
  };
}

test('a pending invitation is kept on the phone until it is used or refused, and a newer one replaces it', async () => {
  const storage = memoryStorage();
  const store = pendingModule.createPendingInvitationStore(storage, () => new Date('2026-10-10T09:00:00.000Z'));
  assert.equal(await store.read(), null);
  await store.keep('older-code-abcdefghijklmnop');
  await store.keep(CODE);
  assert.deepEqual([...storage.held.keys()], [pendingModule.PENDING_INVITATION_KEY], 'one key, one invitation');
  // The app closes and opens again: a new store over the same keychain still has it.
  const reopened = pendingModule.createPendingInvitationStore(storage);
  assert.deepEqual(await reopened.read(), { code: CODE, keptAt: '2026-10-10T09:00:00.000Z' });
  await reopened.forget();
  assert.equal(await store.read(), null);
  assert.equal(storage.held.size, 0);

  storage.held.set(pendingModule.PENDING_INVITATION_KEY, 'not json');
  assert.equal(await store.read(), null, 'what cannot be read is no invitation, never a crash');
  const failing = pendingModule.createPendingInvitationStore({ ...storage, getItem: async () => { throw new Error('keychain locked'); } });
  assert.equal(await failing.read(), null);
});

test('it is kept in the keychain for this phone only, as the sign-in tokens are, and nowhere else', async () => {
  const provider = await read('src/invitations/use-pending-invitation.tsx');
  assert.match(provider, /keychainAccessible: SecureStore\.WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
  assert.doesNotMatch(provider, /expo-sqlite|AsyncStorage|phoneStore/, 'never the ledger store, which is backed up');
  for (const path of ['src/invitations/pending-invitation.ts', 'src/invitations/invitation-link.ts', 'app/invite.tsx', 'app/+native-intent.tsx']) {
    assert.doesNotMatch(await read(path), /fetch\(|console\.|Linking\.openURL/, `${path} sends the code nowhere but the API client`);
  }
});

// The cases of #266's table that the phone decides: who taps, and whether they are signed in.
test('a pending invitation survives signing in and registering, by any means, and is brought back once per account', () => {
  const base = { loaded: true, code: CODE, broughtBackFor: null, onInvitation: false, invitationInStack: false };
  // App installed, signed out: tapped, then sent to Sign in. Nothing moves while signed out.
  assert.deepEqual(pendingModule.bringBack({ ...base, status: 'signed-out', userId: null, invitationInStack: true }), { go: 'stay', broughtBackFor: null });
  // Signing in with a password, Google or Apple, or creating an account, all end in a signed-in
  // session for that account: back to the invitation they came from.
  const signedIn = pendingModule.bringBack({ ...base, status: 'signed-in', userId: 'u1', invitationInStack: true });
  assert.deepEqual(signedIn, { go: 'back-to-it', broughtBackFor: 'u1' });
  // Once. Leaving it without answering is not undone at every render.
  assert.deepEqual(pendingModule.bringBack({ ...base, status: 'signed-in', userId: 'u1', broughtBackFor: 'u1' }), { go: 'stay', broughtBackFor: 'u1' });
  // The app opened later, already signed in (after verifying in the browser, say): onto it.
  assert.deepEqual(pendingModule.bringBack({ ...base, status: 'signed-in', userId: 'u1' }), { go: 'onto-it', broughtBackFor: 'u1' });
  // App installed, signed in, link tapped: already there.
  assert.deepEqual(pendingModule.bringBack({ ...base, status: 'signed-in', userId: 'u1', onInvitation: true }), { go: 'stay', broughtBackFor: 'u1' });
  // Offline is not signed out: it does not forget whom it already did this for.
  assert.deepEqual(pendingModule.bringBack({ ...base, status: 'offline', userId: null, broughtBackFor: 'u1' }), { go: 'stay', broughtBackFor: 'u1' });
  // Signed out and into another account (the invitation was for a different address): again.
  const out = pendingModule.bringBack({ ...base, status: 'signed-out', userId: null, broughtBackFor: 'u1' });
  assert.deepEqual(pendingModule.bringBack({ ...base, status: 'signed-in', userId: 'u2', broughtBackFor: out.broughtBackFor }), { go: 'onto-it', broughtBackFor: 'u2' });
  // Nothing held, or the keychain not read yet: nothing to bring anyone back to.
  assert.equal(pendingModule.bringBack({ ...base, code: null, status: 'signed-in', userId: 'u1' }).go, 'stay');
  assert.equal(pendingModule.bringBack({ ...base, loaded: false, status: 'signed-in', userId: 'u1' }).go, 'stay');
});

test('registering and signing in only set who is signed in; the watch above every screen does the rest', async () => {
  const layout = await read('app/_layout.tsx');
  const sessionAt = layout.indexOf('<SessionProvider>');
  const providerAt = layout.indexOf('<PendingInvitationProvider>');
  const watchAt = layout.indexOf('<PendingInvitationWatch />');
  assert.ok(sessionAt > 0 && providerAt > sessionAt && watchAt > providerAt, 'inside the session, so it sees every way of signing in');
  assert.match(layout, /<Stack\.Screen name="invite" options=\{\{ title: 'Invitation' \}\} \/>/);
  for (const path of ['app/account.tsx', 'app/register.tsx', 'src/components/social-sign-in.tsx']) {
    assert.match(await read(path), /session\.setUser\(/, `${path} signs in through the session, which the watch follows`);
  }
});

test('"Have an invitation?" is on the welcome, Sign in, and the ledger with no journey, signed in or out', async () => {
  const label = words.INVITATION_WORDS.haveOne;
  assert.equal(label, 'Have an invitation?');
  for (const path of ['app/index.tsx', 'app/account.tsx']) {
    assert.match(await read(path), /label=\{INVITATION_WORDS\.haveOne\} onPress=\{\(\) => router\.push\('\/invite'\)\}/, path);
  }
  const ledger = await read('app/ledger.tsx');
  const emptyStart = ledger.slice(ledger.indexOf('function EmptyStart'));
  const button = emptyStart.indexOf("label={INVITATION_WORDS.haveOne} onPress={() => router.push('/invite')}");
  assert.ok(button > emptyStart.indexOf(') : ('), 'after both the signed-in and the signed-out start, so both have it');
});

test('the phone joins only when the person chooses to, and says they joined only once the server agrees', async () => {
  const screen = await read('app/invite.tsx');
  assert.equal(screen.match(/acceptInvitation\(/g).length, 1, 'one place accepts');
  const join = screen.slice(screen.indexOf('async function join('), screen.indexOf('async function notNow('));
  assert.ok(join.includes('acceptInvitation('), 'and it is the Join button\'s');
  assert.ok(join.indexOf('acceptInvitation(') < join.indexOf('WORDS.joined('), 'joined is said after the server accepts');
  assert.doesNotMatch(screen.slice(0, screen.indexOf('async function openPasted')), /acceptInvitation/, 'never on arrival');
  assert.match(screen, /<Button label=\{WORDS\.join\}/);
  assert.match(screen, /WORDS\.waitingEyebrow/, 'the pending state is shown as waiting for their answer');
  assert.doesNotMatch(screen, /kind="destructive"/, 'not now and not yet are not destruction');
});

test('the phone asks the server with the code in the body, signed in, and never in an address', async () => {
  const calls = [];
  let held = { token: 'access-1', tokenExpiresAt: '2026-10-11T00:00:00.000Z', refreshToken: 'refresh-1', refreshTokenExpiresAt: '2026-11-10T00:00:00.000Z' };
  const client = createAccountClient({
    base: () => 'https://api.example.test/api/v1',
    tokens: { read: async () => held, write: async (value) => { held = value; }, clear: async () => { held = null; } },
    fetch: async (url, init) => {
      calls.push({ url, method: init.method, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      const data = url.endsWith('/preview') ? { invitation: { state: 'open', journeyName: 'Sunday walks', invitedByDisplayName: 'Alex', expiresAt: '2026-10-24T09:00:00.000Z' } } : { journeyId: 'j1' };
      return { ok: true, status: 200, json: async () => ({ data }) };
    },
  });
  assert.equal((await client.previewInvitation(CODE)).journeyName, 'Sunday walks');
  assert.equal(await client.acceptInvitation(CODE), 'j1');
  assert.deepEqual(calls.map(({ url, method, auth, body }) => [url, method, auth, body]), [
    ['https://api.example.test/api/v1/invitations/preview', 'POST', 'Bearer access-1', { token: CODE }],
    ['https://api.example.test/api/v1/invitations/accept', 'POST', 'Bearer access-1', { token: CODE }],
  ]);
  assert.ok(calls.every(({ url }) => !url.includes(CODE)));
});

test('every kind of invitation that cannot be answered explains itself, and is let go', () => {
  const sent = { journeyName: 'Sunday walks', invitedByDisplayName: 'Alex', expiresAt: '2026-10-24T09:00:00.000Z' };
  const said = {
    already_member: words.closedInvitationMessage({ state: 'already_member', journeyId: 'j1', journeyName: 'Sunday walks' }),
    used: words.closedInvitationMessage({ state: 'used', ...sent }),
    expired: words.closedInvitationMessage({ state: 'expired', ...sent }),
    withdrawn: words.closedInvitationMessage({ state: 'withdrawn', ...sent }),
    closed: words.closedInvitationMessage({ state: 'closed', ...sent }),
    not_found: words.closedInvitationMessage({ state: 'not_found' }),
  };
  assert.deepEqual(said, {
    already_member: 'You’re already in “Sunday walks”. Nothing was used up.',
    used: 'This invitation has already been used, and each one works once. To join again, ask Alex to send a new one.',
    expired: 'This invitation ran out before it was used. Ask Alex to send it again.',
    withdrawn: 'This invitation was withdrawn, so it can’t be used. Nothing changed for you.',
    closed: 'This invitation is no longer open. Ask whoever invited you to send a new one.',
    not_found: 'We couldn’t find this invitation. Check that you copied the whole link or code. If it still doesn’t work, ask whoever invited you to send a new one.',
  });
  for (const state of Object.keys(said)) assert.equal(words.isSettled(state === 'already_member' ? { state, journeyId: 'j1', journeyName: 'x' } : { state, ...sent }), true, state);
  // Still theirs to answer, once they can.
  for (const answer of [{ state: 'open', ...sent }, { state: 'verify_email' }, { state: 'another_account' }]) {
    assert.equal(words.closedInvitationMessage(answer), null, answer.state);
    assert.equal(words.isSettled(answer), false, answer.state);
  }
});

test('the words keep the product\'s voice: no seats or slots, nobody removed, and nothing claimed that did not happen', () => {
  const all = [];
  const collect = (value) => {
    if (typeof value === 'string') all.push(value);
    else if (typeof value === 'function') all.push(value('Alex', 'Sunday walks'));
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(words.INVITATION_WORDS);
  assert.ok(all.length > 25);
  for (const sentence of all) {
    assert.doesNotMatch(sentence, /\b(seat|seats|slot|slots|license|licenses|removed|kicked)\b/i, sentence);
  }
  assert.equal(words.INVITATION_WORDS.notNowDone(null), 'Nothing was sent. The link in your email still works if you change your mind.');
  assert.match(words.INVITATION_WORDS.notNowDone('Oct 24, 2026'), /^Nothing was sent\. The invitation stays open until Oct 24, 2026,/);
  assert.equal(words.invitationDate('not a date'), null);
});
