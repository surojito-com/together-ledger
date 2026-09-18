import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { newDb } from 'pg-mem';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { MemoryMailer } from '../server/mailer.js';
import { PlatformError, PlatformService } from '../server/platform.js';

const origin = 'http://127.0.0.1:4174';
const appOrigin = 'https://app.together-ledger.com';
const apiOrigin = 'https://api.example.test';

async function testPlatform({ mailer = new MemoryMailer(), configOverrides = {}, billing } = {}) {
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
  await pool.query(await readFile(new URL('../server/migrations/006_expand-shared-moment-vocabulary.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/007_person_specific_moment_visibility.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/008_stripe_web_billing.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/009_reserve-group-places.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/011_hold-one-image-with-each-moment.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/012_bill-additional-moment-images.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/013_name-moment-image-attachments.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/014_hold-places-with-shared-moments.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/016_make-extra-image-payments-one-time.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/017_keep-one-removed-photo-per-moment.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/018_allow-ninety-nine-paid-journey-places.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/019_let-moments-carry-their-own-atmosphere.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/020_let-entitlements-hold-ninety-nine-places.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/021_let-unpaid-capacity-rest-without-losing-history.sql', import.meta.url), 'utf8'));
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: origin,
    APP_ORIGINS: appOrigin,
    API_ORIGIN: apiOrigin,
    ACCOUNT_ORIGIN: apiOrigin,
    SESSION_SECRET: 's'.repeat(32),
    AUDIT_HMAC_KEY: 'a'.repeat(32),
    ...configOverrides,
  });
  const platform = new PlatformService({ pool, config, mailer, now: () => new Date('2026-08-02T12:00:00.000Z') });
  const app = await buildApp({ platform, config, ...(billing ? { billing } : {}) });
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
  assert.equal(verification.accountOrigin, origin);
  const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', headers: { origin }, payload: { token: verification.token } });
  assert.equal(verified.statusCode, 200, verified.body);
  return { cookie, csrf: body.csrfToken, user: body.user };
}

test('hosted API bridge allows the configured frontend and API origins only', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const allowed = await app.inject({ method: 'OPTIONS', url: '/api/v1/session', headers: { origin } });
  assert.equal(allowed.statusCode, 204);
  assert.equal(allowed.headers['access-control-allow-origin'], origin);
  assert.equal(allowed.headers['access-control-allow-credentials'], 'true');
  const secondFrontendAllowed = await app.inject({ method: 'OPTIONS', url: '/api/v1/session', headers: { origin: appOrigin } });
  assert.equal(secondFrontendAllowed.statusCode, 204);
  assert.equal(secondFrontendAllowed.headers['access-control-allow-origin'], appOrigin);
  const apiAllowed = await app.inject({ method: 'OPTIONS', url: '/api/v1/session', headers: { origin: apiOrigin } });
  assert.equal(apiAllowed.statusCode, 204);
  assert.equal(apiAllowed.headers['access-control-allow-origin'], apiOrigin);
  const denied = await app.inject({ method: 'OPTIONS', url: '/api/v1/session', headers: { origin: 'https://evil.example' } });
  assert.equal(denied.statusCode, 403);
  const apiRegistration = await app.inject({
    method: 'POST', url: '/api/v1/auth/register', headers: { origin: apiOrigin },
    payload: { email: 'api-origin@example.test', username: 'api-origin', password: 'correct horse battery staple' },
  });
  assert.equal(apiRegistration.statusCode, 201, apiRegistration.body);
  assert.equal(mailer.messages.findLast((message) => message.type === 'verification').accountOrigin, apiOrigin);
  const messageCount = mailer.messages.length;
  const rejectedRegistration = await app.inject({
    method: 'POST', url: '/api/v1/auth/register', headers: { origin: 'https://evil.example' },
    payload: { email: 'rejected-origin@example.test', username: 'rejected-origin', password: 'correct horse battery staple' },
  });
  assert.equal(rejectedRegistration.statusCode, 403);
  assert.equal(mailer.messages.length, messageCount);
});

