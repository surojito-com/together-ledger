import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { newDb } from 'pg-mem';
import ts from 'typescript';
import { buildApp } from '../server/app.js';
import { StripeBillingService } from '../server/billing.js';
import { loadConfig } from '../server/config.js';
import { MemoryMailer } from '../server/mailer.js';
import { PlatformService } from '../server/platform.js';
import { maskEmail } from '../server/security.js';

// #96: anyone can leave a journey by themselves, behind a typed LEAVE. What goes with them is what
// goes when the owner removes someone; what they shared stays; the questions they asked are taken
// back; History says who left and when; and the room they held is free again.

const origin = 'http://127.0.0.1:4174';
const PASSWORD = 'correct horse battery staple';

async function harness(t, { configOverrides = {}, billing = null } = {}) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  memory.public.registerFunction({ name: 'char_length', args: ['text'], returns: 'integer', implementation: (value) => value.length });
  memory.public.registerFunction({ name: 'jsonb_array_length', args: ['jsonb'], returns: 'integer', implementation: (value) => (Array.isArray(value) ? value.length : 0) });
  const pool = new (memory.adapters.createPg().Pool)();
  const migrations = (await readdir(new URL('../server/migrations/', import.meta.url))).filter((name) => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    // pg-mem cannot run the append-only trigger (002) or the reconciliation runs (010); tests/postgres-integration does.
    if (name.startsWith('002_') || name.startsWith('010_')) continue;
    // pg-mem names an unnamed column check differently from Postgres; see tests/store-purchases.test.js.
    if (name.startsWith('028_')) {
      await pool.query('ALTER TABLE moment_image_slots DROP CONSTRAINT IF EXISTS moment_image_slots_constraint_1');
      await pool.query('ALTER TABLE moment_location_slots DROP CONSTRAINT IF EXISTS moment_location_slots_constraint_1');
    }
    // pg-mem cannot parse NOT VALID (030).
    await pool.query((await readFile(new URL(`../server/migrations/${name}`, import.meta.url), 'utf8')).replace(') NOT VALID;', ');'));
  }
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: origin, SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32), ...configOverrides });
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer, now: () => new Date('2026-08-02T12:00:00.000Z') });
  const app = await buildApp({ platform, config, ...(billing ? { billing: billing(pool) } : {}) });
  t.after(async () => { await app.close(); await pool.end(); });

  async function person(name) {
    const email = `${name}@example.test`;
    const registered = await app.inject({ method: 'POST', url: '/api/v1/auth/register', headers: { origin }, payload: { email, username: name, password: PASSWORD } });
    assert.equal(registered.statusCode, 201, registered.body);
    const verification = mailer.messages.findLast((message) => message.type === 'verification' && message.to === email);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/verify-email', headers: { origin }, payload: { token: verification.token } })).statusCode, 200);
    return { email, user: registered.json().data.user, cookie: registered.headers['set-cookie'].split(';')[0], csrf: registered.json().data.csrfToken };
  }
  const headers = (who) => ({ origin, cookie: who.cookie, 'x-together-csrf': who.csrf });
  const call = (who, method, url, payload) => app.inject({ method, url: `/api/v1${url}`, headers: headers(who), ...(payload === undefined ? {} : { payload }) });
  const read = (who, journeyId) => app.inject({ method: 'GET', url: `/api/v1/journeys/${journeyId}/snapshot`, headers: { cookie: who.cookie } });
  const leave = (who, journeyId, payload = { confirmation: 'LEAVE' }) => call(who, 'POST', `/journeys/${journeyId}/leave`, payload);
  const tokenFor = (email) => mailer.messages.findLast((message) => message.type === 'invitation' && message.to === email).token;

  async function journey(owner, name = 'Where we keep returning') {
    const created = await call(owner, 'POST', '/journeys', { name, location: '', startDateStatus: 'unknown', endDateStatus: 'forever', budgetCents: 0 });
    assert.equal(created.statusCode, 201, created.body);
    return created.json().data.journey.id;
  }
  // Everyone already here agrees, then the person accepts.
  async function join(journeyId, asker, invited, agreeing = []) {
    const proposed = await call(asker, 'POST', `/journeys/${journeyId}/invitations`, { email: invited.email });
    assert.equal(proposed.statusCode, 202, proposed.body);
    for (const member of agreeing) {
      const agreed = await call(member, 'POST', `/journeys/${journeyId}/invite-proposals/${proposed.json().data.proposalId}/decision`, { decision: 'agree' });
      assert.equal(agreed.statusCode, 202, agreed.body);
    }
    const accepted = await call(invited, 'POST', '/invitations/accept', { token: tokenFor(invited.email) });
    assert.equal(accepted.statusCode, 200, accepted.body);
  }
  const memberIds = async (journeyId) => (await pool.query('SELECT user_id FROM journey_members WHERE journey_id=$1 ORDER BY user_id', [journeyId])).rows.map((row) => row.user_id);
  return { app, pool, mailer, platform, person, headers, call, read, leave, journey, join, memberIds, tokenFor };
}

