import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { newDb } from 'pg-mem';
import { loadConfig } from '../server/config.js';
import { withTransaction } from '../server/db.js';
import { MemoryMailer } from '../server/mailer.js';
import { PlatformService } from '../server/platform.js';
import { StorePurchaseService } from '../server/store-purchases.js';
import {
  HISTORY_ENTRY_PARTS, HISTORY_EVENT_GROUPS, HISTORY_EVENT_KINDS, HISTORY_FIELDS, HISTORY_GUIDE_SECTIONS, HISTORY_GUIDE_TITLE,
} from '../src/history-guide.js';

// #349: "How to read your history" explains every kind of entry the server writes into a journey's
// History, and every value it writes into one. A new kind of entry or a new value can never ship
// unexplained: the kinds are read from server/*.js, and every one of them is then written for real,
// against the same migrations the server runs, so the values each writes are the ones checked.

const origin = 'http://127.0.0.1:4174';
const DAY = 24 * 60 * 60 * 1000;
const serverDirectory = new URL('../server/', import.meta.url);

// What writes into History (journey_events), and what writes into a moment's private record, which
// is never shown to anyone and is not History. An `action:` that appears anywhere else in the server
// counts as History, so a new way of writing an entry is checked rather than missed.
const PRIVATE_WRITER = 'appendPrivateMomentEvent(';
const HISTORY_WRITERS = ['appendEvent(', 'recordInvitationStep(', 'history('];

async function kindsInServerCode() {
  const kinds = new Map();
  const files = (await readdir(serverDirectory)).filter((name) => name.endsWith('.js')).sort();
  for (const name of files) {
    const source = await readFile(new URL(name, serverDirectory), 'utf8');
    for (const match of source.matchAll(/\baction:\s*([^,\n]+)/g)) {
      const before = source.slice(0, match.index);
      const nearest = [PRIVATE_WRITER, ...HISTORY_WRITERS].map((writer) => [writer, before.lastIndexOf(writer)]).sort((a, b) => b[1] - a[1])[0];
      if (nearest[0] === PRIVATE_WRITER && nearest[1] >= 0) continue;
      for (const [, kind] of match[1].matchAll(/'([a-z_]+)'/g)) {
        if (!kinds.has(kind)) kinds.set(kind, `server/${name}`);
      }
    }
  }
  return kinds;
}

const MIGRATIONS = [
  '001_platform', '003_private_usernames', '004_shared_moments', '005_make-shared-journeys-more-humane', '006_expand-shared-moment-vocabulary',
  '007_person_specific_moment_visibility', '008_stripe_web_billing', '009_reserve-group-places', '011_hold-one-image-with-each-moment',
  '012_bill-additional-moment-images', '013_name-moment-image-attachments', '014_hold-places-with-shared-moments', '015_bill-additional-moment-places',
  '016_make-extra-image-payments-one-time', '017_keep-one-removed-photo-per-moment', '018_allow-ninety-nine-paid-journey-places',
  '019_let-moments-carry-their-own-atmosphere', '020_let-entitlements-hold-ninety-nine-places', '021_let-unpaid-capacity-rest-without-losing-history',
  '022_agree-together-before-adding-someone', '023_let-a-phone-carry-its-own-key', '024_let-google-and-apple-open-an-account',
  '025_revoke-sign-in-with-apple-when-an-account-is-deleted', '026_remember-a-refused-apple-deletion', '027_tie-every-store-purchase-to-an-account',
  '028_turn-a-store-purchase-into-capacity', '029_rest-read-only-and-let-the-payer-ask-for-time', '030_ask-for-six-weeks-a-year',
  '031_let-a-lost-renewal-reply-be-asked-again', '032_let-an-invitation-last-fourteen-days',
];

