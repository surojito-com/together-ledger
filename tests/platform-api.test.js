import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { newDb } from 'pg-mem';
import ts from 'typescript';
import { buildApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { MemoryMailer } from '../server/mailer.js';
import { PlatformError, PlatformService } from '../server/platform.js';
import { loggerOptions, redactUrl } from '../server/log-options.js';
import { stripPhotoMetadata } from '../src/photo-metadata.js';
import { jpegOfRestarts, webpOfEmptyChunks } from './fixtures/photos/crafted.js';

const origin = 'http://127.0.0.1:4174';
const appOrigin = 'https://app.together-ledger.com';
const apiOrigin = 'https://api.example.test';

async function testPlatform({ mailer = new MemoryMailer(), configOverrides = {}, billing, logger = false, now = () => new Date('2026-08-02T12:00:00.000Z'), beforeMigration029 } = {}) {
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
  await pool.query(await readFile(new URL('../server/migrations/022_agree-together-before-adding-someone.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/023_let-a-phone-carry-its-own-key.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/024_let-google-and-apple-open-an-account.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/025_revoke-sign-in-with-apple-when-an-account-is-deleted.sql', import.meta.url), 'utf8'));
  await pool.query(await readFile(new URL('../server/migrations/026_remember-a-refused-apple-deletion.sql', import.meta.url), 'utf8'));
  if (beforeMigration029) await beforeMigration029(pool);
  await pool.query(await readFile(new URL('../server/migrations/029_rest-read-only-and-let-the-payer-ask-for-time.sql', import.meta.url), 'utf8'));
  // pg-mem cannot parse NOT VALID. Real PostgreSQL runs 030 as written, and
  // tests/postgres-integration.test.js checks it keeps a week already given.
  await pool.query((await readFile(new URL('../server/migrations/030_ask-for-six-weeks-a-year.sql', import.meta.url), 'utf8')).replace(') NOT VALID;', ');'));
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
  const platform = new PlatformService({ pool, config, mailer, now });
  const app = await buildApp({ platform, config, logger, ...(billing ? { billing } : {}) });
  return { app, mailer, pool, platform };
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

async function signIn(app, identifier) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { identifier, password: 'correct horse battery staple' } });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: cookieFrom(response), csrf: response.json().data.csrfToken };
}

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
  const photo = await readFile(new URL('./fixtures/photos/sideways-with-gps.png', import.meta.url));
  const inserted = recordImageInserts(pool);
  const uploadResponse = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journey.id}/moments/${moment.id}/images`,
    headers: { ...authHeaders(alice), 'content-type': 'image/png', 'x-together-image-name': encodeURIComponent('A quiet photo.png') },
    payload: photo,
  });
  assert.equal(uploadResponse.statusCode, 201, uploadResponse.body);
  const image = uploadResponse.json().data.image;
  assert.equal(image.filename, 'A quiet photo.png');
  const fetched = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/moments/${moment.id}/images/${image.id}`, headers: { cookie: alice.cookie } });
  assert.equal(fetched.statusCode, 200, fetched.body);
  assert.equal(fetched.headers['content-type'], 'image/png');
  assert.deepEqual(inserted[0], Buffer.from(stripPhotoMetadata(photo).bytes));
  const removed = await app.inject({ method: 'DELETE', url: `/api/v1/journeys/${journey.id}/moments/${moment.id}/images/${image.id}`, headers: authHeaders(alice) });
  assert.equal(removed.statusCode, 204, removed.body);
  const retained = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/moments/${moment.id}/images/${image.id}`, headers: { cookie: alice.cookie } });
  assert.equal(retained.statusCode, 200, retained.body);
});

// pg-mem cannot carry a binary bytea: every byte that is not UTF-8 comes back as U+FFFD. So these
// tests check the bytes the server hands the database; tests/postgres-integration.test.js proves
// the same photo comes back out of a real PostgreSQL unchanged.
function recordImageInserts(pool) {
  const inserted = [];
  const query = pool.query.bind(pool);
  pool.query = (text, values, ...rest) => {
    if (typeof text === 'string' && text.startsWith('INSERT INTO moment_images')) inserted.push(values[6]);
    return query(text, values, ...rest);
  };
  return inserted;
}

// The device removes a photo's location and camera details before it is sent (#258). The server
// does it again, because an older client or a hand-made request may not have.
test('a photo sent with its metadata is stored without it, and one that cannot be read is refused', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const alice = await register(app, mailer, { email: 'photo-sender@example.test', username: 'photo-sender' });
  const journeyResponse = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: authHeaders(alice),
    payload: { name: 'Photos from far away', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 },
  });
  const journey = journeyResponse.json().data.journey;
  const upload = async (file, contentType) => {
    const momentResponse = await app.inject({
      method: 'POST', url: `/api/v1/journeys/${journey.id}/moments`, headers: authHeaders(alice),
      payload: { kind: 'memory', title: `A photo, ${file}`, detail: '', occurredOn: '2026-10-07', visibility: 'shared-now', moneyCents: null, moneyCurrency: '' },
    });
    const moment = momentResponse.json().data.moment;
    const bytes = file.includes('.') ? await readFile(new URL(`./fixtures/photos/${file}`, import.meta.url)) : Buffer.from(file);
    const response = await app.inject({
      method: 'POST', url: `/api/v1/journeys/${journey.id}/moments/${moment.id}/images`,
      headers: { ...authHeaders(alice), 'content-type': contentType }, payload: bytes,
    });
    if (response.statusCode !== 201) return { response };
    const image = response.json().data.image;
    const fetched = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/moments/${moment.id}/images/${image.id}`, headers: { cookie: alice.cookie } });
    const stored = await pool.query('SELECT content_type, content_length FROM moment_images WHERE id=$1', [image.id]);
    return { response, image, bytes, fetched, stored: { ...stored.rows[0], bytes: inserted.at(-1) } };
  };
  const inserted = recordImageInserts(pool);

  for (const [file, contentType] of [['sideways-with-gps.jpg', 'image/jpeg'], ['progressive-with-gps.jpg', 'image/jpeg'], ['sideways-with-gps.png', 'image/png'], ['sideways-with-gps.webp', 'image/webp']]) {
    const { response, bytes, fetched, stored } = await upload(file, contentType);
    assert.equal(response.statusCode, 201, `${file}: ${response.body}`);
    const clean = Buffer.from(stripPhotoMetadata(bytes).bytes);
    assert.ok(clean.length < bytes.length);
    assert.deepEqual(stored.bytes, clean, `${file} is stored cleaned`);
    assert.equal(Number(stored.content_length), clean.length);
    assert.equal(stored.content_type, contentType);
    assert.equal(fetched.statusCode, 200, fetched.body);
    for (const word of ['Kolkata', 'Fixture Camera Co', 'SN-FIXTURE-0042', 'ns.adobe.com/xap']) assert.equal(stored.bytes.includes(word), false, `${file} still carries ${word}`);
  }

  // A PNG labelled as a JPEG is stored, and served, as the PNG it is.
  const relabelled = await upload('sideways-with-gps.png', 'image/jpeg');
  assert.equal(relabelled.response.statusCode, 201, relabelled.response.body);
  assert.equal(relabelled.image.contentType, 'image/png');
  assert.equal(relabelled.fetched.headers['content-type'], 'image/png');

  const unreadable = await upload('not a photo at all', 'image/jpeg');
  assert.equal(unreadable.response.statusCode, 400, unreadable.response.body);
  assert.equal(unreadable.response.json().error.code, 'unreadable_image');
});