test('dual-host frontend can start an account lifecycle', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { origin: appOrigin },
    payload: { email: 'dual-host@example.test', username: 'dual-host', password: 'correct horse battery staple' },
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(mailer.messages.findLast((message) => message.type === 'verification').accountOrigin, appOrigin);
});

function authHeaders(client) {
  return { origin, cookie: client.cookie, 'x-together-csrf': client.csrf };
}

test('hosted moments cannot add an unpaid extra place through a direct update', async (t) => {
  const billing = { async assertLocationCapacity() { throw new PlatformError(409, 'location_payment_required', 'Another place needs an active monthly place add-on.'); } };
  const { app, mailer, pool } = await testPlatform({
    billing,
    configOverrides: { BILLING_ENABLED: 'true', STRIPE_ENVIRONMENT: 'test', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake', STRIPE_ADDITIONAL_PERSON_PRICE_ID: 'price_person_test', MOMENT_LOCATION_BILLING_ENABLED: 'true', STRIPE_ADDITIONAL_LOCATION_PRICE_ID: 'price_location_test' },
  });
  t.after(async () => { await app.close(); await pool.end(); });
  const alice = await register(app, mailer, { email: 'place-owner@example.test', username: 'place-owner' });
  const journeyResponse = await app.inject({ method: 'POST', url: '/api/v1/journeys', headers: authHeaders(alice), payload: { name: 'A place to return to', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 } });
  const journey = journeyResponse.json().data.journey;
  const created = await app.inject({ method: 'POST', url: `/api/v1/journeys/${journey.id}/moments`, headers: authHeaders(alice), payload: { kind: 'memory', title: 'One held place', detail: '', occurredOn: '2026-08-02', visibility: 'shared-now', moneyCents: null, moneyCurrency: '', locations: [{ label: 'First place' }] } });
  assert.equal(created.statusCode, 201, created.body);
  const moment = created.json().data.moment;
  const rejected = await app.inject({ method: 'PATCH', url: `/api/v1/journeys/${journey.id}/moments/${moment.id}`, headers: authHeaders(alice), payload: { kind: moment.kind, kindLabel: moment.kindLabel, title: moment.title, detail: moment.detail, occurredOn: moment.occurredOn, visibility: moment.visibility, moneyCents: moment.moneyCents, moneyCurrency: moment.moneyCurrency, version: moment.version, locations: [{ label: 'First place' }, { label: 'Unpaid extra place' }] } });
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.equal(rejected.json().error.code, 'location_payment_required');
});

test('hosted moment images can be named, retrieved, and removed by an authorized journeyer', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const alice = await register(app, mailer, { email: 'image-owner@example.test', username: 'image-owner' });
  const journeyResponse = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: authHeaders(alice),
    payload: { name: 'A place for a photo', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 },
  });
  assert.equal(journeyResponse.statusCode, 201, journeyResponse.body);
  const journey = journeyResponse.json().data.journey;
  const momentResponse = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journey.id}/moments`, headers: authHeaders(alice),
    payload: { kind: 'memory', title: 'A photo worth holding', detail: '', occurredOn: '2026-08-02', visibility: 'shared-now', moneyCents: null, moneyCurrency: '' },
  });
  assert.equal(momentResponse.statusCode, 201, momentResponse.body);
  const moment = momentResponse.json().data.moment;
  const uploadResponse = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journey.id}/moments/${moment.id}/images`,
    headers: { ...authHeaders(alice), 'content-type': 'image/png', 'x-together-image-name': encodeURIComponent('A quiet photo.png') },
    payload: Buffer.from('image-bytes'),
  });
  assert.equal(uploadResponse.statusCode, 201, uploadResponse.body);
  const image = uploadResponse.json().data.image;
  assert.equal(image.filename, 'A quiet photo.png');
  const fetched = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/moments/${moment.id}/images/${image.id}`, headers: { cookie: alice.cookie } });
  assert.equal(fetched.statusCode, 200, fetched.body);
  assert.equal(fetched.headers['content-type'], 'image/png');
  assert.deepEqual(fetched.rawPayload, Buffer.from('image-bytes'));
  const removed = await app.inject({ method: 'DELETE', url: `/api/v1/journeys/${journey.id}/moments/${moment.id}/images/${image.id}`, headers: authHeaders(alice) });
  assert.equal(removed.statusCode, 204, removed.body);
  const retained = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/moments/${moment.id}/images/${image.id}`, headers: { cookie: alice.cookie } });
  assert.equal(retained.statusCode, 200, retained.body);
});

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
      payload: { kind: 'memory', title: 'We made room to listen', detail: 'A shared truth held before the invitation was accepted.', occurredOn: '2026-08-22', moneyCents: 110, moneyCurrency: '', locations: [{ label: 'A quiet bench', latitude: 39.7392, longitude: -104.9903, accuracyMeters: 25 }] },
    });
    assert.equal(response.statusCode, 201, response.body);
    firstMoment = response.json().data.moment;
    assert.equal(firstMoment.visibility, 'shared-now');
    assert.equal(firstMoment.moneyCurrency, '');
    assert.equal(firstMoment.locations[0].label, 'A quiet bench');
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

  await t.test('TC-00032: Shared moments can hold everyday calls and learning', async () => {
    for (const kind of ['learned-something', 'call-me', 'called-you']) {
      const response = await app.inject({
        method: 'POST', url: `/api/v1/journeys/${journey.id}/moments`, headers: authHeaders(alice),
        payload: { kind, title: 'A small thing worth holding', detail: '', occurredOn: '2026-08-25', moneyCents: null },
      });
      assert.equal(response.statusCode, 201, response.body);
      assert.equal(response.json().data.moment.kind, kind);
    }
  });

  await t.test('TC-00040: Journey settings sends an invitation', async () => {
    const response = await app.inject({ method: 'POST', url: `/api/v1/journeys/${journey.id}/invitations`, headers: authHeaders(alice), payload: { email: 'tc-b@example.test' } });
    assert.equal(response.statusCode, 202, response.body);
    invitationToken = mailer.messages.findLast((message) => message.type === 'invitation' && message.to === 'tc-b@example.test').token;
    assert.equal(mailer.messages.findLast((message) => message.type === 'invitation' && message.to === 'tc-b@example.test').accountOrigin, origin);
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
    assert.equal(edited.locations[0].label, 'A quiet bench');
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

test('hosted moments enforce private, shared-now, and share-later visibility between two accounts', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });

  const alice = await register(app, mailer, { email: 'visibility-a@example.test', username: 'visibility-a' });
  const bob = await register(app, mailer, { email: 'visibility-b@example.test', username: 'visibility-b' });
  const created = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: authHeaders(alice),
    payload: { name: 'Visibility proof', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 },
  });
  const journey = created.json().data.journey;
  await app.inject({ method: 'POST', url: `/api/v1/journeys/${journey.id}/invitations`, headers: authHeaders(alice), payload: { email: 'visibility-b@example.test' } });
  const invitationToken = mailer.messages.findLast((message) => message.type === 'invitation' && message.to === 'visibility-b@example.test').token;
  await app.inject({ method: 'POST', url: `/api/v1/invitations/${invitationToken}/accept`, headers: authHeaders(bob) });

  async function createMoment(client, visibility, title, locations = [], theme = visibility === 'shared-now' ? 'flexoki' : 'green') {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/journeys/${journey.id}/moments`, headers: authHeaders(client),
      payload: { kind: 'memory', title, detail: `${title} detail`, occurredOn: '2026-08-30', visibility, theme, moneyCents: null, moneyCurrency: '', locations },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().data.moment;
  }

  const alicePrivate = await createMoment(alice, 'private', 'Only Alice can name this', [{ label: 'Alice private place' }]);
  let aliceLater = await createMoment(alice, 'share-later', 'Alice will share this later');
  const aliceShared = await createMoment(alice, 'shared-now', 'Both can see this now');
  const bobPrivate = await createMoment(bob, 'private', 'Only Bob can name this', [], 'dark');

  const aliceSnapshot = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/snapshot`, headers: { cookie: alice.cookie } });
  const bobSnapshot = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/snapshot`, headers: { cookie: bob.cookie } });
  assert.deepEqual(aliceSnapshot.json().data.moments.map((moment) => moment.id).sort(), [alicePrivate.id, aliceLater.id, aliceShared.id].sort());
  assert.deepEqual(bobSnapshot.json().data.moments.map((moment) => moment.id).sort(), [aliceShared.id, bobPrivate.id].sort());
  assert.equal(bobSnapshot.json().data.moments.find((moment) => moment.id === aliceShared.id).theme, 'flexoki');
  assert.equal(JSON.stringify(bobSnapshot.json().data.events).includes(alicePrivate.title), false);
  assert.equal(JSON.stringify(bobSnapshot.json().data.events).includes(aliceLater.title), false);
  assert.equal(JSON.stringify(bobSnapshot.json().data).includes('Alice private place'), false);
  assert.equal(JSON.stringify(bobSnapshot.json().data).includes('green'), false);

  const deniedEdit = await app.inject({
    method: 'PATCH', url: `/api/v1/journeys/${journey.id}/moments/${alicePrivate.id}`, headers: authHeaders(bob),
    payload: { ...alicePrivate, title: 'An unauthorized edit' },
  });
  assert.equal(deniedEdit.statusCode, 404, deniedEdit.body);
  const deniedDelete = await app.inject({
    method: 'DELETE', url: `/api/v1/journeys/${journey.id}/moments/${aliceLater.id}`, headers: authHeaders(bob),
    payload: { version: aliceLater.version },
  });
  assert.equal(deniedDelete.statusCode, 404, deniedDelete.body);

  const cannotUnshare = await app.inject({
    method: 'PATCH', url: `/api/v1/journeys/${journey.id}/moments/${aliceShared.id}`, headers: authHeaders(alice),
    payload: { ...aliceShared, visibility: 'private' },
  });
  assert.equal(cannotUnshare.statusCode, 400, cannotUnshare.body);
  assert.equal(cannotUnshare.json().error.code, 'invalid_visibility_transition');

  const themedShared = await app.inject({
    method: 'PATCH', url: `/api/v1/journeys/${journey.id}/moments/${aliceShared.id}`, headers: authHeaders(bob),
    payload: { ...aliceShared, theme: 'dark' },
  });
  assert.equal(themedShared.statusCode, 200, themedShared.body);
  const themeEventSnapshot = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/snapshot`, headers: { cookie: alice.cookie } });
  const themeEvent = themeEventSnapshot.json().data.events.find((event) => event.action === 'moment_theme_changed' && event.entityId === aliceShared.id);
  assert.deepEqual(themeEvent.before, { theme: 'flexoki' });
  assert.deepEqual(themeEvent.after, { theme: 'dark' });
  assert.equal(JSON.stringify(themeEvent).includes(aliceShared.title), false);

  const heldPrivate = await app.inject({
    method: 'PATCH', url: `/api/v1/journeys/${journey.id}/moments/${alicePrivate.id}`, headers: authHeaders(alice),
    payload: { ...alicePrivate, visibility: 'share-later' },
  });
  assert.equal(heldPrivate.statusCode, 200, heldPrivate.body);
  assert.equal(heldPrivate.json().data.moment.visibility, 'share-later');
  assert.equal(heldPrivate.json().data.moment.locations[0].label, 'Alice private place');

  const themedPrivate = await app.inject({
    method: 'PATCH', url: `/api/v1/journeys/${journey.id}/moments/${alicePrivate.id}`, headers: authHeaders(alice),
    payload: { ...heldPrivate.json().data.moment, theme: 'flexoki' },
  });
  assert.equal(themedPrivate.statusCode, 200, themedPrivate.body);
  assert.equal(themedPrivate.json().data.moment.theme, 'flexoki');

  const opened = await app.inject({
    method: 'PATCH', url: `/api/v1/journeys/${journey.id}/moments/${aliceLater.id}`, headers: authHeaders(alice),
    payload: { ...aliceLater, visibility: 'shared-now' },
  });
  assert.equal(opened.statusCode, 200, opened.body);
  aliceLater = opened.json().data.moment;
  const bobAfterShare = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/snapshot`, headers: { cookie: bob.cookie } });
  assert.ok(bobAfterShare.json().data.moments.some((moment) => moment.id === aliceLater.id));
  const sharedEvent = bobAfterShare.json().data.events.find((event) => event.action === 'moment_shared' && event.entityId === aliceLater.id);
  assert.equal(sharedEvent.summary, 'Shared a held moment');
  assert.deepEqual(sharedEvent.before, { visibility: 'share-later' });
  assert.deepEqual(sharedEvent.after, { visibility: 'shared-now' });
  assert.equal(JSON.stringify(sharedEvent).includes(aliceLater.title), false);

  const privateAudit = await pool.query('SELECT action,before_visibility,after_visibility,before_theme,after_theme,created_at FROM private_moment_events WHERE journey_id=$1 AND owner_user_id=$2 ORDER BY created_at,id', [journey.id, alice.user.id]);
  assert.ok(privateAudit.rows.some((event) => event.action === 'moment_added' && event.after_visibility === 'private'));
  assert.ok(privateAudit.rows.some((event) => event.action === 'visibility_changed' && event.before_visibility === 'share-later' && event.after_visibility === null));
  assert.ok(privateAudit.rows.some((event) => event.action === 'moment_theme_changed' && event.before_theme === 'green' && event.after_theme === 'flexoki' && event.created_at));

  const deletedBob = await app.inject({
    method: 'DELETE', url: '/api/v1/account', headers: authHeaders(bob),
    payload: { password: 'correct horse battery staple', confirmation: 'DELETE' },
  });
  assert.equal(deletedBob.statusCode, 204, deletedBob.body);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM journey_moments WHERE id=$1', [bobPrivate.id])).rows[0].count, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM private_moment_events WHERE owner_user_id=$1', [bob.user.id])).rows[0].count, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM journey_moments WHERE id=$1', [aliceShared.id])).rows[0].count, 1);
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
  const recoveryMessage = mailer.messages.findLast((message) => message.type === 'recovery');
  assert.equal(recoveryMessage.accountOrigin, origin);
  const recoveryToken = recoveryMessage.token;
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
  const blockedOwnerDeletion = await app.inject({ method: 'DELETE', url: '/api/v1/account', headers: authHeaders(newAlice), payload: { password: 'a new correct horse battery staple', confirmation: 'DELETE' } });
  assert.equal(blockedOwnerDeletion.statusCode, 409, blockedOwnerDeletion.body);
  assert.equal(blockedOwnerDeletion.json().error.code, 'ownership_transfer_required');
  const transferred = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journey.id}/ownership`, headers: authHeaders(newAlice), payload: { userId: bob.user.id },
  });
  assert.equal(transferred.statusCode, 204, transferred.body);
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