const moment = (title, visibility, extra = {}) => ({
  kind: 'memory', title, detail: 'What we said there', occurredOn: '2026-08-01', visibility, moneyCents: null, moneyCurrency: '',
  locations: [{ label: 'The harbour', latitude: 38.7, longitude: -9.1, accuracyMeters: 12 }], ...extra,
});

test('a journeyer leaves: their private moments go, what they shared stays, History says so, and the room is free', async (t) => {
  const h = await harness(t, { configOverrides: { JOURNEY_CAPACITY_MODE: 'test-groups' } });
  const [ana, ben, cy] = [await h.person('ana-leaves'), await h.person('ben-leaves'), await h.person('cy-leaves')];
  const journeyId = await h.journey(ana);
  await h.join(journeyId, ana, ben);
  await h.join(journeyId, ana, cy, [ben]);

  // What Ben holds here: a private moment with a photo, one kept to share later, one shared, each with a place.
  const hold = async (title, visibility, key) => {
    const held = await h.call(ben, 'POST', `/journeys/${journeyId}/moments`, moment(title, visibility, { idempotencyKey: key }));
    assert.equal(held.statusCode, 201, held.body);
    return held.json().data.moment;
  };
  const kept = await hold('Only mine', 'private', 'ben-private-key-0001');
  const later = await hold('For later', 'share-later', 'ben-later-key-00001');
  const shared = await hold('Shared with everyone', 'shared-now', 'ben-shared-key-0001');
  const photo = await readFile(new URL('./fixtures/photos/sideways-with-gps.png', import.meta.url));
  const uploaded = await h.app.inject({ method: 'POST', url: `/api/v1/journeys/${journeyId}/moments/${kept.id}/images`, headers: { ...h.headers(ben), 'content-type': 'image/png' }, payload: photo });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  // Changing a private moment's visibility writes Ben's private record of it, which is not History.
  const madeLater = await h.call(ben, 'PATCH', `/journeys/${journeyId}/moments/${kept.id}`, { ...moment('Only mine', 'share-later'), version: kept.version });
  assert.equal(madeLater.statusCode, 200, madeLater.body);
  const madePrivate = await h.call(ben, 'PATCH', `/journeys/${journeyId}/moments/${kept.id}`, { ...moment('Only mine', 'private'), version: madeLater.json().data.moment.version });
  assert.equal(madePrivate.statusCode, 200, madePrivate.body);
  const anaHolds = await h.call(ana, 'POST', `/journeys/${journeyId}/moments`, moment('Ana keeps this', 'private', { idempotencyKey: 'ana-private-key-0001' }));
  assert.equal(anaHolds.statusCode, 201, anaHolds.body);

  // A question Ben asked that is still open, and an invitation Ben sent that is still waiting.
  const open = await h.call(ben, 'POST', `/journeys/${journeyId}/invitations`, { email: 'still-deciding@example.test' });
  assert.equal(open.json().data.invitationSent, false);
  const agreed = await h.call(ben, 'POST', `/journeys/${journeyId}/invitations`, { email: 'everyone-agreed@example.test' });
  for (const member of [ana, cy]) await h.call(member, 'POST', `/journeys/${journeyId}/invite-proposals/${agreed.json().data.proposalId}/decision`, { decision: 'agree' });
  const waitingToken = h.tokenFor('everyone-agreed@example.test');
  // And one Ana asked, which is Ana's and stays open.
  const anasQuestion = await h.call(ana, 'POST', `/journeys/${journeyId}/invitations`, { email: 'anas-question@example.test' });

  const before = (await h.read(ana, journeyId)).json().data;
  assert.equal(before.capacity.peopleHere, 3);
  assert.equal(before.capacity.openInvitations, 1);
  const count = async (sql, params) => (await h.pool.query(sql, params)).rows[0].count;
  assert.equal(await count('SELECT count(*)::int AS count FROM private_moment_events WHERE owner_user_id=$1', [ben.user.id]) > 0, true);

  const left = await h.leave(ben, journeyId);
  assert.equal(left.statusCode, 204, left.body);

  // What goes: Ben's private and share-later moments here, with their photo and places, the private record, and Ben's keys.
  const rows = (await h.pool.query('SELECT id,title FROM journey_moments WHERE journey_id=$1 AND created_by_user_id=$2', [journeyId, ben.user.id])).rows;
  assert.deepEqual(rows.map((row) => row.id), [shared.id]);
  assert.equal(await count('SELECT count(*)::int AS count FROM journey_moments WHERE id=$1 OR id=$2', [kept.id, later.id]), 0);
  assert.equal(await count('SELECT count(*)::int AS count FROM moment_images WHERE moment_id=$1', [kept.id]), 0);
  assert.equal(await count('SELECT count(*)::int AS count FROM private_moment_events WHERE owner_user_id=$1', [ben.user.id]), 0);
  assert.equal(await count('SELECT count(*)::int AS count FROM moment_hold_keys WHERE author_user_id=$1', [ben.user.id]), 0);
  assert.equal(await count('SELECT count(*)::int AS count FROM moment_hold_keys WHERE author_user_id=$1', [ana.user.id]), 1, 'nobody else\'s keys go');
  assert.equal(await count('SELECT count(*)::int AS count FROM journey_moments WHERE created_by_user_id=$1', [ana.user.id]), 1, 'nobody else\'s moments go');

  // What stays: the shared moment, with its place, still held by Ben's name.
  const after = (await h.read(cy, journeyId)).json().data;
  const stayed = after.moments.find((entry) => entry.id === shared.id);
  assert.ok(stayed, 'the shared moment stays with the others');
  assert.equal(stayed.createdBy, 'ben-leaves', 'still held by them');
  assert.equal(stayed.locations.length, 1);
  assert.deepEqual(after.members.map((member) => member.id).sort(), [ana.user.id, cy.user.id].sort());

  // History: the two questions Ben asked, taken back, then who left and when, on an unbroken chain.
  assert.equal(after.eventChainValid, true);
  const last = after.events.slice(-3);
  assert.deepEqual(last.map((event) => event.action), ['invite_proposal_withdrawn', 'invitation_withdrawn', 'member_left']);
  assert.ok(last.every((event) => event.actorUserId === ben.user.id));
  const entry = last.at(-1);
  assert.equal(entry.summary, 'ben-leaves left the journey');
  assert.equal(entry.createdAt, '2026-08-02T12:00:00.000Z');
  assert.deepEqual(entry.before, { userId: ben.user.id, role: 'member' });
  assert.equal(entry.after, null);
  assert.equal(last[0].summary, `Withdrew the proposal to add ${maskEmail('still-deciding@example.test')}`);
  assert.equal(last[1].summary, `Withdrew the invitation to ${maskEmail('everyone-agreed@example.test')}`);

  // Ben's question and invitation are withdrawn; Ana's question is Ana's, and stays open.
  const proposals = Object.fromEntries(after.inviteProposals.map((proposal) => [proposal.id, proposal.status]));
  assert.equal(proposals[open.json().data.proposalId], 'withdrawn');
  assert.equal(proposals[anasQuestion.json().data.proposalId], 'open');
  assert.equal(after.invitations.find((invitation) => invitation.email === maskEmail('everyone-agreed@example.test')).status, 'withdrawn');
  const lateArrival = await h.person('everyone-agreed');
  const refused = await h.call(lateArrival, 'POST', '/invitations/accept', { token: waitingToken });
  assert.equal(refused.statusCode, 400, 'the link Ben sent stops working');

  // The room Ben held, and the place the invitation held, are free again.
  assert.equal(after.capacity.peopleHere, 2);
  assert.equal(after.capacity.openInvitations, 0);
});