// A file built to make the strip expensive is refused quickly, and only a journey member's upload
// is read at all (#332 review).
test('a crafted 25 MB upload is refused at once, and a non-member never gets it read', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const alice = await register(app, mailer, { email: 'crafted-owner@example.test', username: 'crafted-owner' });
  const bob = await register(app, mailer, { email: 'crafted-stranger@example.test', username: 'crafted-stranger' });
  const journey = (await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: authHeaders(alice),
    payload: { name: 'Not for strangers', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 },
  })).json().data.journey;
  const moment = (await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journey.id}/moments`, headers: authHeaders(alice),
    payload: { kind: 'memory', title: 'A moment', detail: '', occurredOn: '2026-10-08', visibility: 'shared-now', moneyCents: null, moneyCurrency: '' },
  })).json().data.moment;
  const send = (who, contentType, payload) => app.inject({ method: 'POST', url: `/api/v1/journeys/${journey.id}/moments/${moment.id}/images`, headers: { ...authHeaders(who), 'content-type': contentType }, payload });

  for (const [contentType, payload] of [['image/jpeg', jpegOfRestarts()], ['image/webp', webpOfEmptyChunks()]]) {
    const started = performance.now();
    const response = await send(alice, contentType, payload);
    const elapsed = performance.now() - started;
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, 'unreadable_image');
    assert.ok(elapsed < 3000, `${contentType} took ${Math.round(elapsed)} ms`);
  }

  // Refused for access, not for the file: a stranger's upload never reaches the strip.
  const stranger = await send(bob, 'image/jpeg', jpegOfRestarts());
  assert.equal(stranger.statusCode, 403, stranger.body);
  assert.equal(stranger.json().error.code, 'forbidden');
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
    // Without billing no extra place can be used, so the snapshot tells the phone not to sell one (#340).
    assert.deepEqual(body.extras, { place: false });
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

test('a deletion can be applied again to a database restored from before it', async (t) => {
  const { app, mailer, pool, platform } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const carol = await register(app, mailer, { email: 'carol@example.test', username: 'carol-restored' });
  const written = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return write.call(process.stderr, chunk, ...rest); };
  try {
    assert.equal(await platform.eraseAccount(carol.user.id), true);
  } finally {
    process.stderr.write = write;
  }
  const logged = written.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((line) => line?.message === 'account deleted');
  assert.deepEqual(logged.map((line) => line.deletedAccountId), [carol.user.id], 'every deletion path logs the id a restore needs');
  assert.equal(written.join('').includes('carol@example.test'), false, 'never the email');
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { identifier: 'carol@example.test', password: 'correct horse battery staple' } });
  assert.equal(login.statusCode, 401, login.body);
  const row = await pool.query('SELECT email_normalized,display_name,deleted_at FROM users WHERE id=$1', [carol.user.id]);
  assert.equal(row.rows[0].email_normalized, `deleted-${carol.user.id}@invalid.local`);
  assert.equal(row.rows[0].display_name, 'Deleted account');
  assert.ok(row.rows[0].deleted_at);
  assert.equal(await platform.eraseAccount(carol.user.id), false, 're-applying the same list twice is harmless');
});

async function invitedPair(logLines) {
  const logger = { ...loggerOptions, level: 'info', stream: { write: (line) => logLines.push(line) } };
  const setup = await testPlatform({ logger });
  const alice = await register(setup.app, setup.mailer, { email: 'log-alice@example.test', username: 'log-alice' });
  const journeyResponse = await setup.app.inject({ method: 'POST', url: '/api/v1/journeys', headers: authHeaders(alice), payload: { name: 'A place to return to', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 } });
  const journey = journeyResponse.json().data.journey;
  const invited = await setup.app.inject({ method: 'POST', url: `/api/v1/journeys/${journey.id}/invitations`, headers: authHeaders(alice), payload: { email: 'log-bob@example.test' } });
  assert.equal(invited.statusCode, 202, invited.body);
  const token = setup.mailer.messages.findLast((message) => message.type === 'invitation' && message.to === 'log-bob@example.test').token;
  const bob = await register(setup.app, setup.mailer, { email: 'log-bob@example.test', username: 'log-bob' });
  return { ...setup, journey, token, bob };
}

test('an invitation accepted with its token in the body never writes the token to the log', async (t) => {
  const lines = [];
  const { app, pool, journey, token, bob } = await invitedPair(lines);
  t.after(async () => { await app.close(); await pool.end(); });
  const missing = await app.inject({ method: 'POST', url: '/api/v1/invitations/accept', headers: authHeaders(bob), payload: {} });
  assert.equal(missing.statusCode, 400, missing.body);
  assert.equal(missing.json().error.code, 'invalid_invitation');
  const accepted = await app.inject({ method: 'POST', url: '/api/v1/invitations/accept', headers: authHeaders(bob), payload: { token } });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().data.journeyId, journey.id);
  assert.ok(lines.some((line) => line.includes('/api/v1/invitations/accept')), 'the accept request was logged');
  assert.equal(lines.some((line) => line.includes(token)), false, 'the raw token appears nowhere in the log');
});

test('the older path form still works, and its token is masked in the log', async (t) => {
  const lines = [];
  const { app, pool, journey, token, bob } = await invitedPair(lines);
  t.after(async () => { await app.close(); await pool.end(); });
  const accepted = await app.inject({ method: 'POST', url: `/api/v1/invitations/${token}/accept`, headers: authHeaders(bob) });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().data.journeyId, journey.id);
  assert.ok(lines.some((line) => line.includes('/api/v1/invitations/[redacted]/accept')));
  assert.equal(lines.some((line) => line.includes(token)), false, 'the raw token appears nowhere in the log');
});

test('logged addresses mask tokens in the accept path and in link parameters', () => {
  assert.equal(redactUrl('/api/v1/invitations/abc123/accept'), '/api/v1/invitations/[redacted]/accept');
  assert.equal(redactUrl('/api/v1/invitations/abc123/accept?x=1'), '/api/v1/invitations/[redacted]/accept?x=1');
  assert.equal(redactUrl('/api/v1/invitations/accept'), '/api/v1/invitations/accept');
  assert.equal(redactUrl('/api/v1/session?verify=v1&recovery=r2&invite=i3&token=t4&keep=yes'), '/api/v1/session?verify=[redacted]&recovery=[redacted]&invite=[redacted]&token=[redacted]&keep=yes');
  assert.equal(redactUrl('/api/v1/journeys/j1/invitations'), '/api/v1/journeys/j1/invitations');
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
  assert.deepEqual(snapshot.capacity, { peopleHere: 1, openInvitations: 2, canInvite: true, mode: 'test-groups', restingMemberIds: [], restOrder: [], grace: null });
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

  // Growing a group no longer rests on one person. Three journeyers are here now, so a proposal
  // waits on them and reserves nothing while it waits.
  const proposed = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journeyId}/invitations`, headers: authHeaders(owner),
    payload: { email: 'waiting-on-everyone@example.test' },
  });
  assert.equal(proposed.statusCode, 202, proposed.body);
  assert.equal(proposed.json().data.invitationSent, false);
  snapshot = (await app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: { cookie: owner.cookie } })).json().data;
  assert.equal(snapshot.capacity.openInvitations, 0);
  const waiting = snapshot.inviteProposals.find((entry) => entry.email === 'waiting-on-everyone@example.test');
  assert.equal(waiting.status, 'open');
  assert.equal(waiting.pendingCount, 2);

  // The ceiling is still the ceiling, and it is still never advertised. A journey held by one
  // person has nobody else to ask, so there each proposal becomes an invitation as it is made.
  const soloCreated = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: authHeaders(third),
    payload: { name: 'A wider circle still', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', budgetCents: 0 },
  });
  const soloId = soloCreated.json().data.journey.id;
  for (let index = 0; index < 100; index += 1) {
    const response = await app.inject({
      method: 'POST', url: `/api/v1/journeys/${soloId}/invitations`, headers: authHeaders(third),
      payload: { email: `waiting-${String(index).padStart(3, '0')}@example.test` },
    });
    assert.equal(response.statusCode, 202, `${index}: ${response.body}`);
  }
  const full = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${soloId}/invitations`, headers: authHeaders(third), payload: { email: 'one-too-many@example.test' },
  });
  assert.equal(full.statusCode, 409, full.body);
  assert.equal(full.json().error.code, 'journey_full');
  snapshot = (await app.inject({ method: 'GET', url: `/api/v1/journeys/${soloId}/snapshot`, headers: { cookie: third.cookie } })).json().data;
  assert.deepEqual(snapshot.capacity, { peopleHere: 1, openInvitations: 100, canInvite: false, mode: 'test-groups', restingMemberIds: [], restOrder: [], grace: null });
  assert.equal(Object.hasOwn(snapshot.capacity, 'limit'), false);
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
  assert.equal('unpaidCapacityMode' in capacity, false, 'resting is always read-only, so there is no mode to report');
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
  await pool.query('UPDATE journey_members SET rest_order=2 WHERE journey_id=$1 AND user_id=$2', [journeyId, third.user.id]);

  const capacity = (await app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: { cookie: owner.cookie } })).json().data.capacity;
  assert.deepEqual(capacity.restingMemberIds, [second.user.id]);
});

test('read-only resting still shows the shared journey', async (t) => {
  const { app, mailer, pool } = await testPlatform({ configOverrides: { JOURNEY_CAPACITY_MODE: 'billing', BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake', STRIPE_ADDITIONAL_PERSON_PRICE_ID: 'price_fake' } });
  t.after(async () => { await app.close(); await pool.end(); });
  const owner = await register(app, mailer, { email: 'ro-owner@example.test', username: 'ro-owner' });
  const resting = await register(app, mailer, { email: 'ro-resting@example.test', username: 'ro-resting' });
  const extra = await register(app, mailer, { email: 'ro-extra@example.test', username: 'ro-extra' });
  const created = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: authHeaders(owner),
    payload: { name: 'A journey that only pauses writing', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', budgetCents: 0 },
  });
  const journeyId = created.json().data.journey.id;
  await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journeyId}/moments`, headers: authHeaders(owner),
    payload: { kind: 'memory', kindLabel: '', title: 'Still visible while resting', detail: '', occurredOn: '2026-09-10', visibility: 'shared-now', theme: '', moneyCents: null, moneyCurrency: '', locations: [] },
  });
  await pool.query('INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,$3,$4)', [journeyId, resting.user.id, 'member', '2026-09-09T10:00:00.000Z']);
  await pool.query('INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,$3,$4)', [journeyId, extra.user.id, 'member', '2026-09-08T10:00:00.000Z']);
  await pool.query('UPDATE journey_members SET rest_order=1 WHERE journey_id=$1 AND user_id=$2', [journeyId, resting.user.id]);
  await pool.query('UPDATE journey_members SET rest_order=2 WHERE journey_id=$1 AND user_id=$2', [journeyId, extra.user.id]);

  const snapshot = (await app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: { cookie: resting.cookie } })).json().data;
  assert.deepEqual(snapshot.capacity.restingMemberIds, [resting.user.id]);
  assert.equal(snapshot.moments.some((moment) => moment.title === 'Still visible while resting'), true);
  // The whole shared record, not only their own words: resting withholds nothing from reading.
  assert.ok(snapshot.events.length > 0);
  // Nobody but the owner learns the resting order (#281).
  assert.equal('restOrder' in snapshot.capacity, false);
});

async function groupOfThree(overrides = {}) {
  const context = await testPlatform({ configOverrides: { JOURNEY_CAPACITY_MODE: 'test-groups' }, ...overrides });
  const { app, mailer } = context;
  const owner = await register(app, mailer, { email: 'consent-owner@example.test', username: 'consent-owner' });
  const second = await register(app, mailer, { email: 'consent-second@example.test', username: 'consent-second' });
  const third = await register(app, mailer, { email: 'consent-third@example.test', username: 'consent-third' });
  const created = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: authHeaders(owner),
    payload: { name: 'A journey held together', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', budgetCents: 0 },
  });
  const journeyId = created.json().data.journey.id;
  // The owner is alone, so there is nobody to ask and the first invitation goes straight out.
  // By the time the third is proposed the second is here, and has to agree to them.
  for (const client of [second, third]) {
    const proposal = await app.inject({ method: 'POST', url: `/api/v1/journeys/${journeyId}/invitations`, headers: authHeaders(owner), payload: { email: client.user.email } });
    assert.equal(proposal.statusCode, 202, proposal.body);
    if (!proposal.json().data.invitationSent) {
      const decision = await app.inject({
        method: 'POST', url: `/api/v1/journeys/${journeyId}/invite-proposals/${proposal.json().data.proposalId}/decision`,
        headers: authHeaders(second), payload: { decision: 'agree' },
      });
      assert.equal(decision.statusCode, 202, decision.body);
    }
    const token = mailer.messages.findLast((message) => message.type === 'invitation' && message.to === client.user.email).token;
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/invitations/${token}/accept`, headers: authHeaders(client) });
    assert.equal(accepted.statusCode, 200, accepted.body);
  }
  return { ...context, owner, second, third, journeyId };
}

async function proposalFor(app, client, journeyId, email) {
  const response = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: { cookie: client.cookie } });
  return response.json().data.inviteProposals.find((proposal) => proposal.email === email);
}

test('a new person waits on every journeyer, and a decline is named and dated', async (t) => {
  const { app, mailer, pool, owner, second, third, journeyId } = await groupOfThree();
  t.after(async () => { await app.close(); await pool.end(); });

  // Any journeyer may ask. Nobody, including the owner, may decide it by themselves.
  const sentSoFar = mailer.messages.length;
  const proposed = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journeyId}/invitations`, headers: authHeaders(second),
    payload: { email: 'newcomer@example.test', note: 'My sister, who has been asking after you both.' },
  });
  assert.equal(proposed.statusCode, 202, proposed.body);
  assert.equal(proposed.json().data.invitationSent, false);

  // The person being proposed learns nothing at all while the journey is deciding.
  assert.equal(mailer.messages.some((message) => message.to === 'newcomer@example.test'), false);
  const notified = mailer.messages.slice(sentSoFar).filter((message) => message.type === 'invite-proposal').map((message) => message.to);
  assert.deepEqual(notified.sort(), [owner.user.email, third.user.email].sort());

  let proposal = await proposalFor(app, owner, journeyId, 'newcomer@example.test');
  assert.equal(proposal.status, 'open');
  assert.equal(proposal.note, 'My sister, who has been asking after you both.');
  assert.equal(proposal.agreedCount, 1);
  assert.equal(proposal.pendingCount, 2);
  assert.equal(proposal.viewerMayDecide, true);
  // Proposing is agreeing, and it is recorded as a decision with a time on it like any other.
  const proposer = proposal.decisions.find((entry) => entry.email === second.user.email);
  assert.equal(proposer.decision, 'agree');
  assert.ok(proposer.requestedAt && proposer.decidedAt);

  const agreed = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journeyId}/invite-proposals/${proposal.id}/decision`,
    headers: authHeaders(owner), payload: { decision: 'agree' },
  });
  assert.equal(agreed.statusCode, 202, agreed.body);
  assert.equal(agreed.json().data.invitationSent, false);
  assert.equal(mailer.messages.some((message) => message.to === 'newcomer@example.test'), false);

  const declined = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journeyId}/invite-proposals/${proposal.id}/decision`,
    headers: authHeaders(third), payload: { decision: 'decline' },
  });
  assert.equal(declined.statusCode, 202, declined.body);

  proposal = await proposalFor(app, owner, journeyId, 'newcomer@example.test');
  assert.equal(proposal.status, 'declined');
  assert.equal(proposal.declinedCount, 1);
  // The record says who declined, and when they were asked as well as when they answered.
  const decliner = proposal.decisions.find((entry) => entry.decision === 'decline');
  assert.equal(decliner.email, third.user.email);
  assert.ok(decliner.displayName);
  assert.ok(decliner.requestedAt && decliner.decidedAt);
  assert.equal(mailer.messages.some((message) => message.to === 'newcomer@example.test'), false);

  // One no settles it: the question cannot be reopened by answering it again.
  const again = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journeyId}/invite-proposals/${proposal.id}/decision`,
    headers: authHeaders(owner), payload: { decision: 'agree' },
  });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error.code, 'proposal_closed');
});

test('when everyone agrees the newcomer is invited by email exactly as before', async (t) => {
  const { app, mailer, pool, owner, second, third, journeyId } = await groupOfThree();
  t.after(async () => { await app.close(); await pool.end(); });
  const newcomer = await register(app, mailer, { email: 'fourth@example.test', username: 'fourth' });

  await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journeyId}/invitations`, headers: authHeaders(owner),
    payload: { email: newcomer.user.email },
  });
  let proposal = await proposalFor(app, owner, journeyId, newcomer.user.email);
  const secondAgrees = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journeyId}/invite-proposals/${proposal.id}/decision`,
    headers: authHeaders(second), payload: { decision: 'agree' },
  });
  assert.equal(secondAgrees.json().data.invitationSent, false);
  const lastAgrees = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journeyId}/invite-proposals/${proposal.id}/decision`,
    headers: authHeaders(third), payload: { decision: 'agree' },
  });
  assert.equal(lastAgrees.statusCode, 202, lastAgrees.body);
  assert.equal(lastAgrees.json().data.invitationSent, true);

  proposal = await proposalFor(app, owner, journeyId, newcomer.user.email);
  assert.equal(proposal.status, 'agreed');
  assert.equal(proposal.agreedCount, 3);

  // The invitation itself is unchanged: the newcomer still joins from the mail they are sent.
  const invitation = mailer.messages.findLast((message) => message.type === 'invitation' && message.to === newcomer.user.email);
  assert.ok(invitation.token);
  const accepted = await app.inject({ method: 'POST', url: `/api/v1/invitations/${invitation.token}/accept`, headers: authHeaders(newcomer) });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const snapshot = (await app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: { cookie: owner.cookie } })).json().data;
  assert.equal(snapshot.members.length, 4);
});