test('synthetic group mode reserves independent places without advertising its ceiling', async (t) => {
  const { app, mailer, pool } = await testPlatform({ configOverrides: { JOURNEY_CAPACITY_MODE: 'test-groups' } });
  t.after(async () => { await app.close(); await pool.end(); });
  const owner = await register(app, mailer, { email: 'group-owner@example.test', username: 'group-owner' });
  const second = await register(app, mailer, { email: 'group-second@example.test', username: 'group-second' });
  const third = await register(app, mailer, { email: 'group-third@example.test', username: 'group-third' });
  const created = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: authHeaders(owner),
    payload: { name: 'A wider circle', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', budgetCents: 0 },
  });
  const journeyId = created.json().data.journey.id;

  for (const email of [second.user.email, third.user.email]) {
    const invitation = await app.inject({ method: 'POST', url: `/api/v1/journeys/${journeyId}/invitations`, headers: authHeaders(owner), payload: { email } });
    assert.equal(invitation.statusCode, 202, invitation.body);
  }
  let snapshot = (await app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: { cookie: owner.cookie } })).json().data;
  assert.equal(snapshot.invitations.filter((invitation) => invitation.status === 'pending').length, 2);
  assert.deepEqual(snapshot.capacity, { peopleHere: 1, openInvitations: 2, canInvite: true, mode: 'test-groups', unpaidCapacityMode: 'read-only', restingMemberIds: [] });
  assert.equal(Object.hasOwn(snapshot.capacity, 'limit'), false);

  for (const client of [second, third]) {
    const token = mailer.messages.findLast((message) => message.type === 'invitation' && message.to === client.user.email).token;
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/invitations/${token}/accept`, headers: authHeaders(client) });
    assert.equal(accepted.statusCode, 200, accepted.body);
  }
  snapshot = (await app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: { cookie: owner.cookie } })).json().data;
  assert.equal(snapshot.members.length, 3);
  assert.equal(snapshot.capacity.peopleHere, 3);
  assert.equal(snapshot.capacity.openInvitations, 0);

  const existingMember = await app.inject({ method: 'POST', url: `/api/v1/journeys/${journeyId}/invitations`, headers: authHeaders(owner), payload: { email: second.user.email } });
  assert.equal(existingMember.statusCode, 409);
  assert.equal(existingMember.json().error.code, 'already_member');

  for (let index = 0; index < 98; index += 1) {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/journeys/${journeyId}/invitations`, headers: authHeaders(owner),
      payload: { email: `waiting-${String(index).padStart(2, '0')}@example.test` },
    });
    assert.equal(response.statusCode, 202, `${index}: ${response.body}`);
  }
  const full = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journeyId}/invitations`, headers: authHeaders(owner), payload: { email: 'one-too-many@example.test' },
  });
  assert.equal(full.statusCode, 409, full.body);
  assert.equal(full.json().error.code, 'journey_full');
  snapshot = (await app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: { cookie: owner.cookie } })).json().data;
  assert.deepEqual(snapshot.capacity, { peopleHere: 3, openInvitations: 98, canInvite: false, mode: 'test-groups', unpaidCapacityMode: 'read-only', restingMemberIds: [] });
});

test('public service routes expose health and only the intended static app', async (t) => {
  const { app, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/readyz' })).statusCode, 200);
  const root = await app.inject({ method: 'GET', url: '/' });
  assert.match(root.body, /Together Ledger/);
  assert.match(root.body, /together-accounts-enabled" content="true"/);
  assert.match(root.body, new RegExp(`together-api-origin" content="${apiOrigin}"`));
  assert.equal((await app.inject({ method: 'GET', url: '/src/app.js' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/src/api.js' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/server/platform.js' })).statusCode, 404);
});