test('the person who left loses the journey at once, and a second leave finds nothing to leave', async (t) => {
  const h = await harness(t);
  const [ana, ben] = [await h.person('ana-gone'), await h.person('ben-gone')];
  const journeyId = await h.journey(ana);
  const elsewhere = await h.journey(ben, 'Ben\'s own journey');
  await h.join(journeyId, ana, ben);
  assert.equal((await h.leave(ben, journeyId)).statusCode, 204);

  const journeys = (await h.app.inject({ method: 'GET', url: '/api/v1/journeys', headers: { cookie: ben.cookie } })).json().data.journeys;
  assert.deepEqual(journeys.map((journey) => journey.id), [elsewhere], 'the journey list no longer has it; their own journey is untouched');
  const snapshot = await h.read(ben, journeyId);
  assert.equal(snapshot.statusCode, 403, 'it reads as any journey they are not in');
  assert.equal(snapshot.json().error.code, 'forbidden');
  const again = await h.leave(ben, journeyId);
  assert.equal(again.statusCode, 404, again.body);
  assert.equal(again.json().error.code, 'not_found');
  assert.equal((await h.leave(ben, 'not-a-journey')).statusCode, 404, 'a malformed id is simply not found');
  const write = await h.call(ben, 'POST', `/journeys/${journeyId}/moments`, moment('Too late', 'shared-now'));
  assert.equal(write.statusCode, 403, 'nothing can be added after leaving');

  // Coming back takes a new invitation, agreed to and accepted like any other.
  await h.join(journeyId, ana, ben);
  const back = (await h.read(ben, journeyId)).json().data;
  assert.ok(back.members.some((member) => member.id === ben.user.id));
  assert.equal(back.events.slice(-4)[0].action, 'member_left');
  assert.deepEqual(back.events.slice(-3).map((event) => event.action), ['invite_proposed', 'invitation_sent', 'member_joined']);
});