test('a proposal nobody answers lapses after a month, and adds nobody', async (t) => {
  let clock = new Date('2026-08-02T12:00:00.000Z');
  const { app, mailer, pool, owner, journeyId } = await groupOfThree({ now: () => clock });
  t.after(async () => { await app.close(); await pool.end(); });

  await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journeyId}/invitations`, headers: authHeaders(owner),
    payload: { email: 'never-answered@example.test' },
  });
  let proposal = await proposalFor(app, owner, journeyId, 'never-answered@example.test');
  assert.equal(proposal.status, 'open');

  // A month really passes here, which also ends the sessions open at the time, so both people
  // sign in again on the other side of it exactly as they would have to.
  clock = new Date('2026-09-02T12:00:01.000Z');
  const ownerAgain = await signIn(app, 'consent-owner');
  const thirdAgain = await signIn(app, 'consent-third');
  proposal = await proposalFor(app, ownerAgain, journeyId, 'never-answered@example.test');
  // Silence is not agreement, and it never becomes agreement by being left long enough.
  assert.equal(proposal.status, 'lapsed');
  assert.equal(mailer.messages.some((message) => message.to === 'never-answered@example.test'), false);

  const late = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journeyId}/invite-proposals/${proposal.id}/decision`,
    headers: authHeaders(thirdAgain), payload: { decision: 'agree' },
  });
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().error.code, 'proposal_lapsed');
  assert.equal(mailer.messages.some((message) => message.to === 'never-answered@example.test'), false);
});

test('a journey of one has nobody to ask, so inviting is unchanged for two people', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const owner = await register(app, mailer, { email: 'pair-owner@example.test', username: 'pair-owner' });
  const created = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: authHeaders(owner),
    payload: { name: 'Just the two of us', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', budgetCents: 0 },
  });
  const journeyId = created.json().data.journey.id;
  const invited = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${journeyId}/invitations`, headers: authHeaders(owner),
    payload: { email: 'pair-second@example.test' },
  });
  assert.equal(invited.statusCode, 202, invited.body);
  assert.equal(invited.json().data.invitationSent, true);
  assert.ok(mailer.messages.findLast((message) => message.type === 'invitation' && message.to === 'pair-second@example.test'));
  // Nobody was asked to agree, because there was nobody else here to ask.
  assert.equal(mailer.messages.some((message) => message.type === 'invite-proposal'), false);
});

const billingConfig = { JOURNEY_CAPACITY_MODE: 'billing', BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake', STRIPE_ADDITIONAL_PERSON_PRICE_ID: 'price_fake' };

// The web's and the phone's moveInOrder: swap with the neighbour.
function moved(order, memberUserId, direction) {
  const next = [...order];
  const from = next.indexOf(memberUserId);
  [next[from], next[from + direction]] = [next[from + direction], next[from]];
  return next;
}

test('the owner sets and sees the resting order, and cannot put themselves in the queue', async (t) => {
  const { app, mailer, pool } = await testPlatform({ configOverrides: billingConfig });
  t.after(async () => { await app.close(); await pool.end(); });
  const owner = await register(app, mailer, { email: 'set-owner@example.test', username: 'set-owner' });
  const first = await register(app, mailer, { email: 'set-first@example.test', username: 'set-first' });
  const second = await register(app, mailer, { email: 'set-second@example.test', username: 'set-second' });
  const third = await register(app, mailer, { email: 'set-third@example.test', username: 'set-third' });
  const created = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: authHeaders(owner),
    payload: { name: 'A journey with a choice', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', budgetCents: 0 },
  });
  const journeyId = created.json().data.journey.id;
  await pool.query('INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,$3,$4)', [journeyId, first.user.id, 'member', '2026-09-07T10:00:00.000Z']);
  await pool.query('INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,$3,$4)', [journeyId, second.user.id, 'member', '2026-09-08T10:00:00.000Z']);
  await pool.query('INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,$3,$4)', [journeyId, third.user.id, 'member', '2026-09-09T10:00:00.000Z']);
  const ownerCapacity = async () => (await app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: { cookie: owner.cookie } })).json().data.capacity;

  // Default: nobody was ranked. The newest rests first, so the first to join is the one who
  // keeps adding with the owner, and the owner is told that order (#281).
  const before = await ownerCapacity();
  assert.deepEqual(before.restOrder, [third.user.id, second.user.id, first.user.id]);
  assert.deepEqual(before.restingMemberIds, [third.user.id, second.user.id]);

  // Moving someone twice: the second move starts from where the first one left them.
  const once = await app.inject({
    method: 'PATCH', url: `/api/v1/journeys/${journeyId}/unpaid-capacity`, headers: authHeaders(owner),
    payload: { restOrder: moved(before.restOrder, first.user.id, -1) },
  });
  assert.equal(once.statusCode, 200, once.body);
  assert.deepEqual((await ownerCapacity()).restOrder, [third.user.id, first.user.id, second.user.id]);
  const twice = await app.inject({
    method: 'PATCH', url: `/api/v1/journeys/${journeyId}/unpaid-capacity`, headers: authHeaders(owner),
    payload: { restOrder: moved((await ownerCapacity()).restOrder, first.user.id, -1) },
  });
  assert.equal(twice.statusCode, 200, twice.body);
  assert.deepEqual(twice.json().data.capacity.restOrder, [first.user.id, third.user.id, second.user.id]);
  assert.deepEqual(twice.json().data.capacity.restingMemberIds, [first.user.id, third.user.id]);

  // Nobody but the owner learns the order.
  const memberView = (await app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: { cookie: first.cookie } })).json().data.capacity;
  assert.equal('restOrder' in memberView, false);

  // The owner holds the payment, so putting themselves in the queue is refused rather than
  // quietly ignored: a rule that could rest the only person who can fix it is a trap.
  const self = await app.inject({
    method: 'PATCH', url: `/api/v1/journeys/${journeyId}/unpaid-capacity`, headers: authHeaders(owner),
    payload: { restOrder: [owner.user.id] },
  });
  assert.equal(self.statusCode, 400, self.body);
  assert.equal(self.json().error.code, 'invalid_rest_order');
  for (const restOrder of [['someone-not-here'], [second.user.id, second.user.id]]) {
    const refused = await app.inject({ method: 'PATCH', url: `/api/v1/journeys/${journeyId}/unpaid-capacity`, headers: authHeaders(owner), payload: { restOrder } });
    assert.equal(refused.statusCode, 400, refused.body);
  }

  // Fully pausing resting people is gone. A phone that has not updated may still ask for it.
  const paused = await app.inject({
    method: 'PATCH', url: `/api/v1/journeys/${journeyId}/unpaid-capacity`, headers: authHeaders(owner),
    payload: { mode: 'paused' },
  });
  assert.equal(paused.statusCode, 400, paused.body);
  assert.equal(paused.json().error.code, 'invalid_unpaid_capacity_mode');
  const eventsBefore = (await pool.query('SELECT count(*)::int AS count FROM journey_events WHERE journey_id=$1', [journeyId])).rows[0].count;
  const readOnly = await app.inject({
    method: 'PATCH', url: `/api/v1/journeys/${journeyId}/unpaid-capacity`, headers: authHeaders(owner),
    payload: { mode: 'read-only' },
  });
  assert.equal(readOnly.statusCode, 200, readOnly.body);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM journey_events WHERE journey_id=$1', [journeyId])).rows[0].count, eventsBefore, 'asking for what always happens changes nothing');

  // Only the owner decides this.
  const notOwner = await app.inject({
    method: 'PATCH', url: `/api/v1/journeys/${journeyId}/unpaid-capacity`, headers: authHeaders(second),
    payload: { restOrder: [second.user.id] },
  });
  assert.equal(notOwner.statusCode, 403, notOwner.body);

  // The change is attributable, like every other journey change.
  const events = (await app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: { cookie: owner.cookie } })).json().data.events;
  assert.ok(events.some((event) => event.action === 'unpaid_capacity_rest_updated'));
});

test('someone joining later never takes the place of the person the owner chose to keep adding', async (t) => {
  const { app, mailer, pool } = await testPlatform({ configOverrides: billingConfig });
  t.after(async () => { await app.close(); await pool.end(); });
  const owner = await register(app, mailer, { email: 'keep-owner@example.test', username: 'keep-owner' });
  const first = await register(app, mailer, { email: 'keep-first@example.test', username: 'keep-first' });
  const chosen = await register(app, mailer, { email: 'keep-chosen@example.test', username: 'keep-chosen' });
  const later = await register(app, mailer, { email: 'keep-later@example.test', username: 'keep-later' });
  const created = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: authHeaders(owner),
    payload: { name: 'A journey that keeps its choice', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', budgetCents: 0 },
  });
  const journeyId = created.json().data.journey.id;
  await pool.query('INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,$3,$4)', [journeyId, first.user.id, 'member', '2026-09-07T10:00:00.000Z']);
  await pool.query('INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,$3,$4)', [journeyId, chosen.user.id, 'member', '2026-09-08T10:00:00.000Z']);
  const set = await app.inject({
    method: 'PATCH', url: `/api/v1/journeys/${journeyId}/unpaid-capacity`, headers: authHeaders(owner),
    payload: { restOrder: [first.user.id, chosen.user.id] },
  });
  assert.equal(set.statusCode, 200, set.body);

  // Someone joins after the owner chose. They have no place in the order yet, and they rest
  // first rather than taking the chosen person's.
  await pool.query('INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,$3,$4)', [journeyId, later.user.id, 'member', '2026-09-10T10:00:00.000Z']);
  const capacity = (await app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: { cookie: owner.cookie } })).json().data.capacity;
  assert.deepEqual(capacity.restOrder, [later.user.id, first.user.id, chosen.user.id]);
  assert.deepEqual(capacity.restingMemberIds, [later.user.id, first.user.id]);
});

test('a journey left fully paused reads again, and nothing can choose that mode any more', async (t) => {
  const userId = '66666666-6666-4666-8666-666666666666';
  const journeyId = '77777777-7777-4777-8777-777777777777';
  // As the schema stood before migration 029: an owner had chosen to fully pause.
  const { app, pool, platform } = await testPlatform({
    configOverrides: billingConfig,
    beforeMigration029: async (before) => {
      await before.query(`INSERT INTO users (id,email_normalized,username,display_name,password_hash,created_at) VALUES ($1,'paused@example.test','paused-owner','Paused','x',now())`, [userId]);
      await before.query(`INSERT INTO journeys (id,owner_user_id,name,location,start_date_status,end_date_status,budget_cents,unpaid_capacity_mode) VALUES ($1,$2,'A journey someone paused','','unknown','forever',0,'paused')`, [journeyId, userId]);
      await before.query(`INSERT INTO journey_members (journey_id,user_id,role) VALUES ($1,$2,'owner')`, [journeyId, userId]);
    },
  });
  t.after(async () => { await app.close(); await pool.end(); });
  assert.equal((await pool.query('SELECT unpaid_capacity_mode FROM journeys WHERE id=$1', [journeyId])).rows[0].unpaid_capacity_mode, 'read-only');
  await assert.rejects(pool.query("UPDATE journeys SET unpaid_capacity_mode='paused' WHERE id=$1", [journeyId]));

  // The journey's history says so, once, however many times the server starts.
  assert.equal(await platform.recordRestingMadeReadOnly(), 1);
  assert.equal(await platform.recordRestingMadeReadOnly(), 0);
  const events = (await platform.snapshot(userId, journeyId)).events;
  assert.deepEqual(events.map((event) => event.action), ['unpaid_capacity_rest_made_read_only']);
  assert.match(events[0].summary, /^Together Ledger no longer lets resting journeyers be fully paused/);
  assert.deepEqual(events[0].before, { unpaidCapacityMode: 'paused' });
  assert.equal(events[0].after.unpaidCapacityMode, 'read-only');
  assert.equal((await platform.snapshot(userId, journeyId)).eventChainValid, true);
});

// A journey whose payment has lapsed into grace: the owner pays, two others joined, and the
// payment covered one more person than the two included.
async function journeyInGrace(t, clock) {
  const context = await testPlatform({ configOverrides: billingConfig, now: () => clock.now });
  t.after(async () => { await context.app.close(); await context.pool.end(); });
  const { app, mailer, pool } = context;
  const owner = await register(app, mailer, { email: 'grace-owner@example.test', username: 'grace-owner' });
  const first = await register(app, mailer, { email: 'grace-first@example.test', username: 'grace-first' });
  const later = await register(app, mailer, { email: 'grace-later@example.test', username: 'grace-later' });
  await pool.query("UPDATE users SET display_name='Sam' WHERE id=$1", [owner.user.id]);
  await pool.query("UPDATE users SET display_name='Alex' WHERE id=$1", [first.user.id]);
  const created = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: authHeaders(owner),
    payload: { name: 'A journey waiting on a payment', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', budgetCents: 0 },
  });
  const journeyId = created.json().data.journey.id;
  await pool.query('INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,$3,$4)', [journeyId, first.user.id, 'member', '2026-07-01T10:00:00.000Z']);
  await pool.query('INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,$3,$4)', [journeyId, later.user.id, 'member', '2026-07-02T10:00:00.000Z']);
  const automaticEnd = new Date(clock.now.getTime() + 7 * 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO billing_entitlements (id,payer_user_id,journey_id,capability,source,environment,source_record_id,state,quantity,expires_at,last_verified_at,created_at,updated_at)
     VALUES ($1,$2,$3,'additional-journey-capacity','stripe','test','sub_grace','grace',1,$4,$5,$5,$5)`,
    ['33333333-3333-4333-8333-333333333333', owner.user.id, journeyId, automaticEnd, clock.now],
  );
  // Read and asked through the platform, because sessions do not outlive the clock moving weeks.
  const capacityFor = async (client) => (await context.platform.snapshot(client.user.id, journeyId)).capacity;
  const ask = (client) => context.platform.requestMoreGrace(client.user.id, journeyId);
  const askOverHttp = (client) => app.inject({ method: 'POST', url: `/api/v1/journeys/${journeyId}/grace-requests`, headers: authHeaders(client) });
  return { ...context, owner, first, later, journeyId, automaticEnd, capacityFor, ask, askOverHttp };
}