test('a same-origin deployment serves a relative API origin instead of the checked-in production value', async (t) => {
  const { app, pool } = await testPlatform({ configOverrides: { API_ORIGIN: '' } });
  t.after(async () => { await app.close(); await pool.end(); });
  const root = await app.inject({ method: 'GET', url: '/' });
  assert.match(root.body, /together-api-origin" content=""/);
  assert.doesNotMatch(root.body, /content="https:\/\/api\.together-ledger\.com"/);
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

test('unpaid capacity rests the journeyers beyond what is covered, and never the owner', async (t) => {
  const { app, mailer, pool } = await testPlatform({ configOverrides: { JOURNEY_CAPACITY_MODE: 'billing', BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake', STRIPE_ADDITIONAL_PERSON_PRICE_ID: 'price_fake' } });
  t.after(async () => { await app.close(); await pool.end(); });
  const owner = await register(app, mailer, { email: 'rest-owner@example.test', username: 'rest-owner' });
  const second = await register(app, mailer, { email: 'rest-second@example.test', username: 'rest-second' });
  const third = await register(app, mailer, { email: 'rest-third@example.test', username: 'rest-third' });
  const created = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: authHeaders(owner),
    payload: { name: 'A journey that outgrew its payment', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', budgetCents: 0 },
  });
  const journeyId = created.json().data.journey.id;

  // Two journeyers joined while capacity was paid for. The payment has since lapsed, so the
  // journey now holds three people against the two that are included.
  await pool.query('INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,$3,$4)', [journeyId, second.user.id, 'member', '2026-09-08T10:00:00.000Z']);
  await pool.query('INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,$3,$4)', [journeyId, third.user.id, 'member', '2026-09-09T10:00:00.000Z']);

  const capacity = (await app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: { cookie: owner.cookie } })).json().data.capacity;
  assert.equal(capacity.peopleHere, 3);
  assert.equal(capacity.unpaidCapacityMode, 'read-only');
  // One person beyond the included two, and by default it is the one who joined most recently.
  assert.deepEqual(capacity.restingMemberIds, [third.user.id]);
  assert.ok(!capacity.restingMemberIds.includes(owner.user.id), 'the owner holds the journey and never rests');

  // Resting pauses changes, and says so without treating the person as forbidden.
  const blocked = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journeyId}/moments`, headers: authHeaders(third),
    payload: { kind: 'memory', kindLabel: '', title: 'Something I wanted to add', detail: '', occurredOn: '2026-09-10', visibility: 'private', theme: '', moneyCents: null, moneyCurrency: '', locations: [] },
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().error.code, 'capacity_resting');
  assert.match(blocked.json().error.message, /Nothing has been removed/);

  // Reading is untouched: resting is not removal, and history stays visible.
  const stillReads = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: { cookie: third.cookie } });
  assert.equal(stillReads.statusCode, 200, stillReads.body);

  // A journeyer who is covered is unaffected.
  const allowed = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journeyId}/moments`, headers: authHeaders(second),
    payload: { kind: 'memory', kindLabel: '', title: 'Still able to hold this', detail: '', occurredOn: '2026-09-10', visibility: 'private', theme: '', moneyCents: null, moneyCurrency: '', locations: [] },
  });
  assert.equal(allowed.statusCode, 201, allowed.body);
});