test('the owner hands the journey over first, then can leave; a journey of one is not left', async (t) => {
  const h = await harness(t);
  const [ana, ben] = [await h.person('ana-owner'), await h.person('ben-owner')];
  const alone = await h.journey(ana, 'Only Ana');
  const solo = await h.leave(ana, alone);
  assert.equal(solo.statusCode, 409, solo.body);
  assert.equal(solo.json().error.code, 'journey_of_one');
  assert.equal(solo.json().error.message, 'You are the only person in this journey, so there is nobody to leave it to.');
  assert.deepEqual(await h.memberIds(alone), [ana.user.id], 'the journey of one is as it was');

  const journeyId = await h.journey(ana);
  await h.join(journeyId, ana, ben);
  const owner = await h.leave(ana, journeyId);
  assert.equal(owner.statusCode, 409, owner.body);
  assert.equal(owner.json().error.code, 'ownership_transfer_required');
  assert.equal(owner.json().error.message, 'You hold this journey for everyone in it. Make someone else here the owner first, then you can leave.');
  assert.equal((await h.memberIds(journeyId)).length, 2, 'nobody left');

  const handed = await h.call(ana, 'POST', `/journeys/${journeyId}/ownership`, { userId: ben.user.id });
  assert.equal(handed.statusCode, 204, handed.body);
  assert.equal((await h.leave(ana, journeyId)).statusCode, 204);
  const after = (await h.read(ben, journeyId)).json().data;
  assert.equal(after.journey.role, 'owner');
  assert.deepEqual(after.members.map((member) => member.id), [ben.user.id]);
  assert.equal(after.events.at(-1).summary, 'ana-owner left the journey');
  // Now Ben is alone in it, there is nobody to leave it to.
  assert.equal((await h.leave(ben, journeyId)).json().error.code, 'journey_of_one');
});