const DAY = 24 * 60 * 60 * 1000;

test('everyone in a journey in grace is told who pays, the time left, the weeks asked for and who can still add', async (t) => {
  const clock = { now: new Date('2026-08-02T12:00:00.000Z') };
  const { owner, first, later, capacityFor } = await journeyInGrace(t, clock);

  for (const viewer of [owner, first, later]) {
    const capacity = await capacityFor(viewer);
    assert.deepEqual(capacity.grace, {
      endsAt: '2026-08-09T12:00:00.000Z',
      daysLeft: 7,
      payer: { id: owner.user.id, displayName: 'Sam' },
      calendarYear: 2026,
      requestsUsed: 0,
      requestsPerYear: 6,
      requestDays: 7,
      canRequest: true,
      // The payer, and the first to join, because nobody was chosen.
      keepAdding: [{ id: owner.user.id, displayName: 'Sam' }, { id: first.user.id, displayName: 'Alex' }],
    });
    // Everything keeps working for everyone during grace. New invitations wait.
    assert.deepEqual(capacity.restingMemberIds, []);
    assert.equal(capacity.canInvite, false);
  }

  clock.now = new Date('2026-08-05T18:00:00.000Z');
  assert.equal((await capacityFor(first)).grace.daysLeft, 4, 'a part day still counts as a day left');
});

const refusedWith = (code) => (error) => error instanceof PlatformError && error.code === code;

test('the payer asks for another 7 days, one week ahead at a time, and each request is in the history', async (t) => {
  const clock = { now: new Date('2026-08-02T12:00:00.000Z') };
  const { pool, owner, first, later, journeyId, capacityFor, ask, askOverHttp } = await journeyInGrace(t, clock);

  // Only the person who pays can ask.
  const notPayer = await askOverHttp(first);
  assert.equal(notPayer.statusCode, 403, notPayer.body);
  assert.equal(notPayer.json().error.code, 'not_payer');

  // Asked during the automatic 7 days, the extra week begins where they end.
  const asked = await askOverHttp(owner);
  assert.equal(asked.statusCode, 201, asked.body);
  assert.equal(asked.json().data.capacity.grace.endsAt, '2026-08-16T12:00:00.000Z');
  assert.equal(asked.json().data.capacity.grace.requestsUsed, 1);
  assert.equal(asked.json().data.capacity.grace.canRequest, false);
  assert.deepEqual(asked.json().data.capacity.restOrder, [later.user.id, first.user.id], 'the owner is answered as the owner');

  // Only one week can wait ahead.
  const early = await askOverHttp(owner);
  assert.equal(early.statusCode, 409, early.body);
  assert.equal(early.json().error.code, 'grace_request_early');

  clock.now = new Date('2026-08-10T12:00:00.000Z');
  assert.equal((await capacityFor(first)).grace.daysLeft, 6);
  assert.equal((await ask(owner)).grace.endsAt, '2026-08-23T12:00:00.000Z');
  assert.equal((await capacityFor(first)).grace.endsAt, '2026-08-23T12:00:00.000Z');

  // Every request is in the journey's append-only history, attributed to the payer.
  const events = (await pool.query("SELECT actor_user_id,summary,after_value FROM journey_events WHERE journey_id=$1 AND action='grace_requested' ORDER BY sequence", [journeyId])).rows;
  assert.deepEqual(events.map((event) => event.summary), ['Asked for 7 more days to pay (1 of 6 in 2026)', 'Asked for 7 more days to pay (2 of 6 in 2026)']);
  assert.ok(events.every((event) => event.actor_user_id === owner.user.id));
  assert.equal(events[1].after_value.graceUntil, '2026-08-23T12:00:00.000Z');
});

test('when grace runs out the extra people rest and can still read, with no banner and nothing left to ask', async (t) => {
  const clock = { now: new Date('2026-08-02T12:00:00.000Z') };
  const { owner, later, capacityFor, ask, platform, journeyId } = await journeyInGrace(t, clock);

  // Past the end of grace the journey rests, even though Stripe has neither been paid nor
  // cancelled: a payment given up on cannot keep a grace, or a banner, alive.
  clock.now = new Date('2026-08-12T12:00:00.000Z');
  const lapsed = await capacityFor(later);
  assert.equal(lapsed.grace, null);
  assert.deepEqual(lapsed.restingMemberIds, [later.user.id]);
  assert.ok((await platform.snapshot(later.user.id, journeyId)).events.length > 0, 'a resting journeyer reads the whole journey');
  await assert.rejects(ask(owner), refusedWith('not_in_grace'));

  // Nor does a new calendar year bring the weeks back for it.
  clock.now = new Date('2027-01-02T12:00:00.000Z');
  assert.equal((await capacityFor(owner)).grace, null);
  await assert.rejects(ask(owner), refusedWith('not_in_grace'));
});

test('two requests for the same week are answered in words, not as a server error', async (t) => {
  const clock = { now: new Date('2026-08-02T12:00:00.000Z') };
  const { pool, owner, journeyId, ask } = await journeyInGrace(t, clock);
  // One request is counted this year, but it holds number 2: the number this request is about to
  // take is already gone, as it would be if two people's taps raced past the count together.
  await pool.query(
    `INSERT INTO journey_grace_requests (id,journey_id,requested_by_user_id,calendar_year,request_number,grace_basis,grace_until,requested_at)
     VALUES ($1,$2,$3,2026,2,$4,$4,$5)`,
    ['66666666-1111-4111-8111-111111111111', journeyId, owner.user.id, new Date('2026-01-01T00:00:00.000Z'), clock.now],
  );
  await assert.rejects(ask(owner), (error) => refusedWith('grace_request_conflict')(error) && error.status === 409 && /Refresh/.test(error.message));
});

test('six weeks asked for a calendar year, and a seventh refused, counted again from January 1', async (t) => {
  const clock = { now: new Date('2026-12-28T12:00:00.000Z') };
  const { pool, owner, journeyId, automaticEnd, capacityFor, ask } = await journeyInGrace(t, clock);
  for (let number = 1; number <= 6; number += 1) {
    await pool.query(
      `INSERT INTO journey_grace_requests (id,journey_id,requested_by_user_id,calendar_year,request_number,grace_basis,grace_until,requested_at)
       VALUES ($1,$2,$3,2026,$4,$5,$6,$7)`,
      [`44444444-4444-4444-8444-44444444444${number}`, journeyId, owner.user.id, number, automaticEnd, automaticEnd, new Date('2026-03-01T00:00:00.000Z')],
    );
  }
  const capacity = await capacityFor(owner);
  assert.equal(capacity.grace.requestsUsed, 6);
  assert.equal(capacity.grace.requestsPerYear, 6);
  assert.equal(capacity.grace.canRequest, false);
  await assert.rejects(ask(owner), (error) => refusedWith('grace_requests_used')(error) && /All 6 extra weeks for 2026 have been asked for\./.test(error.message) && /starts again on January 1/.test(error.message));

  // The database holds the limit too, so two requests racing cannot both be the seventh.
  await assert.rejects(pool.query(
    `INSERT INTO journey_grace_requests (id,journey_id,requested_by_user_id,calendar_year,request_number,grace_basis,grace_until,requested_at)
     VALUES ($1,$2,$3,2026,7,$4,$4,$4)`,
    ['55555555-5555-4555-8555-555555555555', journeyId, owner.user.id, automaticEnd],
  ));

  clock.now = new Date('2027-01-01T00:00:00.000Z');
  assert.equal((await capacityFor(owner)).grace.requestsUsed, 0);
  assert.equal((await ask(owner)).grace.requestsUsed, 1);
});

test('a store row left active past its end and its grace, or a pass not yet started, never hides a grace', async (t) => {
  const clock = { now: new Date('2026-08-02T12:00:00.000Z') };
  const { pool, owner, journeyId, capacityFor, ask } = await journeyInGrace(t, clock);
  // A store subscription stays 'active' after it ends, and is ordered first, most generous first.
  // So is a bigger pass bought to start later. Neither is room today: the first ended more than
  // its 7 days of grace ago, and the second hasn't started.
  await pool.query(
    `INSERT INTO billing_entitlements (id,payer_user_id,journey_id,capability,source,environment,source_record_id,state,quantity,effective_at,expires_at,last_verified_at,created_at,updated_at)
     VALUES ($1,$2,$3,'additional-journey-capacity','apple','test','store-ended','active',99,$4,$5,$6,$6,$6),
            ($7,$2,$3,'additional-journey-capacity','apple','test','store-later','active',99,$8,$9,$6,$6,$6)`,
    ['77777777-1111-4111-8111-111111111111', owner.user.id, journeyId, new Date('2026-06-20T12:00:00.000Z'), new Date('2026-07-20T12:00:00.000Z'), clock.now,
      '77777777-2222-4222-8222-222222222222', new Date('2026-08-20T12:00:00.000Z'), new Date('2026-09-20T12:00:00.000Z')],
  );
  const capacity = await capacityFor(owner);
  assert.equal(capacity.grace?.endsAt, '2026-08-09T12:00:00.000Z', 'the grace still shows');
  assert.equal(capacity.canInvite, false, 'and invitations still wait, as in any grace');
  assert.equal((await ask(owner)).grace.endsAt, '2026-08-16T12:00:00.000Z', 'and the payer can still ask');
});