test('the owner chooses who rests, overriding the order people joined in', async (t) => {
  const { app, mailer, pool } = await testPlatform({ configOverrides: { JOURNEY_CAPACITY_MODE: 'billing', BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake', STRIPE_ADDITIONAL_PERSON_PRICE_ID: 'price_fake' } });
  t.after(async () => { await app.close(); await pool.end(); });
  const owner = await register(app, mailer, { email: 'choose-owner@example.test', username: 'choose-owner' });
  const second = await register(app, mailer, { email: 'choose-second@example.test', username: 'choose-second' });
  const third = await register(app, mailer, { email: 'choose-third@example.test', username: 'choose-third' });
  const created = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: authHeaders(owner),
    payload: { name: 'A journey with a choice to make', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', budgetCents: 0 },
  });
  const journeyId = created.json().data.journey.id;
  await pool.query('INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,$3,$4)', [journeyId, second.user.id, 'member', '2026-09-08T10:00:00.000Z']);
  await pool.query('INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,$3,$4)', [journeyId, third.user.id, 'member', '2026-09-09T10:00:00.000Z']);

  // The owner puts the earlier joiner first in the queue to rest. Joining order no longer decides.
  await pool.query('UPDATE journey_members SET rest_order=1 WHERE journey_id=$1 AND user_id=$2', [journeyId, second.user.id]);

  const capacity = (await app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: { cookie: owner.cookie } })).json().data.capacity;
  assert.deepEqual(capacity.restingMemberIds, [second.user.id]);
});
