import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { newDb } from 'pg-mem';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { MemoryMailer } from '../server/mailer.js';
import { PlatformService } from '../server/platform.js';

const origin = 'http://127.0.0.1:4174';
const apiOrigin = 'https://api.example.test';

async function testPlatform({ mailer = new MemoryMailer() } = {}) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  memory.public.registerFunction({
    name: 'char_length',
    args: ['text'],
    returns: 'integer',
    implementation: (value) => value.length,
  });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  await pool.query(await readFile(new URL('../server/migrations/001_platform.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/003_private_usernames.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/004_shared_moments.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/005_make-shared-journeys-more-humane.sql', import.meta.url), 'utf8'));
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: origin,
    API_ORIGIN: apiOrigin,
    ACCOUNT_ORIGIN: apiOrigin,
    SESSION_SECRET: 's'.repeat(32),
    AUDIT_HMAC_KEY: 'a'.repeat(32),
  });
  const platform = new PlatformService({ pool, config, mailer, now: () => new Date('2026-08-02T12:00:00.000Z') });
  const app = await buildApp({ platform, config });
  return { app, mailer, pool };
}

function cookieFrom(response) {
  return response.headers['set-cookie'].split(';')[0];
}

async function register(app, mailer, { email, username = email.split('@')[0] }) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { origin },
    payload: { email, username, password: 'correct horse battery staple' },
  });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json().data;
  const cookie = cookieFrom(response);
  const verification = mailer.messages.findLast((message) => message.type === 'verification' && message.to === email);
  const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', headers: { origin }, payload: { token: verification.token } });
  assert.equal(verified.statusCode, 200, verified.body);
  return { cookie, csrf: body.csrfToken, user: body.user };
}