test('weeks asked for during one lapse are not carried into the next', async (t) => {
  const clock = { now: new Date('2026-08-02T12:00:00.000Z') };
  const { pool, owner, journeyId, capacityFor, ask } = await journeyInGrace(t, clock);
  await ask(owner);

  // Paid on time, then a new lapse two days later: a new automatic grace with its own end.
  clock.now = new Date('2026-08-04T12:00:00.000Z');
  await pool.query("UPDATE billing_entitlements SET state='grace',expires_at=$1,updated_at=$2 WHERE journey_id=$3", ['2026-08-11T12:00:00.000Z', clock.now, journeyId]);
  const capacity = await capacityFor(owner);
  assert.equal(capacity.grace.endsAt, '2026-08-11T12:00:00.000Z');
  assert.equal(capacity.grace.requestsUsed, 1, 'the year still counts the week asked for before');
});

// The same journey, paid for in a store instead: no Stripe row, one store row with the room. A
// store row stays 'active' past its end, because a pass simply runs out and a subscription that
// isn't renewed sends nothing more (owner, Oct 8, 2026: its end gets the same grace).
async function journeyPaidInStore(t, clock, { source = 'apple', recordId = 'store-room', effectiveAt, expiresAt, quantity = 1, reason = null }) {
  const context = await journeyInGrace(t, clock);
  await context.pool.query('DELETE FROM billing_entitlements WHERE journey_id=$1', [context.journeyId]);
  const addRoom = (row) => context.pool.query(
    `INSERT INTO billing_entitlements (id,payer_user_id,journey_id,capability,source,environment,source_record_id,state,quantity,effective_at,expires_at,last_verified_at,reason,created_at,updated_at)
     VALUES ($1,$2,$3,'additional-journey-capacity',$4,'test',$5,'active',$6,$7,$8,$9,$10,$9,$9)`,
    [row.id, context.owner.user.id, context.journeyId, row.source || source, row.recordId, row.quantity ?? quantity, row.effectiveAt, row.expiresAt, clock.now, row.reason ?? null],
  );
  await addRoom({ id: '88888888-1111-4111-8111-111111111111', recordId, effectiveAt, expiresAt, reason });
  return { ...context, addRoom };
}

test('a week pass that runs out gives the same 7 days of grace as a failed payment, then the extra people rest', async (t) => {
  const clock = { now: new Date('2026-08-02T12:00:00.000Z') };
  const { owner, first, later, capacityFor } = await journeyPaidInStore(t, clock, {
    recordId: 'room_51_week_pass:1', effectiveAt: new Date('2026-07-26T10:00:00.000Z'), expiresAt: new Date('2026-08-02T10:00:00.000Z'),
  });

  // Ended two hours ago. The room stays, new invitations wait, and everyone is told.
  for (const viewer of [owner, first, later]) {
    const capacity = await capacityFor(viewer);
    assert.equal(capacity.grace?.endsAt, '2026-08-09T10:00:00.000Z', 'grace runs 7 days from the end of the pass');
    assert.deepEqual(capacity.grace.payer, { id: owner.user.id, displayName: 'Sam' });
    assert.equal(capacity.grace.requestsPerYear, 6);
    assert.deepEqual(capacity.restingMemberIds, []);
    assert.equal(capacity.canInvite, false);
  }

  clock.now = new Date('2026-08-09T10:00:00.000Z');
  const rested = await capacityFor(later);
  assert.equal(rested.grace, null);
  assert.deepEqual(rested.restingMemberIds, [later.user.id], 'nobody is removed: the latest to join rests');
});

test('a store subscription that lapses gets the same grace; one a newer purchase replaced does not', async (t) => {
  const clock = { now: new Date('2026-08-02T12:00:00.000Z') };
  const { later, capacityFor, addRoom } = await journeyPaidInStore(t, clock, {
    source: 'google', recordId: 'room_51_monthly:token', effectiveAt: new Date('2026-07-01T09:00:00.000Z'), expiresAt: new Date('2026-08-01T09:00:00.000Z'),
  });
  assert.equal((await capacityFor(later)).grace?.endsAt, '2026-08-08T09:00:00.000Z');

  // A replaced subscription ended because something newer took its place. Once that newer one
  // has also gone, only the newer one's end counts.
  clock.now = new Date('2026-08-20T12:00:00.000Z');
  await addRoom({
    id: '88888888-2222-4222-8222-222222222222', recordId: 'room_101_monthly:replaced', quantity: 99, reason: 'store_subscription_replaced',
    effectiveAt: new Date('2026-07-01T09:00:00.000Z'), expiresAt: new Date('2026-08-19T12:00:00.000Z'),
  });
  const capacity = await capacityFor(later);
  assert.equal(capacity.grace, null, 'no grace from a replaced subscription');
  assert.deepEqual(capacity.restingMemberIds, [later.user.id]);
});

test('a newer pass that starts during grace ends it, and the weeks asked for still count', async (t) => {
  const clock = { now: new Date('2026-08-02T12:00:00.000Z') };
  const { owner, later, capacityFor, ask, addRoom } = await journeyPaidInStore(t, clock, {
    recordId: 'room_51_week_pass:1', effectiveAt: new Date('2026-07-26T10:00:00.000Z'), expiresAt: new Date('2026-08-02T10:00:00.000Z'),
  });
  clock.now = new Date('2026-08-04T12:00:00.000Z');
  await ask(owner);
  assert.equal((await capacityFor(later)).grace.requestsUsed, 1);

  // A month pass bought now starts now: nothing is running for it to wait behind.
  await addRoom({ id: '88888888-3333-4333-8333-333333333333', recordId: 'room_51_month_pass:2', quantity: 49, effectiveAt: clock.now, expiresAt: new Date('2026-09-04T12:00:00.000Z') });
  const paid = await capacityFor(later);
  assert.equal(paid.grace, null, 'the banner goes');
  assert.equal(paid.canInvite, true, 'and invitations no longer wait');
  assert.deepEqual(paid.restingMemberIds, []);

  // When that pass runs out too, a new grace begins from its end, and this year's count stands.
  clock.now = new Date('2026-09-05T12:00:00.000Z');
  const lapsedAgain = await capacityFor(later);
  assert.equal(lapsedAgain.grace?.endsAt, '2026-09-11T12:00:00.000Z');
  assert.equal(lapsedAgain.grace.requestsUsed, 1);
});

test('after a pass ends, the payer can ask for another week, and it is in the history', async (t) => {
  const clock = { now: new Date('2026-08-02T12:00:00.000Z') };
  const { pool, owner, first, journeyId, capacityFor, ask } = await journeyPaidInStore(t, clock, {
    recordId: 'room_51_week_pass:1', effectiveAt: new Date('2026-07-26T10:00:00.000Z'), expiresAt: new Date('2026-08-02T10:00:00.000Z'),
  });
  await assert.rejects(ask(first), refusedWith('not_payer'));
  const asked = await ask(owner);
  assert.equal(asked.grace.endsAt, '2026-08-16T10:00:00.000Z', 'the week begins where the automatic grace ends');
  assert.equal(asked.grace.requestsUsed, 1);
  assert.equal((await capacityFor(first)).grace.endsAt, '2026-08-16T10:00:00.000Z', 'and everyone sees it');

  const events = (await pool.query("SELECT summary FROM journey_events WHERE journey_id=$1 AND action='grace_requested'", [journeyId])).rows;
  assert.deepEqual(events.map((event) => event.summary), ['Asked for 7 more days to pay (1 of 6 in 2026)']);

  // The asked-for week holds past the automatic end.
  clock.now = new Date('2026-08-12T12:00:00.000Z');
  assert.equal((await capacityFor(first)).grace?.endsAt, '2026-08-16T10:00:00.000Z');
});

test('nobody outside a payment can ask for more time', async (t) => {
  const { app, mailer, pool } = await testPlatform({ configOverrides: billingConfig });
  t.after(async () => { await app.close(); await pool.end(); });
  const owner = await register(app, mailer, { email: 'paid-owner@example.test', username: 'paid-owner' });
  const created = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: authHeaders(owner),
    payload: { name: 'A journey of two', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', budgetCents: 0 },
  });
  const journeyId = created.json().data.journey.id;
  const snapshot = (await app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: { cookie: owner.cookie } })).json().data;
  assert.equal(snapshot.capacity.grace, null);
  const asked = await app.inject({ method: 'POST', url: `/api/v1/journeys/${journeyId}/grace-requests`, headers: authHeaders(owner) });
  assert.equal(asked.statusCode, 409, asked.body);
  assert.equal(asked.json().error.code, 'not_in_grace');
  const stranger = await register(app, mailer, { email: 'paid-stranger@example.test', username: 'paid-stranger' });
  const outsider = await app.inject({ method: 'POST', url: `/api/v1/journeys/${journeyId}/grace-requests`, headers: authHeaders(stranger) });
  assert.equal(outsider.statusCode, 403, outsider.body);
});

test('a person can be in 101 journeys: the 102nd can be neither started nor joined, and nobody loses one', async (t) => {
  const { app, mailer, pool, platform } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const busy = await register(app, mailer, { email: 'busy@example.test', username: 'busy' });
  const friend = await register(app, mailer, { email: 'friend@example.test', username: 'friend' });
  const input = { name: 'One of many', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', budgetCents: 0 };

  // 100 of their own, and one they joined: joined journeys count too.
  for (let index = 0; index < 100; index += 1) await platform.createJourney(busy.user.id, input);
  const friends = await platform.createJourney(friend.user.id, input);
  await pool.query("INSERT INTO journey_members (journey_id,user_id,role) VALUES ($1,$2,'member')", [friends.id, busy.user.id]);

  const refused = await app.inject({ method: 'POST', url: '/api/v1/journeys', headers: authHeaders(busy), payload: input });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().error.code, 'journey_limit_reached');
  assert.equal(refused.json().error.message, "One person can be in at most 101 journeys, and you've reached that, so a new one can't be started. Every journey you're in stays as it is.");
  assert.equal((await platform.listJourneys(busy.user.id)).length, 101);

  // An invitation to a 102nd waits, as one does for room in a full journey.
  const another = await platform.createJourney(friend.user.id, input);
  const invited = await app.inject({ method: 'POST', url: `/api/v1/journeys/${another.id}/invitations`, headers: authHeaders(friend), payload: { email: 'busy@example.test' } });
  assert.equal(invited.statusCode, 202, invited.body);
  const token = mailer.messages.findLast((message) => message.type === 'invitation' && message.to === 'busy@example.test').token;
  const waits = await app.inject({ method: 'POST', url: '/api/v1/invitations/accept', headers: authHeaders(busy), payload: { token } });
  assert.equal(waits.statusCode, 409, waits.body);
  assert.equal(waits.json().error.code, 'journey_limit_reached');
  const invitation = (await pool.query('SELECT accepted_at,revoked_at,reservation_active FROM invitations WHERE journey_id=$1', [another.id])).rows[0];
  assert.deepEqual(invitation, { accepted_at: null, revoked_at: null, reservation_active: true });

  // Once they are in fewer, the same invitation is still there to accept.
  await pool.query('DELETE FROM journey_members WHERE journey_id=$1 AND user_id=$2', [friends.id, busy.user.id]);
  const joined = await app.inject({ method: 'POST', url: '/api/v1/invitations/accept', headers: authHeaders(busy), payload: { token } });
  assert.equal(joined.statusCode, 200, joined.body);

  // Someone already past the limit keeps every journey; the limit only stops a new one.
  await pool.query("INSERT INTO journey_members (journey_id,user_id,role) VALUES ($1,$2,'member')", [friends.id, busy.user.id]);
  assert.equal((await platform.listJourneys(busy.user.id)).length, 102);
  const moment = await app.inject({
    method: 'POST', url: `/api/v1/journeys/${friends.id}/moments`, headers: authHeaders(busy),
    payload: { kind: 'memory', kindLabel: '', title: 'Still here', detail: '', occurredOn: '2026-08-02', visibility: 'private', theme: '', moneyCents: null, moneyCurrency: '', locations: [] },
  });
  assert.equal(moment.statusCode, 201, moment.body);
});

