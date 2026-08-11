import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { newDb } from 'pg-mem';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { MemoryMailer } from '../server/mailer.js';
import { PlatformService } from '../server/platform.js';

const origin = 'http://127.0.0.1:4174';

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
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: origin,
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

async function register(app, mailer, { email, displayName }) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { origin },
    payload: { email, displayName, password: 'correct horse battery staple' },
  });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json().data;
  const cookie = cookieFrom(response);
  const verification = mailer.messages.findLast((message) => message.type === 'verification' && message.to === email);
  const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', headers: { origin }, payload: { token: verification.token } });
  assert.equal(verified.statusCode, 200, verified.body);
  return { cookie, csrf: body.csrfToken, user: body.user };
}

test('hosted API bridge allows only the configured frontend origin', async (t) => {
  const { app, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const allowed = await app.inject({ method: 'OPTIONS', url: '/api/v1/session', headers: { origin } });
  assert.equal(allowed.statusCode, 204);
  assert.equal(allowed.headers['access-control-allow-origin'], origin);
  assert.equal(allowed.headers['access-control-allow-credentials'], 'true');
  const denied = await app.inject({ method: 'OPTIONS', url: '/api/v1/session', headers: { origin: 'https://evil.example' } });
  assert.equal(denied.statusCode, 403);
});

function authHeaders(client) {
  return { origin, cookie: client.cookie, 'x-together-csrf': client.csrf };
}

test('accounts share an authorized journey with conflicts, events, recovery, and deletion', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });

  const alice = await register(app, mailer, { email: 'alice@example.test', displayName: 'Alice' });
  const bob = await register(app, mailer, { email: 'bob@example.test', displayName: 'Bob' });
  const mallory = await register(app, mailer, { email: 'mallory@example.test', displayName: 'Mallory' });

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

  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { email: 'alice@example.test', password: 'a new correct horse battery staple' } });
  assert.equal(login.statusCode, 200, login.body);
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
  assert.match((await app.inject({ method: 'GET', url: '/' })).body, /Together Ledger/);
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

  const registered = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { origin }, payload: { email: 'offline@example.test', displayName: 'Offline', password: 'correct horse battery staple' } });
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