test('leaving is typed LEAVE, and nobody can make someone else leave', async (t) => {
  const h = await harness(t);
  const [ana, ben, mallory] = [await h.person('ana-cross'), await h.person('ben-cross'), await h.person('mallory-cross')];
  const journeyId = await h.journey(ana);
  await h.join(journeyId, ana, ben);

  for (const payload of [{}, { confirmation: 'leave' }, { confirmation: 'DELETE' }]) {
    const unconfirmed = await h.leave(ben, journeyId, payload);
    assert.equal(unconfirmed.statusCode, 400, unconfirmed.body);
    assert.equal(unconfirmed.json().error.code, 'confirmation_required');
    assert.equal(unconfirmed.json().error.message, 'Type LEAVE to confirm leaving this journey.');
  }
  const unsigned = await h.app.inject({ method: 'POST', url: `/api/v1/journeys/${journeyId}/leave`, headers: { origin, cookie: ben.cookie }, payload: { confirmation: 'LEAVE' } });
  assert.equal(unsigned.statusCode, 403, 'a browser request without the CSRF header is refused');

  // Someone outside the journey, naming Ben, finds nothing; the owner naming Ben is asked to hand it over.
  const outsider = await h.leave(mallory, journeyId, { confirmation: 'LEAVE', userId: ben.user.id });
  assert.equal(outsider.statusCode, 404, outsider.body);
  const byOwner = await h.leave(ana, journeyId, { confirmation: 'LEAVE', userId: ben.user.id });
  assert.equal(byOwner.json().error.code, 'ownership_transfer_required', 'the request only ever means the person asking');
  assert.deepEqual(await h.memberIds(journeyId), [ana.user.id, ben.user.id].sort());
  assert.ok(!(await h.read(ana, journeyId)).json().data.events.some((event) => event.action === 'member_left'));
});