// A phone has no browser: no cookie jar it can rely on across restarts, and no hostile page that
// could navigate to it. So it says once that it is an app, and carries a token from then on. The
// tests below prove that path works and that the browser's path is completely undisturbed by it.

function phoneHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

async function registerOnPhone(app, mailer, { email, username = email.split('@')[0] }) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { 'x-together-client': 'app' },
    payload: { email, username, password: 'correct horse battery staple' },
  });
  assert.equal(response.statusCode, 201, response.body);
  const verification = mailer.messages.findLast((message) => message.type === 'verification' && message.to === email);
  const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', headers: { origin }, payload: { token: verification.token } });
  assert.equal(verified.statusCode, 200, verified.body);
  return { response, ...response.json().data };
}

test('a phone verifies its email and recovers its password without a browser origin', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const app_ = { 'x-together-client': 'app' };

  const registered = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: app_, payload: { email: 'recover@example.test', username: 'recover-phone', password: 'correct horse battery staple' } });
  assert.equal(registered.statusCode, 201, registered.body);
  const verification = mailer.messages.findLast((message) => message.type === 'verification' && message.to === 'recover@example.test');
  assert.equal(new URL(verification.accountOrigin).origin, new URL(apiOrigin).origin, 'the link goes to the account origin, not one the caller chose');

  const browserless = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', payload: { token: verification.token } });
  assert.equal(browserless.statusCode, 403, 'a caller that is neither our page nor the app is still refused');
  const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', headers: app_, payload: { token: verification.token } });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.ok(verified.json().data.user.emailVerifiedAt || verified.json().data.user.emailVerified);

  const requested = await app.inject({ method: 'POST', url: '/api/v1/recovery/request', headers: app_, payload: { email: 'recover@example.test' } });
  assert.equal(requested.statusCode, 202, requested.body);
  const recovery = mailer.messages.findLast((message) => message.type === 'recovery' && message.to === 'recover@example.test');
  assert.ok(recovery, 'the recovery email was sent');

  const oldToken = registered.json().data.token;
  const confirmed = await app.inject({ method: 'POST', url: '/api/v1/recovery/confirm', headers: app_, payload: { token: recovery.token, password: 'a brand new horse battery staple' } });
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  const revoked = await app.inject({ method: 'GET', url: '/api/v1/session', headers: phoneHeaders(oldToken) });
  assert.equal(revoked.statusCode, 401, 'a new password revokes the phone\'s old token');

  const signedIn = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: app_, payload: { identifier: 'recover@example.test', password: 'a brand new horse battery staple' } });
  assert.equal(signedIn.statusCode, 200, signedIn.body);
  assert.ok(signedIn.json().data.token);
});

test('without the app header, recovery still needs our own page', async (t) => {
  const { app, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const requested = await app.inject({ method: 'POST', url: '/api/v1/recovery/request', payload: { email: 'nobody@example.test' } });
  assert.equal(requested.statusCode, 403, requested.body);
  const confirmed = await app.inject({ method: 'POST', url: '/api/v1/recovery/confirm', payload: { token: 'x', password: 'a brand new horse battery staple' } });
  assert.equal(confirmed.statusCode, 403, confirmed.body);
});

test('the phone app\'s own client carries a whole account journey against this server', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const source = await readFile(new URL('../apps/mobile/src/api/client.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const { createAccountClient } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
  let held = null;
  const tokens = { read: async () => held, write: async (value) => { held = value; }, clear: async () => { held = null; } };
  const phone = createAccountClient({
    base: () => '/api/v1',
    tokens,
    fetch: async (url, init) => {
      const response = await app.inject({ method: init.method, url, headers: init.headers, payload: init.body });
      return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => response.json() };
    },
  });
  const email = 'journey-phone@example.test';

  const registered = await phone.register({ email, username: 'journey-phone', password: 'correct horse battery staple' });
  assert.equal(registered.user.email, email);
  assert.equal(registered.verificationSent, true);
  assert.ok(held?.token && held?.refreshToken, 'registering leaves the phone signed in');
  assert.equal((await phone.session()).emailVerified, false);
  assert.equal(await phone.resendVerification(), true);

  const verification = mailer.messages.findLast((message) => message.type === 'verification' && message.to === email);
  assert.equal((await phone.verifyEmail(verification.token)).emailVerified, true);

  await phone.logout();
  assert.equal(held, null);
  assert.equal(await phone.session(), null);
  assert.equal((await phone.login({ identifier: email, password: 'correct horse battery staple' })).email, email);

  await phone.requestRecovery(email);
  const recovery = mailer.messages.findLast((message) => message.type === 'recovery' && message.to === email);
  await phone.confirmRecovery(recovery.token, 'a brand new horse battery staple');
  assert.equal(held, null, 'a new password signs this phone out too');
  await assert.rejects(phone.login({ identifier: email, password: 'correct horse battery staple' }), { status: 401 });
  await phone.login({ identifier: email, password: 'a brand new horse battery staple' });

  await assert.rejects(phone.deleteAccount('not the password'), { status: 401 });
  await phone.deleteAccount('a brand new horse battery staple');
  assert.equal(held, null);
  await assert.rejects(phone.login({ identifier: email, password: 'a brand new horse battery staple' }), { status: 401 });
});

test('the phone reads a shared journey through this server, and never another person\'s private moment', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const load = async (path) => {
    const url = new URL(path, import.meta.url);
    const { outputText } = ts.transpileModule(await readFile(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    const linked = outputText.replace(/from '(\.[^']+\.js)'/g, (_, specifier) => `from '${new URL(specifier, url).href}'`);
    return import(`data:text/javascript;base64,${Buffer.from(linked).toString('base64')}`);
  };
  const { createAccountClient } = await load('../apps/mobile/src/api/client.ts');
  const view = await load('../apps/mobile/src/journey/journey-view.ts');

  const alice = await register(app, mailer, { email: 'ledger-alice@example.test', username: 'ledger-alice' });
  const created = await app.inject({ method: 'POST', url: '/api/v1/journeys', headers: authHeaders(alice), payload: { name: 'The summer we chose slowly', location: 'Marlow', startDateStatus: 'exact', startDate: '2026-05-14', endDateStatus: 'forever', endDate: null, budgetCents: 0 } });
  assert.equal(created.statusCode, 201, created.body);
  const journey = created.json().data.journey;
  const hold = (visibility, title, extra = {}) => app.inject({ method: 'POST', url: `/api/v1/journeys/${journey.id}/moments`, headers: authHeaders(alice), payload: { kind: 'memory', title, detail: '', occurredOn: '2026-06-02', visibility, moneyCents: null, moneyCurrency: '', locations: [], ...extra } });
  assert.equal((await hold('shared-now', 'The road near Marlow', { moneyCents: 1250, moneyCurrency: 'USD' })).statusCode, 201);
  assert.equal((await hold('private', 'Only mine')).statusCode, 201);
  assert.equal((await hold('share-later', 'For next time')).statusCode, 201);
  const invited = await app.inject({ method: 'POST', url: `/api/v1/journeys/${journey.id}/invitations`, headers: authHeaders(alice), payload: { email: 'ledger-bob@example.test' } });
  assert.equal(invited.statusCode, 202, invited.body);
  const invitation = mailer.messages.findLast((message) => message.type === 'invitation' && message.to === 'ledger-bob@example.test').token;

  let held = null;
  const phone = createAccountClient({
    base: () => '/api/v1',
    tokens: { read: async () => held, write: async (value) => { held = value; }, clear: async () => { held = null; } },
    fetch: async (url, init) => {
      const response = await app.inject({ method: init.method, url, headers: init.headers, payload: init.body });
      return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => response.json() };
    },
  });
  await phone.register({ email: 'ledger-bob@example.test', username: 'ledger-bob', password: 'correct horse battery staple' });
  await phone.verifyEmail(mailer.messages.findLast((message) => message.type === 'verification' && message.to === 'ledger-bob@example.test').token);
  assert.deepEqual(await phone.journeys(), [], 'nothing before the invitation is accepted');
  const accepted = await app.inject({ method: 'POST', url: '/api/v1/invitations/accept', headers: { authorization: `Bearer ${held.token}`, 'x-together-client': 'app' }, payload: { token: invitation } });
  assert.equal(accepted.statusCode, 200, accepted.body);

  const journeys = await phone.journeys();
  assert.deepEqual(journeys.map(({ id }) => id), [journey.id]);
  const snapshot = await phone.snapshot(journeys[0].id);
  const recent = view.recentMoments(snapshot);
  assert.deepEqual(recent.map(({ title }) => title), ['The road near Marlow'], 'another person\'s private and share-later moments never reach this phone');
  assert.equal(view.visibilityCue(recent[0].visibility).label, 'Shared now');
  assert.equal(recent[0].createdBy, 'ledger-alice');
  assert.equal(view.journeyPeriod(snapshot.journey), 'Marlow · Began May 14 · No end date planned');
  assert.equal(view.moneyContext(recent[0]), '$12.50 is held here as context, not a score.');
});

test('the phone begins a journey through this server, and owns it', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const load = async (path) => {
    const url = new URL(path, import.meta.url);
    const { outputText } = ts.transpileModule(await readFile(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    const linked = outputText.replace(/from '(\.[^']+\.js)'/g, (_, specifier) => `from '${new URL(specifier, url).href}'`);
    return import(`data:text/javascript;base64,${Buffer.from(linked).toString('base64')}`);
  };
  const { createAccountClient } = await load('../apps/mobile/src/api/client.ts');
  const draft = await load('../apps/mobile/src/journey/journey-draft.ts');
  const view = await load('../apps/mobile/src/journey/journey-view.ts');

  let held = null;
  const phone = createAccountClient({
    base: () => '/api/v1',
    tokens: { read: async () => held, write: async (value) => { held = value; }, clear: async () => { held = null; } },
    fetch: async (url, init) => {
      const response = await app.inject({ method: init.method, url, headers: init.headers, payload: init.body });
      return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => response.json() };
    },
  });
  await phone.register({ email: 'begin-phone@example.test', username: 'begin-phone', password: 'correct horse battery staple' });
  await phone.verifyEmail(mailer.messages.findLast((message) => message.type === 'verification' && message.to === 'begin-phone@example.test').token);
  assert.deepEqual(await phone.journeys(), [], 'a new account begins with no journey');

  const first = { ...draft.newJourneyDraft(new Date(2026, 9, 8, 12)), name: 'Our first year', location: 'Leeds' };
  const created = await phone.createJourney(draft.journeyPayload(first));
  assert.equal(created.name, 'Our first year');
  assert.equal(created.role, 'owner', 'the phone that begins a journey owns it');

  const second = await phone.createJourney(draft.journeyPayload({ ...first, name: 'The long way round', startDateStatus: 'unknown', endDateStatus: 'date', endDate: '2027-03-01' }));
  const journeys = await phone.journeys();
  assert.deepEqual(journeys.map(({ id }) => id).sort(), [created.id, second.id].sort(), 'an account that has a journey can begin another');
  assert.equal(view.chooseJourney(journeys, second.id), second.id, 'the journey just begun is the one that opens');
  const snapshot = await phone.snapshot(second.id);
  assert.equal(snapshot.journey.name, 'The long way round');
  assert.ok(snapshot.events.some((event) => event.action === 'journey_created'), 'beginning it is in the journey\'s history');

  await assert.rejects(phone.createJourney(draft.journeyPayload({ ...first, endDateStatus: 'date', endDate: '2026-10-07' })), { status: 400, message: 'The end date must be on or after the start date.' });
  assert.equal(draft.journeyProblem({ ...first, endDateStatus: 'date', endDate: '2026-10-07' }), 'The end date must be on or after the start date.', 'the phone says it first, in the same words');

  // "I know the date" takes a date still to come, so a trip can be planned ahead (#358). The
  // server's clock here reads Aug 2, 2026; it has no rule against a later start, and keeps the
  // rule that an end cannot come before the start.
  const planned = { ...first, name: 'The trip we are planning', startDate: '2027-06-01' };
  const ahead = await phone.createJourney(draft.journeyPayload(planned));
  assert.equal(ahead.startDateStatus, 'exact');
  assert.equal(ahead.startDate, '2027-06-01');
  const plannedEnd = await phone.createJourney(draft.journeyPayload({ ...planned, name: 'Two weeks away', endDateStatus: 'date', endDate: '2027-06-14' }));
  assert.equal(plannedEnd.endDate, '2027-06-14');
  await assert.rejects(phone.createJourney(draft.journeyPayload({ ...planned, endDateStatus: 'date', endDate: '2027-05-31' })), { status: 400, message: 'The end date must be on or after the start date.' });
  // The web's signed-in form sends the same fields to the same route, from its own session.
  const browser = await signIn(app, 'begin-phone');
  const fromWeb = await app.inject({ method: 'POST', url: '/api/v1/journeys', headers: authHeaders(browser), payload: { name: 'Planned on the web', location: '', startDateStatus: 'exact', startDate: '2027-06-01', endDateStatus: 'forever', endDate: null, budgetCents: 0 } });
  assert.equal(fromWeb.statusCode, 201, fromWeb.body);
});