async function harness(t, configOverrides) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  memory.public.registerFunction({ name: 'char_length', args: ['text'], returns: 'integer', implementation: (value) => value.length });
  memory.public.registerFunction({ name: 'jsonb_array_length', args: ['jsonb'], returns: 'integer', implementation: (value) => (Array.isArray(value) ? value.length : 0) });
  const pool = new (memory.adapters.createPg().Pool)();
  for (const name of MIGRATIONS) {
    // pg-mem names an unnamed column check differently from Postgres; see tests/store-purchases.test.js.
    if (name.startsWith('028_')) {
      await pool.query('ALTER TABLE moment_image_slots DROP CONSTRAINT IF EXISTS moment_image_slots_constraint_1');
      await pool.query('ALTER TABLE moment_location_slots DROP CONSTRAINT IF EXISTS moment_location_slots_constraint_1');
    }
    // pg-mem cannot parse NOT VALID (030); tests/postgres-integration runs 030 as written.
    await pool.query((await readFile(new URL(`../server/migrations/${name}.sql`, import.meta.url), 'utf8')).replace(') NOT VALID;', ');'));
  }
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: origin, SESSION_SECRET: 's'.repeat(32), AUDIT_HMAC_KEY: 'a'.repeat(32), ...configOverrides });
  const clock = { now: new Date('2026-08-02T12:00:00.000Z') };
  const mailer = new MemoryMailer();
  const platform = new PlatformService({ pool, config, mailer, now: () => clock.now });
  t.after(() => pool.end());
  async function person(name) {
    const email = `${name}@example.test`;
    const { user } = await platform.register({ email, username: name, password: 'a long enough password' }, origin, { issueSession: false });
    await platform.verifyEmail(mailer.messages.findLast((message) => message.type === 'verification' && message.to === email).token);
    return { id: user.id, email };
  }
  const journey = (owner, name) => platform.createJourney(owner.id, { name, location: '', startDateStatus: 'unknown', endDateStatus: 'forever', budgetCents: 0 });
  const tokenFor = (email) => mailer.messages.findLast((message) => message.type === 'invitation' && message.to === email).token;
  const events = async () => (await pool.query('SELECT action,entity_type,summary,before_value,after_value FROM journey_events ORDER BY journey_id,sequence')).rows;
  return { pool, config, clock, platform, person, journey, tokenFor, events };
}