test('a resting journeyer can still leave, and the person waiting behind them adds again', async (t) => {
  const h = await harness(t, { configOverrides: { JOURNEY_CAPACITY_MODE: 'billing', BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake', STRIPE_ADDITIONAL_PERSON_PRICE_ID: 'price_fake' } });
  const [ana, ben, cy] = [await h.person('ana-rest'), await h.person('ben-rest'), await h.person('cy-rest')];
  const journeyId = await h.journey(ana);
  await h.join(journeyId, ana, ben);
  // A third person beyond the two included, as after paid room lapses. The newest rests first.
  await h.pool.query("INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,'member',$3)", [journeyId, cy.user.id, new Date('2099-01-01T00:00:00.000Z')]);
  const resting = (await h.read(ana, journeyId)).json().data.capacity.restingMemberIds;
  assert.deepEqual(resting, [cy.user.id]);
  assert.equal((await h.leave(cy, journeyId)).statusCode, 204, 'resting never stops anyone leaving');
  assert.deepEqual((await h.read(ana, journeyId)).json().data.capacity.restingMemberIds, []);

  await h.pool.query("INSERT INTO journey_members (journey_id,user_id,role,joined_at) VALUES ($1,$2,'member',$3)", [journeyId, cy.user.id, new Date('2099-01-01T00:00:00.000Z')]);
  assert.deepEqual((await h.read(ana, journeyId)).json().data.capacity.restingMemberIds, [cy.user.id]);
  assert.equal((await h.leave(ben, journeyId)).statusCode, 204);
  assert.deepEqual((await h.read(ana, journeyId)).json().data.capacity.restingMemberIds, [], 'the room Ben held is Cy\'s now');
});

test('someone paying on the web for this journey\'s room waits until that payment ends; a store subscription never stops them', async (t) => {
  const h = await harness(t, { billing: (pool) => new StripeBillingService({ pool, config: { stripeEnvironment: 'test' }, stripe: {} }) });
  const [ana, ben] = [await h.person('ana-pays'), await h.person('ben-pays')];
  const journeyId = await h.journey(ana);
  const other = await h.journey(ben, 'Ben pays here');
  await h.join(journeyId, ana, ben);
  const subscribe = (id, payer, journey, status = 'active') => h.pool.query(
    `INSERT INTO billing_subscriptions (provider_subscription_id,environment,payer_user_id,journey_id,provider_customer_id,offer_id,paid_capacity,status)
     VALUES ($1,'test',$2,$3,'cus_test','additional-person-monthly',1,$4)`,
    [id, payer, journey, status],
  );
  // Paying for another journey's room is that journey's matter, not this one's.
  await subscribe('sub_elsewhere', ben.user.id, other);
  // Paying in a store: the room stays with the journey, and leaving neither waits on it nor cancels it.
  await h.pool.query(
    `INSERT INTO billing_entitlements (id,payer_user_id,journey_id,capability,source,environment,source_record_id,state,quantity,last_verified_at,created_at,updated_at)
     VALUES ('99999999-1111-4111-8111-111111111111',$1,$2,'additional-journey-capacity','apple','sandbox','store-room','active',1,$3,$3,$3)`,
    [ben.user.id, journeyId, new Date('2026-08-02T12:00:00.000Z')],
  );
  await subscribe('sub_here', ben.user.id, journeyId);
  const waits = await h.leave(ben, journeyId);
  assert.equal(waits.statusCode, 409, waits.body);
  assert.equal(waits.json().error.code, 'billing_subscription_active');
  assert.equal(waits.json().error.message, 'You pay on the web for room in this journey. End that payment and wait for it to finish, then you can leave.');
  assert.equal((await h.memberIds(journeyId)).length, 2);

  await h.pool.query("UPDATE billing_subscriptions SET status='canceled' WHERE provider_subscription_id='sub_here'");
  assert.equal((await h.leave(ben, journeyId)).statusCode, 204);
  const store = await h.pool.query("SELECT state FROM billing_entitlements WHERE source_record_id='store-room'");
  assert.equal(store.rows[0].state, 'active', 'the store room is not cancelled by leaving');
});

test('the phone\'s own client leaves through this server, and the journey is gone from its next read', async (t) => {
  const h = await harness(t);
  const ana = await h.person('ana-phone');
  const journeyId = await h.journey(ana);
  const source = await readFile(new URL('../apps/mobile/src/api/client.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const { createAccountClient } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
  let held = null;
  const phone = createAccountClient({
    base: () => '/api/v1',
    tokens: { read: async () => held, write: async (value) => { held = value; }, clear: async () => { held = null; } },
    fetch: async (url, init) => {
      const response = await h.app.inject({ method: init.method, url, headers: init.headers, payload: init.body });
      return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => response.json() };
    },
  });
  await phone.register({ email: 'ben-phone@example.test', username: 'ben-phone', password: PASSWORD });
  await phone.verifyEmail(h.mailer.messages.findLast((message) => message.type === 'verification' && message.to === 'ben-phone@example.test').token);
  await h.call(ana, 'POST', `/journeys/${journeyId}/invitations`, { email: 'ben-phone@example.test' });
  // The phone has no accept of its own yet: the invitation is opened with its credential.
  const accepted = await h.app.inject({ method: 'POST', url: '/api/v1/invitations/accept', headers: { authorization: `Bearer ${held.token}` }, payload: { token: h.tokenFor('ben-phone@example.test') } });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.deepEqual((await phone.journeys()).map((journey) => journey.id), [journeyId]);

  await phone.leaveJourney(journeyId);
  assert.deepEqual(await phone.journeys(), [], 'the next read has nothing to show: the empty start');
  await assert.rejects(phone.snapshot(journeyId), { status: 403 });
  await assert.rejects(phone.leaveJourney(journeyId), { status: 404, code: 'not_found' });
  assert.equal((await h.read(ana, journeyId)).json().data.events.at(-1).summary, 'ben-phone left the journey');
});