test('the phone holds, changes, shares and deletes a moment through this server', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const load = async (path) => {
    const url = new URL(path, import.meta.url);
    const { outputText } = ts.transpileModule(await readFile(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    const linked = outputText.replace(/from '(\.[^']+\.js)'/g, (_, specifier) => `from '${new URL(specifier, url).href}'`);
    return import(`data:text/javascript;base64,${Buffer.from(linked).toString('base64')}`);
  };
  const { createAccountClient } = await load('../apps/mobile/src/api/client.ts');
  const draft = await load('../apps/mobile/src/journey/moment-draft.ts');
  let held = null;
  const phone = createAccountClient({
    base: () => '/api/v1',
    tokens: { read: async () => held, write: async (value) => { held = value; }, clear: async () => { held = null; } },
    fetch: async (url, init) => {
      const response = await app.inject({ method: init.method, url, headers: init.headers, payload: init.body });
      return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => response.json() };
    },
  });
  await phone.register({ email: 'holder@example.test', username: 'holder', password: 'correct horse battery staple' });
  await phone.verifyEmail(mailer.messages.findLast((message) => message.type === 'verification' && message.to === 'holder@example.test').token);
  const created = await app.inject({ method: 'POST', url: '/api/v1/journeys', headers: { authorization: `Bearer ${held.token}`, 'x-together-client': 'app' }, payload: { name: 'Ours', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 } });
  assert.equal(created.statusCode, 201, created.body);
  const journeyId = created.json().data.journey.id;

  const fresh = { ...draft.draftFrom(null, { kind: 'other' }), kindLabel: 'A small win', title: 'We found the view', visibility: 'private', theme: 'green', money: '12.5', moneyCurrency: 'EUR', locations: draft.addPlace([], ' Marlow ').locations };
  assert.equal(draft.draftProblem(fresh), null);
  const moment = await phone.createMoment(journeyId, draft.payloadFrom(fresh, null));
  assert.equal(moment.kindLabel, 'A small win');
  assert.equal(moment.theme, 'green');
  assert.equal(moment.moneyCents, 1250);
  assert.deepEqual(moment.locations.map(({ label }) => label), ['Marlow']);

  const later = await phone.updateMoment(journeyId, moment.id, draft.payloadFrom({ ...draft.draftFrom(moment), visibility: 'share-later', locations: [] }, moment));
  assert.equal(later.visibility, 'share-later');
  assert.deepEqual(later.locations, [], 'a place removed on the phone is removed');
  await assert.rejects(phone.updateMoment(journeyId, moment.id, draft.payloadFrom(draft.draftFrom(moment), moment)), { status: 409, message: 'This moment changed on another device.' }, 'an edit from a stale version is refused, not merged over');

  const shared = await phone.updateMoment(journeyId, moment.id, draft.sharePayload(later));
  assert.equal(shared.visibility, 'shared-now');
  await assert.rejects(phone.updateMoment(journeyId, moment.id, draft.payloadFrom({ ...draft.draftFrom(shared), visibility: 'private' }, shared)), { status: 400, message: 'A moment already shared cannot become private again. Prior access cannot be undone.' }, 'the server, not only the form, keeps a shared moment shared');

  await phone.deleteMoment(journeyId, moment.id, shared.version);
  const after = await phone.snapshot(journeyId);
  assert.deepEqual(after.moments, []);
  assert.ok(after.events.some((event) => event.action === 'moment_deleted'), 'deleting a shared moment leaves its tombstone');
});

test('a phone registers with a bearer token and never receives a session cookie', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });

  const phone = await registerOnPhone(app, mailer, { email: 'phone@example.test', username: 'phone-one' });
  assert.ok(phone.token);
  assert.ok(phone.refreshToken);
  assert.notEqual(phone.token, phone.refreshToken);
  assert.equal(phone.response.headers['set-cookie'], undefined);
  // Nothing a browser would need is handed to a client that cannot be cross-site forged.
  assert.equal(phone.csrfToken, undefined);

  // Reading works with the token alone: no origin, no cookie, no CSRF header.
  const session = await app.inject({ method: 'GET', url: '/api/v1/session', headers: phoneHeaders(phone.token) });
  assert.equal(session.statusCode, 200, session.body);
  assert.equal(session.json().data.user.username, 'phone-one');
  assert.equal(session.json().data.csrfToken, undefined);

  // And so does writing. A bearer token is attached deliberately, so there is no cross-site
  // request to forge and nothing for a CSRF header to prove.
  const created = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: phoneHeaders(phone.token),
    payload: { name: 'A phone journey', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 },
  });
  assert.equal(created.statusCode, 201, created.body);
  const journeyId = created.json().data.journey.id;

  const snapshot = await app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: phoneHeaders(phone.token) });
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  assert.equal(snapshot.json().data.journey.name, 'A phone journey');
});

test('a phone signs in with a token while the browser keeps its cookie and CSRF header', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });

  const browser = await register(app, mailer, { email: 'both@example.test', username: 'both-ways' });

  // The same account, signed in from a phone. No origin header at all, because an app has none.
  const phoneLogin = await app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { 'x-together-client': 'app' },
    payload: { identifier: 'both-ways', password: 'correct horse battery staple' },
  });
  assert.equal(phoneLogin.statusCode, 200, phoneLogin.body);
  const phone = phoneLogin.json().data;
  assert.ok(phone.token);
  assert.equal(phoneLogin.headers['set-cookie'], undefined);

  // The browser's own sign-in is unchanged: a cookie plus a CSRF token, and no bearer token.
  const browserLogin = await app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { origin },
    payload: { identifier: 'both-ways', password: 'correct horse battery staple' },
  });
  assert.equal(browserLogin.statusCode, 200, browserLogin.body);
  assert.ok(browserLogin.headers['set-cookie']);
  assert.ok(browserLogin.json().data.csrfToken);
  assert.equal(browserLogin.json().data.token, undefined);
  assert.equal(browserLogin.json().data.refreshToken, undefined);

  // A browser still cannot mutate without its CSRF header...
  const withoutCsrf = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: { origin, cookie: browser.cookie },
    payload: { name: 'Forged', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 },
  });
  assert.equal(withoutCsrf.statusCode, 403, withoutCsrf.body);
  assert.equal(withoutCsrf.json().error.code, 'invalid_csrf');

  // ...nor from an origin that is not ours, even holding both.
  const foreignOrigin = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: { origin: 'https://not-ours.example', cookie: browser.cookie, 'x-together-csrf': browser.csrf },
    payload: { name: 'Forged', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 },
  });
  assert.equal(foreignOrigin.statusCode, 403, foreignOrigin.body);
  assert.equal(foreignOrigin.json().error.code, 'invalid_origin');

  // An invalid Authorization header is not a way around the CSRF requirement either: presenting
  // a token means being judged as a token, and a token that is not ours is simply refused.
  const pretendBearer = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: { origin, cookie: browser.cookie, ...phoneHeaders('not-a-real-token') },
    payload: { name: 'Forged', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 },
  });
  assert.equal(pretendBearer.statusCode, 401, pretendBearer.body);
  assert.equal(pretendBearer.json().error.code, 'authentication_required');

  // The browser path, used properly, still works.
  const properly = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: authHeaders(browser),
    payload: { name: 'A browser journey', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 },
  });
  assert.equal(properly.statusCode, 201, properly.body);
});

test('a phone token expires, refreshing rotates it, and a spent refresh token retires its family', async (t) => {
  let clock = new Date('2026-08-02T12:00:00.000Z');
  const { app, mailer, pool } = await testPlatform({ now: () => clock, configOverrides: { ACCESS_TOKEN_MINUTES: 5, REFRESH_TOKEN_DAYS: 2 } });
  t.after(async () => { await app.close(); await pool.end(); });

  const phone = await registerOnPhone(app, mailer, { email: 'rotating@example.test', username: 'rotating' });
  const fresh = await app.inject({ method: 'GET', url: '/api/v1/session', headers: phoneHeaders(phone.token) });
  assert.equal(fresh.statusCode, 200, fresh.body);

  clock = new Date('2026-08-02T12:06:00.000Z');
  const stale = await app.inject({ method: 'GET', url: '/api/v1/session', headers: phoneHeaders(phone.token) });
  assert.equal(stale.statusCode, 401, stale.body);
  assert.equal(stale.json().error.code, 'authentication_required');

  const refreshed = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: phone.refreshToken } });
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  const rotated = refreshed.json().data;
  assert.notEqual(rotated.token, phone.token);
  assert.notEqual(rotated.refreshToken, phone.refreshToken);
  assert.equal(rotated.user.username, 'rotating');

  const renewed = await app.inject({ method: 'GET', url: '/api/v1/session', headers: phoneHeaders(rotated.token) });
  assert.equal(renewed.statusCode, 200, renewed.body);

  // The old refresh token is spent. Presenting it again means a copy is in circulation, so
  // everything issued along that line stops working rather than the presented token alone.
  const replayed = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: phone.refreshToken } });
  assert.equal(replayed.statusCode, 401, replayed.body);
  assert.equal(replayed.json().error.code, 'invalid_token');

  const afterReplay = await app.inject({ method: 'GET', url: '/api/v1/session', headers: phoneHeaders(rotated.token) });
  assert.equal(afterReplay.statusCode, 401, afterReplay.body);

  // Retiring the family is the point of noticing a replay, so it has to survive the refusal that
  // follows it. Nothing issued along that line is left live in the database.
  assert.equal((await pool.query('SELECT * FROM api_tokens WHERE revoked_at IS NULL')).rowCount, 0);

  const expiredRefresh = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: rotated.refreshToken } });
  assert.equal(expiredRefresh.statusCode, 401, expiredRefresh.body);
});

test('a refresh token that has simply run out of time is refused', async (t) => {
  let clock = new Date('2026-08-02T12:00:00.000Z');
  const { app, mailer, pool } = await testPlatform({ now: () => clock, configOverrides: { ACCESS_TOKEN_MINUTES: 5, REFRESH_TOKEN_DAYS: 1 } });
  t.after(async () => { await app.close(); await pool.end(); });

  const phone = await registerOnPhone(app, mailer, { email: 'lapsed@example.test', username: 'lapsed-phone' });
  clock = new Date('2026-08-04T12:00:00.000Z');
  const refreshed = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: phone.refreshToken } });
  assert.equal(refreshed.statusCode, 401, refreshed.body);
  assert.equal(refreshed.json().error.code, 'invalid_token');
});