test('hosted API bridge allows the configured frontend and API origins only', async (t) => {
  const { app, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const allowed = await app.inject({ method: 'OPTIONS', url: '/api/v1/session', headers: { origin } });
  assert.equal(allowed.statusCode, 204);
  assert.equal(allowed.headers['access-control-allow-origin'], origin);
  assert.equal(allowed.headers['access-control-allow-credentials'], 'true');
  const apiAllowed = await app.inject({ method: 'OPTIONS', url: '/api/v1/session', headers: { origin: apiOrigin } });
  assert.equal(apiAllowed.statusCode, 204);
  assert.equal(apiAllowed.headers['access-control-allow-origin'], apiOrigin);
  const denied = await app.inject({ method: 'OPTIONS', url: '/api/v1/session', headers: { origin: 'https://evil.example' } });
  assert.equal(denied.statusCode, 403);
});

function authHeaders(client) {
  return { origin, cookie: client.cookie, 'x-together-csrf': client.csrf };
}

test('TC-00010 through TC-00120 prove the shared journey is clear and durable', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });

  let alice;
  let bob;
  let journey;
  let firstMoment;
  let secondMoment;
  let invitationToken;

  await t.test('TC-00010: Journey setup creates a private journey', async () => {
    alice = await register(app, mailer, { email: 'tc-a@example.test', username: 'tc-person-a' });
    const response = await app.inject({
      method: 'POST', url: '/api/v1/journeys', headers: authHeaders(alice),
      payload: { name: 'A place to return to', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 },
    });
    assert.equal(response.statusCode, 201, response.body);
    journey = response.json().data.journey;
    assert.equal(journey.location, '');
    assert.equal(journey.startDateStatus, 'unknown');
    assert.equal(journey.endDateStatus, 'forever');
  });

  await t.test('TC-00020: Journey membership begins with its creator', async () => {
    const snapshot = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/snapshot`, headers: { cookie: alice.cookie } });
    assert.equal(snapshot.statusCode, 200, snapshot.body);
    const body = snapshot.json().data;
    assert.deepEqual(body.members.map((member) => member.id), [alice.user.id]);
    assert.equal(body.members[0].role, 'owner');
    assert.ok(body.members[0].joinedAt);
    assert.ok(body.journey.createdAt);
    assert.deepEqual(body.invitations, []);
    assert.deepEqual(body.moments, []);
  });

  await t.test('TC-00030: Shared moments can begin before another journeyer joins', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/journeys/${journey.id}/moments`, headers: authHeaders(alice),
      payload: { kind: 'memory', title: 'We made room to listen', detail: 'A shared truth held before the invitation was accepted.', occurredOn: '2026-08-22', moneyCents: 110, moneyCurrency: '' },
    });
    assert.equal(response.statusCode, 201, response.body);
    firstMoment = response.json().data.moment;
    assert.equal(firstMoment.visibility, 'shared-now');
    assert.equal(firstMoment.moneyCurrency, '');
  });

  await t.test('TC-00031: Shared moments can use a name of their own', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/journeys/${journey.id}/moments`, headers: authHeaders(alice),
      payload: { kind: 'other', kindLabel: 'A small win', title: 'We paused before replying', detail: 'The name is intentionally ours.', occurredOn: '2026-08-22', moneyCents: null },
    });
    assert.equal(response.statusCode, 201, response.body);
    const customMoment = response.json().data.moment;
    assert.equal(customMoment.kind, 'other');
    assert.equal(customMoment.kindLabel, 'A small win');
  });

  await t.test('TC-00040: Journey settings sends an invitation', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/v1/journeys/${journey.id}/invitations`, headers: authHeaders(alice), payload: { email: 'tc-b@example.test' } });
    assert.equal(response.statusCode, 202, response.body);
    invitationToken = mailer.messages.findLast((message) => message.type === 'invitation' && message.to === 'tc-b@example.test').token;
    const snapshot = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/snapshot`, headers: { cookie: alice.cookie } });
    const invitation = snapshot.json().data.invitations[0];
    assert.equal(invitation.email, 'tc-b@example.test');
    assert.equal(invitation.invitedByUserId, alice.user.id);
    assert.equal(invitation.invitedByDisplayName, 'tc-person-a');
    assert.equal(invitation.status, 'pending');
    assert.ok(invitation.sentAt);
    assert.ok(invitation.expiresAt);
    assert.equal(Object.hasOwn(invitation, 'token'), false);
    assert.equal(Object.hasOwn(invitation, 'tokenHash'), false);
  });

  await t.test('TC-00050: Account verification keeps each journeyer separate', async () => {
    bob = await register(app, mailer, { email: 'tc-b@example.test', username: 'tc-person-b' });
    assert.notEqual(alice.user.id, bob.user.id);
  });

  await t.test('TC-00060: Journey sharing accepts an invitation once', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/v1/invitations/${invitationToken}/accept`, headers: authHeaders(bob) });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.journeyId, journey.id);
  });

  await t.test('TC-00070: Shared moments retain the story before joining', async () => {
    const snapshot = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/snapshot`, headers: { cookie: bob.cookie } });
    assert.equal(snapshot.statusCode, 200, snapshot.body);
    const body = snapshot.json().data;
    assert.equal(body.members.length, 2);
    assert.ok(body.members.find((member) => member.id === bob.user.id).joinedAt);
    assert.equal(body.invitations[0].status, 'accepted');
    assert.ok(body.invitations[0].acceptedAt);
    assert.equal(body.moments.find((moment) => moment.id === firstMoment.id).title, 'We made room to listen');
  });

  await t.test('TC-00080: Shared moments let another journeyer add care', async () => {
    const response = await app.inject({
      method: 'PATCH', url: `/api/v1/journeys/${journey.id}/moments/${firstMoment.id}`, headers: authHeaders(bob),
      payload: { ...firstMoment, detail: 'Person B added the next sentence with care.', moneyCurrency: 'EUR' },
    });
    assert.equal(response.statusCode, 200, response.body);
    firstMoment = response.json().data.moment;
    assert.equal(firstMoment.version, 2);
    assert.equal(firstMoment.moneyCurrency, 'EUR');
    const snapshot = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/snapshot`, headers: { cookie: bob.cookie } });
    const edited = snapshot.json().data.moments.find((moment) => moment.id === firstMoment.id);
    assert.equal(edited.shapedByBoth, true);
    assert.equal(edited.createdBy, 'tc-person-a');
    assert.equal(edited.updatedBy, 'tc-person-b');
  });

  await t.test('TC-00090: Shared moments let each journeyer hold an entry', async () => {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/journeys/${journey.id}/moments`, headers: authHeaders(bob),
      payload: { kind: 'acknowledgment', title: 'Thank you for returning', detail: 'A shared entry from person B.', occurredOn: '2026-08-22', moneyCents: null },
    });
    assert.equal(response.statusCode, 201, response.body);
    secondMoment = response.json().data.moment;
  });

  await t.test('TC-00100: Shared moments remain editable from either account', async () => {
    const snapshot = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/snapshot`, headers: { cookie: alice.cookie } });
    assert.equal(snapshot.statusCode, 200, snapshot.body);
    const bMoment = snapshot.json().data.moments.find((moment) => moment.id === secondMoment.id);
    const response = await app.inject({
      method: 'PATCH', url: `/api/v1/journeys/${journey.id}/moments/${secondMoment.id}`, headers: authHeaders(alice),
      payload: { ...bMoment, title: 'Thank you for returning with care' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().data.moment.version, 2);
  });

  await t.test('TC-00110: Journey sharing protects a used invitation', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/v1/invitations/${invitationToken}/accept`, headers: authHeaders(bob) });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, 'invalid_invitation');
  });

  await t.test('TC-00120: Account return restores the same shared journey', async () => {
    const signedOutA = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: authHeaders(alice) });
    const signedOutB = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: authHeaders(bob) });
    assert.equal(signedOutA.statusCode, 204, signedOutA.body);
    assert.equal(signedOutB.statusCode, 204, signedOutB.body);
    const loginA = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { identifier: 'tc-person-a', password: 'correct horse battery staple' } });
    const loginB = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { identifier: 'tc-person-b', password: 'correct horse battery staple' } });
    assert.equal(loginA.statusCode, 200, loginA.body);
    assert.equal(loginB.statusCode, 200, loginB.body);
    const aSnapshot = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/snapshot`, headers: { cookie: cookieFrom(loginA) } });
    const bSnapshot = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/snapshot`, headers: { cookie: cookieFrom(loginB) } });
    assert.equal(aSnapshot.statusCode, 200, aSnapshot.body);
    assert.equal(bSnapshot.statusCode, 200, bSnapshot.body);
    assert.deepEqual(aSnapshot.json().data.moments.map((moment) => moment.title).sort(), bSnapshot.json().data.moments.map((moment) => moment.title).sort());
  });
});

test('accounts share an authorized journey with conflicts, events, recovery, and deletion', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });

  const alice = await register(app, mailer, { email: 'alice@example.test', username: 'alice-journeys' });
  const bob = await register(app, mailer, { email: 'bob@example.test', username: 'bob-journeys' });
  const mallory = await register(app, mailer, { email: 'mallory@example.test', username: 'mallory-journeys' });
  assert.equal(alice.user.username, 'alice-journeys');
  assert.equal(alice.user.displayName, 'alice-journeys');

  const duplicateUsername = await app.inject({
    method: 'POST', url: '/api/v1/auth/register', headers: { origin },
    payload: { email: 'another@example.test', username: 'alice-journeys', password: 'correct horse battery staple' },
  });
  assert.equal(duplicateUsername.statusCode, 409);
  assert.equal(duplicateUsername.json().error.code, 'account_exists');

  const missingCsrf = await app.inject({ method: 'POST', url: '/api/v1/journeys', headers: { origin, cookie: alice.cookie }, payload: {} });
  assert.equal(missingCsrf.statusCode, 403);
  assert.equal(missingCsrf.json().error.code, 'invalid_csrf');

  const created = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: authHeaders(alice),
    payload: { name: 'Coastal Week', location: 'Maine', startDate: '2026-09-01', endDate: '2026-09-07', budgetCents: 200000 },
  });
  assert.equal(created.statusCode, 201, created.body);
  const journey = created.json().data.journey;

  const denied = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/snapshot`, headers: { cookie: mallory.cookie } });
  assert.equal(denied.statusCode, 403);

  const invitation = await app.inject({ method: 'POST', url: `/api/v1/journeys/${journey.id}/invitations`, headers: authHeaders(alice), payload: { email: 'bob@example.test' } });
  assert.equal(invitation.statusCode, 202, invitation.body);
  const inviteToken = mailer.messages.findLast((message) => message.type === 'invitation').token;
  const accepted = await app.inject({ method: 'POST', url: `/api/v1/invitations/${inviteToken}/accept`, headers: authHeaders(bob) });
  assert.equal(accepted.statusCode, 200, accepted.body);

  const duplicateSeat = await app.inject({ method: 'POST', url: `/api/v1/journeys/${journey.id}/invitations`, headers: authHeaders(alice), payload: { email: 'mallory@example.test' } });
  assert.equal(duplicateSeat.statusCode, 409);
  assert.equal(duplicateSeat.json().error.code, 'journey_full');

  const expenseResponse = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journey.id}/expenses`, headers: authHeaders(alice),
    payload: { merchant: 'Harbor Hotel', category: 'Hotel', amountCents: 74500, occurredOn: '2026-09-01', paidByUserId: alice.user.id, payerLabel: 'Alice', account: 'Travel card', status: 'paid', reference: 'TEST-1', notes: 'Refundable' },
  });
  assert.equal(expenseResponse.statusCode, 201, expenseResponse.body);
  const expense = expenseResponse.json().data.expense;

  const edited = await app.inject({
    method: 'PATCH', url: `/api/v1/journeys/${journey.id}/expenses/${expense.id}`, headers: authHeaders(bob),
    payload: { ...expense, amountCents: 75000 },
  });
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(edited.json().data.expense.version, 2);

  const stale = await app.inject({
    method: 'PATCH', url: `/api/v1/journeys/${journey.id}/expenses/${expense.id}`, headers: authHeaders(alice),
    payload: { ...expense, amountCents: 76000 },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, 'conflict');

  const concern = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journey.id}/concerns`, headers: authHeaders(bob),
    payload: { title: 'Deposit changed', detail: 'Ask the hotel before arrival.', status: 'open' },
  });
  assert.equal(concern.statusCode, 201, concern.body);

  const snapshot = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/snapshot`, headers: { cookie: bob.cookie } });
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  const data = snapshot.json().data;
  assert.equal(data.members.length, 2);
  assert.equal(data.expenses[0].amountCents, 75000);
  assert.equal(data.concerns.length, 1);
  assert.equal(data.eventChainValid, true);
  assert.deepEqual(data.events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
  assert.ok(data.events.every((event, index) => index === 0 || event.previousHash === data.events[index - 1].eventHash));
  assert.equal(data.events.find((event) => event.action === 'concern_added').after.detail, '[recorded]');
  const addedExpenseEvent = data.events.find((event) => event.action === 'expense_added');
  assert.equal('notes' in addedExpenseEvent.after, false);
  assert.equal('account' in addedExpenseEvent.after, false);
  assert.equal('reference' in addedExpenseEvent.after, false);
  assert.equal('payerLabel' in addedExpenseEvent.after, false);

  const recoveryRequest = await app.inject({ method: 'POST', url: '/api/v1/recovery/request', headers: { origin }, payload: { email: 'alice@example.test' } });
  const enumerationSafe = await app.inject({ method: 'POST', url: '/api/v1/recovery/request', headers: { origin }, payload: { email: 'nobody@example.test' } });
  assert.equal(recoveryRequest.statusCode, 202);
  assert.equal(enumerationSafe.statusCode, 202);
  assert.equal(recoveryRequest.body, enumerationSafe.body);
  const recoveryToken = mailer.messages.findLast((message) => message.type === 'recovery').token;
  const recovered = await app.inject({ method: 'POST', url: '/api/v1/recovery/confirm', headers: { origin }, payload: { token: recoveryToken, password: 'a new correct horse battery staple' } });
  assert.equal(recovered.statusCode, 200, recovered.body);
  const replay = await app.inject({ method: 'POST', url: '/api/v1/recovery/confirm', headers: { origin }, payload: { token: recoveryToken, password: 'another correct horse battery staple' } });
  assert.equal(replay.statusCode, 400);
  const revokedSession = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie: alice.cookie } });
  assert.equal(revokedSession.statusCode, 401);

  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { identifier: 'alice-journeys', password: 'a new correct horse battery staple' } });
  assert.equal(login.statusCode, 200, login.body);
  const emailLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { identifier: 'alice@example.test', password: 'a new correct horse battery staple' } });
  assert.equal(emailLogin.statusCode, 200, emailLogin.body);
  const newAlice = { cookie: cookieFrom(login), csrf: login.json().data.csrfToken };
  const deleted = await app.inject({ method: 'DELETE', url: '/api/v1/account', headers: authHeaders(newAlice), payload: { password: 'a new correct horse battery staple', confirmation: 'DELETE' } });
  assert.equal(deleted.statusCode, 204, deleted.body);

  const bobAfterDeletion = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/snapshot`, headers: { cookie: bob.cookie } });
  assert.equal(bobAfterDeletion.statusCode, 200, bobAfterDeletion.body);
  assert.equal(bobAfterDeletion.json().data.members.length, 1);
  assert.equal(bobAfterDeletion.json().data.journey.role, 'owner');
  assert.equal(bobAfterDeletion.json().data.eventChainValid, true);
  assert.equal(bobAfterDeletion.json().data.expenses[0].payerLabel, 'Deleted account');
  assert.equal(bobAfterDeletion.json().data.expenses[0].paidByUserId, null);
  assert.equal(bobAfterDeletion.json().data.expenses[0].version, 3);
  assert.ok(bobAfterDeletion.json().data.events.some((event) => event.action === 'expense_payer_pseudonymized'));
  assert.ok(bobAfterDeletion.json().data.events.some((event) => event.action === 'ownership_transferred'));
  assert.ok(bobAfterDeletion.json().data.events.some((event) => event.action === 'member_deleted_account'));
  assert.equal(JSON.stringify(bobAfterDeletion.json().data.events).includes('Alice'), false);
});