// Everything that can happen in a journey, so that every kind of entry is written at least once,
// in each of the shapes it comes in.
async function everyKindOfEntry(t) {
  const h = await harness(t, { JOURNEY_CAPACITY_MODE: 'test-groups' });
  const { platform, pool, clock } = h;
  const [ana, ben, cy, dee] = [await h.person('ana-history'), await h.person('ben-history'), await h.person('cy-history'), await h.person('dee-history')];
  const created = await h.journey(ana, 'Ours');
  const journeyId = created.id;
  await platform.updateJourney(ana.id, journeyId, { version: created.version, name: 'Ours, together', location: 'Lisbon' });
  await platform.setMilestone(ana.id, journeyId, 'chosePrompt', true);
  await platform.setMilestone(ana.id, journeyId, 'chosePrompt', false);

  // Alone, Ana's asking is everyone's agreement, so the invitation goes straight out.
  const join = async (inviter, invited, agreeing = []) => {
    const { proposalId } = await platform.proposeInvitation(inviter.id, journeyId, invited.email, 'From the photos', origin);
    for (const member of agreeing) await platform.decideInviteProposal(member.id, journeyId, proposalId, 'agree', origin);
    await platform.acceptInvitation(invited.id, h.tokenFor(invited.email));
  };
  await join(ana, ben);
  await join(ana, cy, [ben]);
  await join(ben, dee, [ana, cy]);
  const everyoneBut = (asker) => [ana, ben, cy, dee].filter((member) => member !== asker);
  const declined = await platform.proposeInvitation(ben.id, journeyId, 'declined@example.test', '', origin);
  await platform.decideInviteProposal(ana.id, journeyId, declined.proposalId, 'decline', origin);
  const takenBack = await platform.proposeInvitation(cy.id, journeyId, 'taken-back@example.test', '', origin);
  await platform.withdrawInviteProposal(cy.id, journeyId, takenBack.proposalId);
  const withdrawn = await platform.proposeInvitation(ana.id, journeyId, 'withdrawn@example.test', '', origin);
  for (const member of everyoneBut(ana)) await platform.decideInviteProposal(member.id, journeyId, withdrawn.proposalId, 'agree', origin);
  const invitationTo = async (email) => (await pool.query('SELECT id FROM invitations WHERE email_normalized=$1 ORDER BY created_at DESC LIMIT 1', [email])).rows[0].id;
  await platform.withdrawInvitation(ana.id, journeyId, await invitationTo('withdrawn@example.test'));
  const lapsing = await platform.proposeInvitation(ben.id, journeyId, 'lapsing@example.test', '', origin);
  for (const member of everyoneBut(ben)) await platform.decideInviteProposal(member.id, journeyId, lapsing.proposalId, 'agree', origin);
  await platform.proposeInvitation(cy.id, journeyId, 'unanswered@example.test', '', origin);

  // A shared moment, changed with its theme, then deleted; and one held, then shared.
  const momentInput = {
    kind: 'memory', title: 'The harbour', detail: 'What we said there', occurredOn: '2026-08-01', visibility: 'shared-now', theme: 'light',
    moneyCents: 1250, moneyCurrency: 'EUR', locations: [{ label: 'Harbour', latitude: 38.7, longitude: -9.1, accuracyMeters: 12 }],
  };
  const moment = await platform.createMoment(ana.id, journeyId, momentInput);
  const changed = await platform.mutateMoment(ben.id, journeyId, moment.id, { ...momentInput, title: 'The harbour at night', theme: 'dark', version: moment.version });
  await platform.mutateMoment(ana.id, journeyId, moment.id, { version: changed.version }, { remove: true });
  const held = await platform.createMoment(cy.id, journeyId, { ...momentInput, kind: 'other', kindLabel: 'A small thing', visibility: 'share-later' });
  await platform.mutateMoment(cy.id, journeyId, held.id, { visibility: 'shared-now', version: held.version });

  // Expenses, one paid by Cy, who later deletes their account.
  const expenseInput = { merchant: 'Guesthouse', category: 'Hotel', amountCents: 5000, occurredOn: '2026-08-01', paidByUserId: cy.id, payerLabel: 'Cy', status: 'paid', account: 'Card ending 1', reference: 'R-1', notes: 'Two nights' };
  const expense = await platform.createExpense(ana.id, journeyId, expenseInput);
  await platform.mutateExpense(ana.id, journeyId, expense.id, { amountCents: 5500, status: 'due', version: expense.version });
  const mistaken = await platform.createExpense(ben.id, journeyId, { ...expenseInput, paidByUserId: ben.id, merchant: 'Taxi', category: 'Transportation' });
  await platform.mutateExpense(ben.id, journeyId, mistaken.id, { version: mistaken.version }, { remove: true });

  const concern = await platform.createConcern(ben.id, journeyId, { title: 'The last evening', detail: 'Something to say', status: 'open' });
  const resolved = await platform.mutateConcern(ana.id, journeyId, concern.id, { status: 'resolved', version: concern.version });
  await platform.mutateConcern(ana.id, journeyId, concern.id, { version: resolved.version }, { remove: true });

  await platform.setRestOrder(ana.id, journeyId, { restOrder: [ben.id, cy.id, dee.id] });
  await pool.query('INSERT INTO journeys_made_read_only (journey_id,changed_at) VALUES ($1,$2)', [journeyId, '2026-08-01T00:00:00.000Z']);
  await platform.recordRestingMadeReadOnly();

  // Paid room moving between journeys, in each of the three ways it can leave one.
  const elsewhere = await h.journey(ana, 'Elsewhere');
  const store = new StorePurchaseService({ pool, config: h.config, now: () => clock.now, history: (client, event) => platform.appendEvent(client, event) });
  const room = (state, expiresAt) => ({ journey_id: journeyId, payer_user_id: ana.id, source: 'apple', environment: 'sandbox', source_record_id: `sub-${state}`, state, quantity: 49, expires_at: expiresAt, reason: null });
  const purchase = { id: 'purchase-1', journey_id: elsewhere.id, payer_user_id: ana.id, purchased_at: clock.now };
  await withTransaction(pool, (client) => store.moveRoom(client, room('active', new Date(clock.now.getTime() + 20 * DAY)), purchase, 49));
  await withTransaction(pool, (client) => store.moveRoom(client, room('expired', new Date(clock.now.getTime() - 20 * DAY)), { ...purchase, id: 'purchase-2' }, 49));
  await withTransaction(pool, (client) => store.graceAfterDeferredReplacement(client, room('active', new Date(clock.now.getTime() + 20 * DAY)), { ...purchase, id: 'purchase-3' }, new Date(clock.now.getTime() + 20 * DAY)));

  await platform.eraseAccount(cy.id);
  await platform.removeMember(ana.id, journeyId, dee.id);
  await platform.changeDisplayName(ben.id, { displayName: 'Benedict' });
  await platform.transferOwnership(ana.id, journeyId, ben.id);

  // Fifteen days on, the invitation has run out, and whoever asked sends it again. Past thirty,
  // the question nobody answered has run out too.
  clock.now = new Date(clock.now.getTime() + 15 * DAY);
  await platform.snapshot(ben.id, journeyId);
  await platform.sendInvitationAgain(ben.id, journeyId, await invitationTo('lapsing@example.test'), origin);
  clock.now = new Date(clock.now.getTime() + 16 * DAY);
  const snapshot = await platform.snapshot(ben.id, journeyId);
  assert.equal(snapshot.eventChainValid, true);
  return { written: await h.events(), entry: snapshot.events[0] };
}