test('signing out on a phone revokes the token on the server, not just on the device', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });

  const phone = await registerOnPhone(app, mailer, { email: 'signs-out@example.test', username: 'signs-out' });
  const signedOut = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: phoneHeaders(phone.token) });
  assert.equal(signedOut.statusCode, 204, signedOut.body);

  const afterwards = await app.inject({ method: 'GET', url: '/api/v1/session', headers: phoneHeaders(phone.token) });
  assert.equal(afterwards.statusCode, 401, afterwards.body);

  // The refresh token goes with it, or signing out would only postpone being signed in.
  const refreshed = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken: phone.refreshToken } });
  assert.equal(refreshed.statusCode, 401, refreshed.body);
});

test('deleting the account invalidates every token that account holds', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });

  const phone = await registerOnPhone(app, mailer, { email: 'leaving@example.test', username: 'leaving' });
  const secondDevice = await app.inject({
    method: 'POST', url: '/api/v1/auth/login', headers: { 'x-together-client': 'app' },
    payload: { identifier: 'leaving', password: 'correct horse battery staple' },
  });
  assert.equal(secondDevice.statusCode, 200, secondDevice.body);
  const other = secondDevice.json().data;

  const deleted = await app.inject({
    method: 'DELETE', url: '/api/v1/account', headers: phoneHeaders(phone.token),
    payload: { confirmation: 'DELETE', password: 'correct horse battery staple' },
  });
  assert.equal(deleted.statusCode, 204, deleted.body);

  for (const token of [phone.token, other.token]) {
    const refused = await app.inject({ method: 'GET', url: '/api/v1/session', headers: phoneHeaders(token) });
    assert.equal(refused.statusCode, 401, refused.body);
  }
  for (const refreshToken of [phone.refreshToken, other.refreshToken]) {
    const refused = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken } });
    assert.equal(refused.statusCode, 401, refused.body);
  }
  assert.equal((await pool.query('SELECT * FROM api_tokens')).rowCount, 0);
});

test('a phone token is stored only as a hash and is never echoed back in a reply', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });

  const phone = await registerOnPhone(app, mailer, { email: 'quiet@example.test', username: 'quiet-phone' });

  // Only hashes are at rest. A copied database row cannot be presented to the API.
  const stored = await pool.query('SELECT * FROM api_tokens');
  assert.equal(stored.rowCount, 2);
  for (const row of stored.rows) {
    assert.equal(row.token_hash.length, 64);
    assert.notEqual(row.token_hash, phone.token);
    assert.notEqual(row.token_hash, phone.refreshToken);
  }

  // Nothing after the reply that issued it says the token back, and a refusal says only that it
  // was refused. An error body that repeated the token would put it into every client-side log.
  const session = await app.inject({ method: 'GET', url: '/api/v1/session', headers: phoneHeaders(phone.token) });
  assert.ok(!session.body.includes(phone.token));
  const refused = await app.inject({ method: 'GET', url: '/api/v1/session', headers: phoneHeaders('a-token-that-was-never-issued') });
  assert.equal(refused.statusCode, 401);
  assert.ok(!refused.body.includes('a-token-that-was-never-issued'));

  // And a token is read from the Authorization header only, so putting one in the URL where a
  // proxy log or a browser history could keep it achieves nothing.
  const inTheUrl = await app.inject({ method: 'GET', url: `/api/v1/session?token=${phone.token}` });
  assert.equal(inTheUrl.statusCode, 401, inTheUrl.body);
});

test('the bridge tells an app which headers it may send', async (t) => {
  const { app, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const preflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/session', headers: { origin } });
  assert.equal(preflight.statusCode, 204);
  assert.match(preflight.headers['access-control-allow-headers'], /Authorization/);
  assert.match(preflight.headers['access-control-allow-headers'], /X-Together-Client/);
  assert.match(preflight.headers['access-control-allow-headers'], /X-Together-CSRF/);
  // A page we do not know still cannot preflight, so it can never send either header.
  const stranger = await app.inject({ method: 'OPTIONS', url: '/api/v1/session', headers: { origin: 'https://not-ours.example' } });
  assert.equal(stranger.statusCode, 403);
});

test('claiming to be the app gets a phone to recovery, and nothing past it', async (t) => {
  const { app, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });

  // This used to refuse the app header on recovery, because nothing in the phone story asked
  // recovery to change. TL-M-05 (#180) does: someone who has forgotten their password has no
  // token, and a phone has no origin. The header still opens nothing a browser page can reach,
  // because a hostile page cannot send it without a preflight, and the preflight is refused.
  const claimed = await app.inject({
    method: 'POST', url: '/api/v1/recovery/request', headers: { 'x-together-client': 'app' },
    payload: { email: 'someone@example.test' },
  });
  assert.equal(claimed.statusCode, 202, claimed.body);
  const hostilePreflight = await app.inject({
    method: 'OPTIONS', url: '/api/v1/recovery/request',
    headers: { origin: 'https://evil.example', 'access-control-request-headers': 'x-together-client' },
  });
  assert.notEqual(hostilePreflight.headers['access-control-allow-origin'], 'https://evil.example', 'a hostile page cannot send the app header');

  // It is not a way past an authenticated check: a mutation still needs a token this service issued.
  const unauthenticated = await app.inject({
    method: 'POST', url: '/api/v1/journeys', headers: { 'x-together-client': 'app' }, payload: {},
  });
  assert.equal(unauthenticated.statusCode, 403, unauthenticated.body);

  const fromTheApp = await app.inject({
    method: 'POST', url: '/api/v1/recovery/request', headers: { origin },
    payload: { email: 'someone@example.test' },
  });
  assert.equal(fromTheApp.statusCode, 202, fromTheApp.body);
});

test('the deployed logger is told to drop the headers and bodies that carry a token', async () => {
  const start = await readFile(new URL('../server/start.js', import.meta.url), 'utf8');
  assert.match(start, /logger: loggerOptions/, 'production uses the shared logger options');
  for (const field of ['req.headers.cookie', 'req.headers.authorization', 'req.body.token', 'req.body.refreshToken']) {
    assert.ok(loggerOptions.redact.includes(field), `${field} is not redacted from production logs`);
  }
  assert.equal(typeof loggerOptions.serializers.req, 'function', 'logged addresses pass through redactUrl');
});

// #253: a Google or Apple account opened without a name shows `journeyer-…`, and nobody could
// change the name journeyers see. Only the signed-in person's own name changes, and each journey
// they are in records it, so nobody can quietly take another journeyer's name.
async function sharedJourney() {
  const setup = await testPlatform();
  const alice = await register(setup.app, setup.mailer, { email: 'name-alice@example.test', username: 'name-alice' });
  const journeyResponse = await setup.app.inject({ method: 'POST', url: '/api/v1/journeys', headers: authHeaders(alice), payload: { name: 'Where we keep returning', location: '', startDateStatus: 'unknown', endDateStatus: 'forever', startDate: null, endDate: null, budgetCents: 0 } });
  assert.equal(journeyResponse.statusCode, 201, journeyResponse.body);
  const journey = journeyResponse.json().data.journey;
  const invited = await setup.app.inject({ method: 'POST', url: `/api/v1/journeys/${journey.id}/invitations`, headers: authHeaders(alice), payload: { email: 'name-bob@example.test' } });
  assert.equal(invited.statusCode, 202, invited.body);
  const token = setup.mailer.messages.findLast((message) => message.type === 'invitation' && message.to === 'name-bob@example.test').token;
  const bob = await register(setup.app, setup.mailer, { email: 'name-bob@example.test', username: 'name-bob' });
  const accepted = await setup.app.inject({ method: 'POST', url: '/api/v1/invitations/accept', headers: authHeaders(bob), payload: { token } });
  assert.equal(accepted.statusCode, 200, accepted.body);
  return { ...setup, alice, bob, journey };
}

test('a person changes the name journeyers see, and each journey they are in records it', async (t) => {
  const { app, pool, alice, bob, journey } = await sharedJourney();
  t.after(async () => { await app.close(); await pool.end(); });

  const changed = await app.inject({ method: 'PATCH', url: '/api/v1/account', headers: authHeaders(bob), payload: { displayName: '  Sam  ' } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().data.user.displayName, 'Sam', 'trimmed');
  assert.equal(changed.json().data.user.username, 'name-bob', 'the private username never changes');

  const session = await app.inject({ method: 'GET', url: '/api/v1/session', headers: authHeaders(bob) });
  assert.equal(session.json().data.user.displayName, 'Sam');

  const seen = (await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/snapshot`, headers: authHeaders(alice) })).json().data;
  assert.equal(seen.members.find((member) => member.id === bob.user.id).displayName, 'Sam', 'the other journeyer sees the new name');
  assert.equal(seen.members.find((member) => member.id === alice.user.id).displayName, 'name-alice', 'nobody else is renamed');
  const renamed = seen.events.filter((event) => event.action === 'member_renamed');
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0].actorUserId, bob.user.id);
  assert.equal(renamed[0].summary, 'Changed their name from name-bob to Sam');
  assert.deepEqual(renamed[0].before, { displayName: 'name-bob' });
  assert.deepEqual(renamed[0].after, { displayName: 'Sam' });

  const unchanged = await app.inject({ method: 'PATCH', url: '/api/v1/account', headers: authHeaders(bob), payload: { displayName: 'Sam' } });
  assert.equal(unchanged.statusCode, 200, unchanged.body);
  const after = (await app.inject({ method: 'GET', url: `/api/v1/journeys/${journey.id}/snapshot`, headers: authHeaders(alice) })).json().data;
  assert.equal(after.events.filter((event) => event.action === 'member_renamed').length, 1, 'the same name again records nothing');
});

test('a name must be 1 to 80 characters, and changing it needs the account itself', async (t) => {
  const { app, pool, alice, bob } = await sharedJourney();
  t.after(async () => { await app.close(); await pool.end(); });

  for (const displayName of ['', '   ', 'x'.repeat(81), undefined]) {
    const refused = await app.inject({ method: 'PATCH', url: '/api/v1/account', headers: authHeaders(bob), payload: displayName === undefined ? {} : { displayName } });
    assert.equal(refused.statusCode, 400, `${JSON.stringify(displayName)}: ${refused.body}`);
    assert.equal(refused.json().error.code, 'invalid_input');
  }
  const longest = await app.inject({ method: 'PATCH', url: '/api/v1/account', headers: authHeaders(bob), payload: { displayName: 'x'.repeat(80) } });
  assert.equal(longest.statusCode, 200, longest.body);

  const signedOut = await app.inject({ method: 'PATCH', url: '/api/v1/account', headers: { origin }, payload: { displayName: 'Anyone' } });
  assert.equal(signedOut.statusCode, 401, signedOut.body);
  const noCsrf = await app.inject({ method: 'PATCH', url: '/api/v1/account', headers: { origin, cookie: bob.cookie }, payload: { displayName: 'Forged' } });
  assert.equal(noCsrf.statusCode, 403, noCsrf.body);

  // Nothing in the request can point at someone else: a stray id is ignored, and only Bob changes.
  const aimed = await app.inject({ method: 'PATCH', url: '/api/v1/account', headers: authHeaders(bob), payload: { displayName: 'Not Alice', id: alice.user.id, userId: alice.user.id } });
  assert.equal(aimed.statusCode, 200, aimed.body);
  assert.equal(aimed.json().data.user.id, bob.user.id);
  const aliceNow = await pool.query('SELECT display_name FROM users WHERE id=$1', [alice.user.id]);
  assert.equal(aliceNow.rows[0].display_name, 'name-alice');
});

test('a phone changes its name with its token', async (t) => {
  const { app, mailer, pool } = await testPlatform();
  t.after(async () => { await app.close(); await pool.end(); });
  const phone = await registerOnPhone(app, mailer, { email: 'name-phone@example.test', username: 'name-phone' });
  const changed = await app.inject({ method: 'PATCH', url: '/api/v1/account', headers: { ...phoneHeaders(phone.token), 'x-together-client': 'app' }, payload: { displayName: 'Phone Name' } });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(changed.json().data.user.displayName, 'Phone Name');
});