test('public service routes expose health and only the intended static app', async (t) => {
  const { app, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/readyz' })).statusCode, 200);
  const root = await app.inject({ method: 'GET', url: '/' });
  assert.match(root.body, /Together Ledger/);
  assert.match(root.body, /together-accounts-enabled" content="true"/);
  assert.equal((await app.inject({ method: 'GET', url: '/src/app.js' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/src/api.js' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/server/platform.js' })).statusCode, 404);
});

test('email outages preserve account recovery but revoke undelivered invitations', async (t) => {
  const failingMailer = {
    sendVerification: async () => { throw new Error('synthetic delivery failure'); },
    sendInvitation: async () => { throw new Error('synthetic delivery failure'); },
    sendRecovery: async () => { throw new Error('synthetic delivery failure'); },
  };
  const { app, pool } = await testPlatform({ mailer: failingMailer });
  t.after(async () => { await app.close(); await pool.end(); });

  const registered = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { origin }, payload: { email: 'offline@example.test', username: 'offline-journeys', password: 'correct horse battery staple' } });
  assert.equal(registered.statusCode, 201, registered.body);
  assert.equal(registered.json().data.verificationSent, false);
  const client = { cookie: cookieFrom(registered), csrf: registered.json().data.csrfToken };
  const userId = registered.json().data.user.id;
  await pool.query('UPDATE users SET email_verified_at=now() WHERE id=$1', [userId]);

  const recovery = await app.inject({ method: 'POST', url: '/api/v1/recovery/request', headers: { origin }, payload: { email: 'offline@example.test' } });
  assert.equal(recovery.statusCode, 202);

  const created = await app.inject({ method: 'POST', url: '/api/v1/journeys', headers: authHeaders(client), payload: { name: 'Email outage', location: 'Synthetic', startDate: '2026-08-07', endDate: '2026-08-08', budgetCents: 10000 } });
  const journeyId = created.json().data.journey.id;
  const invitation = await app.inject({ method: 'POST', url: `/api/v1/journeys/${journeyId}/invitations`, headers: authHeaders(client), payload: { email: 'invitee@example.test' } });
  assert.equal(invitation.statusCode, 503);
  assert.equal(invitation.json().error.code, 'delivery_unavailable');
  const stored = await pool.query('SELECT revoked_at FROM invitations WHERE journey_id=$1', [journeyId]);
  assert.ok(stored.rows[0].revoked_at);
});