// Asking for more time needs a journey whose payment is in grace, which only billing has.
async function moreTimeAskedFor(t) {
  const h = await harness(t, { JOURNEY_CAPACITY_MODE: 'billing', BILLING_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_fake', STRIPE_ADDITIONAL_PERSON_PRICE_ID: 'price_fake' });
  const sam = await h.person('sam-history');
  const { id: journeyId } = await h.journey(sam, 'Waiting on a payment');
  await h.pool.query(
    `INSERT INTO billing_entitlements (id,payer_user_id,journey_id,capability,source,environment,source_record_id,state,quantity,expires_at,last_verified_at,created_at,updated_at)
     VALUES ($1,$2,$3,'additional-journey-capacity','stripe','test','sub_grace','grace',1,$4,$5,$5,$5)`,
    ['33333333-3333-4333-8333-333333333333', sam.id, journeyId, new Date(h.clock.now.getTime() + 7 * DAY), h.clock.now],
  );
  await h.platform.requestMoreGrace(sam.id, journeyId);
  return h.events();
}

const keysOf = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []);
const pattern = (reads) => new RegExp(`^${reads.split('…').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+')}$`);

test('the guide explains every kind of entry the server writes, and none it no longer writes', async () => {
  const inCode = await kindsInServerCode();
  // The paid room moves are written from the store purchases, not the platform (#349's correction).
  assert.equal(inCode.get('paid_room_moved_out'), 'server/store-purchases.js', 'every server file is read');
  assert.ok(!inCode.has('visibility_changed'), 'a moment\'s private record is not History');
  for (const [kind, file] of inCode) assert.ok(HISTORY_EVENT_KINDS[kind], `${file} writes History entries of the kind ${kind}, which "How to read your history" (src/history-guide.js) does not explain`);
  for (const kind of Object.keys(HISTORY_EVENT_KINDS)) assert.ok(inCode.has(kind), `src/history-guide.js explains ${kind}, which the server no longer writes`);
  assert.equal(new Set(HISTORY_EVENT_GROUPS.flatMap((group) => group.kinds.map((kind) => kind.action))).size, HISTORY_EVENT_GROUPS.flatMap((group) => group.kinds).length, 'each kind is explained once');
});

test('every value the server writes into an entry is explained, kind by kind, and the summaries read as the guide says', async (t) => {
  const { written, entry } = await everyKindOfEntry(t);
  const all = [...written, ...await moreTimeAskedFor(t)];
  const inCode = await kindsInServerCode();
  const seen = new Set(all.map((event) => event.action));
  for (const kind of inCode.keys()) assert.ok(seen.has(kind), `${kind} is written by the server but not by this test, so its values go unchecked. Add it to everyKindOfEntry.`);

  const valuesSeen = new Map();
  const readsSeen = new Set();
  for (const event of all) {
    const kind = HISTORY_EVENT_KINDS[event.action];
    assert.ok(kind, `the server wrote ${event.action}, which the guide does not explain`);
    for (const key of [...keysOf(event.before_value), ...keysOf(event.after_value)]) {
      assert.ok(kind.records.includes(key), `${event.action} writes ${key}, which the guide does not list among what it records`);
      if (!valuesSeen.has(event.action)) valuesSeen.set(event.action, new Set());
      valuesSeen.get(event.action).add(key);
    }
    const reads = kind.reads.find((candidate) => pattern(candidate).test(event.summary));
    assert.ok(reads, `${event.action} reads "${event.summary}", which is none of the ways the guide says it reads`);
    readsSeen.add(`${event.action}:${reads}`);
  }
  for (const kind of Object.values(HISTORY_EVENT_KINDS)) {
    assert.deepEqual([...(valuesSeen.get(kind.action) || [])].sort(), [...kind.records].sort(), `what the guide says ${kind.action} records is what it records`);
    for (const reads of kind.reads) assert.ok(readsSeen.has(`${kind.action}:${reads}`), `${kind.action} was never seen to read "${reads}"`);
    for (const field of kind.records) assert.ok(HISTORY_FIELDS[field], `${field} has no explanation under What each value means`);
  }
  // A place is a value made of values; each of them is named in the explanation of places.
  const places = all.flatMap((event) => [event.before_value, event.after_value]).flatMap((value) => value?.locations || []);
  assert.ok(places.length > 0);
  for (const key of new Set(places.flatMap(Object.keys))) assert.ok(HISTORY_FIELDS.locations.includes(key), `places carry ${key}, which the explanation of places does not name`);

  // What an entry can be about is listed by name, every one of them.
  const named = HISTORY_ENTRY_PARTS.entityType.match(/: ([^.]+)\./)[1].split(/, | or /);
  assert.deepEqual([...new Set(all.map((event) => event.entity_type))].sort(), [...named].sort());
  // And every part of the entry itself, as the apps receive it.
  assert.deepEqual(Object.keys(entry).sort(), Object.keys(HISTORY_ENTRY_PARTS).sort());
});

test('every explanation of a value is used by some kind of entry', () => {
  const used = new Set(Object.values(HISTORY_EVENT_KINDS).flatMap((kind) => kind.records));
  for (const field of Object.keys(HISTORY_FIELDS)) assert.ok(used.has(field), `${field} is explained but no kind of entry records it`);
});

test('the guide says what the owner asked it to say (#349)', () => {
  assert.equal(HISTORY_GUIDE_TITLE, 'How to read your history');
  const text = HISTORY_GUIDE_SECTIONS.map((section) => [section.heading, ...section.paragraphs].join(' ')).join(' ');
  for (const words of ['hash', 'Previous', 'chain', 'Server-authoritative', 'Account-attributed', 'tombstone', 'two entries', 'UTC']) assert.match(text, new RegExp(words));
  for (const kind of Object.values(HISTORY_EVENT_KINDS)) {
    assert.ok(kind.when && kind.never && kind.reads.length, `${kind.action} says when it is written and what it never records`);
  }
});

test('the web and the phone draw the same words, and History\'s intro leads to them', async () => {
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const [guide, web, html, build, phoneGuide, phoneHistory, layout] = await Promise.all([
    read('src/history-guide.js'), read('src/app.js'), read('index.html'), read('scripts/build-public-site.mjs'),
    read('apps/mobile/app/history-guide.tsx'), read('apps/mobile/app/history.tsx'), read('apps/mobile/app/_layout.tsx'),
  ]);
  const exported = [...guide.matchAll(/^export const (HISTORY_[A-Z_]+)/gm)].map(([, name]) => name).filter((name) => name !== 'HISTORY_EVENT_KINDS');
  for (const name of exported) {
    assert.match(web, new RegExp(`\\b${name}\\b`), `the web draws ${name}`);
    assert.match(phoneGuide, new RegExp(`\\b${name}\\b`), `the phone draws ${name}`);
  }
  assert.match(web, /from '\.\/history-guide\.js'/);
  assert.match(phoneGuide, /from '\.\.\/\.\.\/\.\.\/src\/history-guide\.js'/);
  assert.match(build, /'src\/history-guide\.js'/, 'the web ships the guide');
  // The words of the link are the guide's own title, on both.
  assert.match(html, /<button class="button quiet" type="button" id="history-guide-link" hidden>How to read your history<\/button>/);
  assert.match(html, /<section class="history-guide" id="history-guide"/);
  assert.match(phoneHistory, /<Button kind="quiet" label=\{HISTORY_GUIDE_TITLE\} onPress=\{\(\) => router\.push\('\/history-guide'\)\} \/>/);
  assert.match(layout, /<Stack\.Screen name="history-guide" options=\{\{ title: 'How to read your history' \}\} \/>/);
});
