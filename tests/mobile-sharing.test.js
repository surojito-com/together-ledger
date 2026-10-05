import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import * as model from '../src/model.js';
import * as momentThemes from '../src/moment-themes.js';

// TL-M-09 (#184): the phone's journey settings, compared with what the web actually runs.

const mobile = new URL('../apps/mobile/', import.meta.url);
const read = (path) => readFile(new URL(path, mobile), 'utf8');
const web = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

async function importMobile(path) {
  const url = new URL(path, mobile);
  const source = await readFile(url, 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const linked = outputText.replace(/from '(\.[^']+\.js)'/g, (_, specifier) => `from '${new URL(specifier, url).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(linked).toString('base64')}`);
}

function webFunction(name, ...scope) {
  const start = web.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `the web still has ${name}()`);
  let depth = 0;
  let end = web.indexOf('{', start);
  for (; end < web.length; end += 1) {
    if (web[end] === '{') depth += 1;
    if (web[end] === '}' && --depth === 0) break;
  }
  return new Function(...scope.map(([key]) => key), `${web.slice(start, end + 1)}; return ${name};`)(...scope.map(([, value]) => value));
}

const view = await importMobile('src/journey/sharing-view.ts');
const screens = {
  sharing: await read('app/journey-settings.tsx'),
  history: await read('app/history.tsx'),
  concern: await read('app/concern.tsx'),
  account: await read('app/account.tsx'),
};

test('countdowns are the web\'s own function, and statuses read as the web labels them', () => {
  assert.equal(view.remainingLabel, model.remainingLabel);
  const proposalStatus = webFunction('proposalStatusLabel');
  const decision = webFunction('proposalDecisionLabel');
  const invitation = webFunction('invitationStatusLabel');
  for (const status of ['open', 'agreed', 'declined', 'withdrawn', 'lapsed', 'something-new']) assert.equal(view.proposalStatusLabel(status), proposalStatus(status));
  for (const value of ['agree', 'decline', 'pending', 'unknown']) assert.equal(view.proposalDecisionLabel(value), decision(value));
  for (const status of ['accepted', 'expired', 'pending', 'revoked', 'other']) assert.equal(view.invitationStatusLabel(status), invitation(status));
  const dateTimeLabel = webFunction('dateTimeLabel');
  for (const value of ['2026-10-01T13:33:11Z', '', null, 'not a date']) assert.equal(view.dateTimeLabel(value), dateTimeLabel(value));
});

test('a proposal\'s progress, its answers and who may withdraw it follow the web', () => {
  const open = { id: 'p1', email: 'sam@example.test', status: 'open', agreedCount: 1, askedCount: 3, pendingCount: 2, proposedByUserId: 'asker', viewerMayDecide: true, decisions: [] };
  assert.equal(view.proposalProgress(open), '1 of 3 have agreed · 2 still to answer');
  assert.equal(view.proposalProgress({ ...open, status: 'agreed', agreedCount: 3 }), '3 of 3 agreed');
  assert.ok(web.includes('`${proposal.agreedCount} of ${proposal.askedCount} have agreed · ${proposal.pendingCount} still to answer`'));
  assert.equal(view.mayWithdraw(open, { viewerId: 'asker', journeyRole: 'member' }), true, 'whoever asked');
  assert.equal(view.mayWithdraw(open, { viewerId: 'someone', journeyRole: 'owner' }), true, 'or the owner');
  assert.equal(view.mayWithdraw(open, { viewerId: 'someone', journeyRole: 'member' }), false, 'nobody else');
  assert.equal(view.mayWithdraw({ ...open, status: 'lapsed' }, { viewerId: 'asker' }), false, 'only while it is open');
  assert.equal(view.decisionAnswered({ decision: 'pending' }), 'has not answered yet');
  assert.match(view.decisionAnswered({ decision: 'decline', decidedAt: '2026-10-01T10:00:00Z' }), /^declined /);
});

test('every question asked before an act is the web\'s, word for word, and only the irreversible ones are destructive', () => {
  const e = 'sam@example.test';
  const n = 'Sam';
  const pairs = [
    [view.CONSEQUENCES.withdraw(e), 'Withdraw the proposal to add ${proposal.email}?'],
    [view.CONSEQUENCES.agree(e), 'Agree to add ${proposal.email}?'],
    [view.CONSEQUENCES.decline(e), 'Decline adding ${proposal.email}?'],
    [view.CONSEQUENCES.transfer(n), 'Make ${memberName} the journey owner?'],
    [view.CONSEQUENCES.remove(n), 'Remove ${memberName} from this journey?'],
  ];
  for (const [phone, webTitle] of pairs) {
    assert.ok(web.includes(webTitle), `the web still asks ${webTitle}`);
    assert.ok(web.includes(phone.consequence), `"${phone.consequence.slice(0, 40)}…" is the web's`);
    assert.ok(web.includes(`confirmLabel: '${phone.confirmLabel}'`), `${phone.confirmLabel} is the web's`);
  }
  assert.ok(web.includes('The event history keeps a deletion tombstone, so the change stays attributable.'));
  assert.equal(view.CONSEQUENCES.agree(e).destructive, undefined, 'agreeing is not a failure');
  assert.equal(view.CONSEQUENCES.withdraw(e).destructive, undefined);
  assert.equal(view.CONSEQUENCES.transfer(n).destructive, undefined);
  assert.equal(view.CONSEQUENCES.decline(e).destructive, true);
  assert.equal(view.CONSEQUENCES.remove(n).destructive, true);
  assert.equal(view.CONSEQUENCES.deleteConcern('Dinner').destructive, true);
  for (const toast of [view.decisionToast(true, true), view.decisionToast(true, false), view.decisionToast(false, false), view.proposeToast(true), view.proposeToast(false)]) {
    assert.ok(web.includes(toast), `"${toast}" is the web's`);
  }
});

test('the journey record and the sharing copy read as the web writes them', () => {
  assert.equal(view.sharingCopy(1, true), '1 person is here. There is room to add another person, and everybody here has to agree to them. Each person signs in separately.');
  assert.equal(view.sharingCopy(3, false), '3 people are here. There is no open place right now. Each person signs in separately.');
  const snapshot = {
    journey: { id: 'j', name: 'Ours', role: 'owner', createdAt: '2026-09-01T10:00:00Z' },
    members: [{ id: 'a', displayName: 'Alex', role: 'owner', joinedAt: '2026-09-01T10:00:00Z' }, { id: 'b', displayName: 'Bo', role: 'member', joinedAt: '2026-09-02T10:00:00Z' }],
    concerns: [],
    events: [{ id: 'e1', sequence: 1, actorUserId: 'a', action: 'journey_created', summary: 'Created', before: null, after: null, createdAt: '2026-09-01T09:59:00Z' }],
  };
  const creator = view.journeyCreator(snapshot);
  assert.deepEqual(creator, { userId: 'a', createdAt: '2026-09-01T09:59:00Z' }, 'the creation event wins');
  const alex = view.memberRow(snapshot.members[0], { creatorId: 'a', createdAt: creator.createdAt, viewerId: 'a' });
  assert.equal(alex.description, 'Created by Alex');
  assert.equal(alex.role, 'Owner · You');
  assert.equal(view.memberRow(snapshot.members[1], { creatorId: 'a', createdAt: creator.createdAt, viewerId: 'a' }).description, 'Bo joined the journey');
  assert.equal(view.mayManageMember(snapshot.members[1], { journeyRole: 'owner', viewerId: 'a' }), true);
  assert.equal(view.mayManageMember(snapshot.members[0], { journeyRole: 'owner', viewerId: 'a' }), false, 'never yourself');
  assert.equal(view.mayManageMember(snapshot.members[0], { journeyRole: 'member', viewerId: 'b' }), false, 'only the owner');
  assert.equal(view.mayPropose({ ...snapshot, capacity: { canInvite: false } }), false);
  assert.equal(view.mayPropose({ ...snapshot, members: [snapshot.members[0]] }), true, 'with no capacity answer, a journey of one has room');
});

test('resting capacity: only the owner of a billed journey, the web\'s order rule, and no one removed', () => {
  const owner = { journey: { role: 'owner' }, capacity: { mode: 'billing' } };
  assert.equal(view.showsUnpaidCapacityRest(owner), true);
  assert.equal(view.showsUnpaidCapacityRest({ ...owner, journey: { role: 'member' } }), false);
  assert.equal(view.showsUnpaidCapacityRest({ ...owner, capacity: { mode: 'included' } }), false);
  const members = [{ id: 'creator', role: 'owner' }, { id: 'x', role: 'member' }, { id: 'y', role: 'member' }, { id: 'z', role: 'member' }];
  assert.deepEqual(view.restQueue(members, 'creator').map((member) => member.id), ['x', 'y', 'z']);
  let saved = null;
  const moveRestOrder = webFunction('moveRestOrder', ['saveUnpaidCapacityRest', (_trip, payload) => { saved = payload; }]);
  for (const [id, direction] of [['y', -1], ['y', 1], ['x', -1], ['z', 1], ['nobody', 1]]) {
    saved = null;
    moveRestOrder({}, ['x', 'y', 'z'], id, direction);
    assert.deepEqual(view.moveInOrder(['x', 'y', 'z'], id, direction), saved?.restOrder ?? null, `${id} ${direction}`);
  }
  for (const mode of ['read-only', 'paused']) assert.ok(web.includes(view.restModeCopy(mode)));
  for (const [value, label] of view.REST_MODES) assert.ok(html.includes(`value="${value}" /> ${label}`), `${label} is the web's word`);
});

test('history is newest first, attributed, and lists only what changed, as the web does', () => {
  const meaningfulChanges = webFunction('meaningfulChanges');
  const pairs = [[{ a: 1, b: 2 }, { a: 1, b: 3, c: 4 }], [null, { title: 'x' }], [{ list: [1, 2] }, { list: [1, 2] }]];
  for (const [before, after] of pairs) assert.deepEqual(view.meaningfulChanges(before, after), meaningfulChanges(before, after));
  const valueLabel = webFunction('valueLabel', ['money', model.money], ['momentThemeLabel', momentThemes.momentThemeLabel]);
  for (const [key, value] of [['budgetCents', 1250], ['theme', 'flexoki'], ['tags', ['a', 'b']], ['title', ''], ['x', { y: 1 }], ['n', 3]]) assert.equal(view.valueLabel(key, value), valueLabel(key, value));
  const events = view.historyEvents({
    members: [{ id: 'a', displayName: 'Alex' }],
    events: [
      { id: 'e2', sequence: 2, actorUserId: 'gone', summary: 'Second', before: null, after: null },
      { id: 'e1', sequence: 1, actorUserId: 'a', summary: 'First', before: null, after: { title: 't' } },
    ],
  });
  assert.deepEqual(events.map((event) => event.id), ['e2', 'e1'], 'newest first');
  assert.equal(events[0].actorName, 'Former journeyer');
  assert.equal(events[0].previousEventId, 'e1');
  assert.equal(events[1].actorName, 'Alex');
  assert.deepEqual(events[1].changes, [{ key: 'title', before: undefined, after: 't' }]);
});

test('the billing panel is read only: it names no price and offers no purchase (#203, option A)', () => {
  const states = [
    { journey: { name: 'Ours' } },
    { journey: { name: 'Ours' }, entitlement: { state: 'active', quantity: 2 } },
    { journey: { name: 'Ours' }, entitlement: { state: 'grace' } },
    { journey: { name: 'Ours' }, entitlement: { state: 'pending' } },
    { journey: { name: 'Ours' }, entitlement: { state: 'ended' } },
    { journey: { name: 'Ours' }, entitlement: { state: 'active' }, subscription: { cancelAtPeriodEnd: true } },
  ];
  for (const status of states) {
    const { message, tone } = view.billingSummary(status);
    assert.doesNotMatch(message, /\$|USD|per month|each month|buy|purchase|checkout/i, message);
    assert.ok(['', 'settled', 'waiting'].includes(tone));
  }
  assert.equal(view.billingSummary(states[0]).message, 'The first two people in Ours are included.');
  assert.equal(view.billingSummary(states[1]).message, '2 additional people are covered for this journey.');
  assert.equal(view.billingGlyph('settled'), '●');
  assert.equal(view.billingGlyph('waiting'), '▲');
  for (const source of Object.values(screens)) {
    assert.doesNotMatch(source, /checkout|portal-sessions|createCheckout|Linking\.openURL/i, 'no purchase path from the phone');
  }
  const billing = screens.sharing.slice(screens.sharing.indexOf('function Billing('));
  assert.doesNotMatch(billing.slice(0, billing.indexOf('\n}\n')), /destructive/, 'waiting and settled are not failures');
});

test('the words: capacity rests, nobody is removed for non-payment, and nothing is a seat or a slot', async () => {
  for (const source of [...Object.values(screens), await read('src/journey/sharing-view.ts')]) {
    assert.doesNotMatch(source, /\bseats?\b|\blicen[cs]es?\b|\bslots?\b/i);
  }
  assert.match(screens.sharing, /Nobody is removed and no history is lost\./);
  assert.ok(html.includes('Nobody is removed and no history is lost.'));
});

test('a name is changed from Account, and the private handle is never edited (#253)', () => {
  assert.match(screens.account, /label="Name journeyers see"/);
  assert.match(screens.account, /changeDisplayName/);
  assert.doesNotMatch(screens.account, /changeUsername|username:\s*name/);
});

test('sharing and history re-read the journey when they come into view, and can be pulled to refresh', async () => {
  // Found in the Simulator: a proposal made by someone else never appeared until the app was
  // restarted, so a question about another person's access was answered from a stale view.
  for (const source of [screens.sharing, screens.history]) {
    assert.match(source, /useReloadWhenShown\(\);/);
    assert.match(source, /refresh=\{\{ refreshing, onRefresh: refresh \}\}/);
  }
  const loader = await read('src/journey/use-journey.ts');
  assert.match(loader, /useFocusEffect\(useCallback\(\(\) => \{\n\s+reload\(\);\n\s+\}, \[reload\]\)\)/);
  // reload is memoised, so the focus effect runs once per arrival rather than on every render.
  assert.match(loader, /const reload = useCallback\(async \(\) => \{/);
});

// A journey can hold 101 people. The web folds that list; before this the phone did not, on the
// smaller screen of the two. Both now fold at the same size, by the same rule, and the rule is
// read back out of the web's own source so the two cannot drift apart unnoticed.
test('a large journey folds on the phone exactly as it folds on the web', () => {
  const webFold = Number(/const MEMBERS_SHOWN_BEFORE_FOLDING = (\d+);/.exec(web)?.[1]);
  assert.ok(Number.isInteger(webFold), 'the web still names a fold size');
  assert.equal(view.MEMBERS_SHOWN_BEFORE_FOLDING, webFold);

  const member = (id, role = 'member') => ({ id, displayName: id, role, joinedAt: '2026-09-07T15:00:00.000Z' });
  const viewerId = 'me';

  // At or below the fold size nothing is hidden, so a small journey reads as it always has.
  const small = [member('owner', 'owner'), member('me'), member('b')];
  assert.deepEqual(view.splitMembers(small, { viewerId }), { inView: small, folded: [] });

  const atTheLimit = [member('owner', 'owner'), ...Array.from({ length: webFold - 1 }, (_, index) => member(`m${index}`))];
  assert.equal(view.splitMembers(atTheLimit, { viewerId }).folded.length, 0);

  // Past it, what stays in view answers who holds the journey and where the viewer stands.
  const large = [member('owner', 'owner'), member('me'), ...Array.from({ length: webFold }, (_, index) => member(`m${index}`))];
  const { inView, folded } = view.splitMembers(large, { viewerId });
  assert.deepEqual(inView.map((entry) => entry.id), ['owner', 'me']);
  assert.equal(folded.length, webFold);
  // Nobody is dropped: the two halves still account for every person in the journey.
  assert.deepEqual([...inView, ...folded].map((entry) => entry.id).sort(), large.map((entry) => entry.id).sort());

  // A viewer who is not a member of a large journey still sees who holds it.
  assert.deepEqual(view.splitMembers(large, { viewerId: null }).inView.map((entry) => entry.id), ['owner']);

  // And the phone actually uses it, rather than only exporting it.
  assert.match(screens.sharing, /splitMembers\(snapshot\.members, \{ viewerId \}\)/);
  assert.match(screens.sharing, /Show the other \$\{count\} \$\{count === 1 \? 'person' : 'people'\}/);
});

// A proposal is a question put to this person about another person, and it used to be visible
// only inside journey sharing — two screens in on the phone. Both surfaces now carry the count on
// the controls that already lead there, in the same words, read out of the web's own source.
test('a waiting answer is counted the same on the phone as on the web', () => {
  const webCount = webFunction('awaitingYourAnswer');
  const webSuffix = webFunction('waitingSuffix');

  const proposal = (viewerMayDecide) => ({ id: `p${Math.random()}`, viewerMayDecide });
  for (const proposals of [[], [proposal(false)], [proposal(true)], [proposal(true), proposal(false), proposal(true)]]) {
    // The web reads them off the trip, the phone off the snapshot; the answer must not differ.
    assert.equal(view.awaitingYourAnswer({ inviteProposals: proposals }), webCount({ inviteProposalRecords: proposals }));
  }
  // Only what this person can still answer counts: decided and closed proposals are not chores.
  assert.equal(view.awaitingYourAnswer({ inviteProposals: [proposal(false), proposal(false)] }), 0);
  assert.equal(view.awaitingYourAnswer(null), 0);
  assert.equal(view.awaitingYourAnswer({}), 0);

  for (const count of [0, 1, 2, 7]) assert.equal(view.waitingSuffix(count), webSuffix(count));
  assert.equal(view.waitingSuffix(0), '');
  assert.equal(view.waitingSuffix(1), ' · 1 to answer');

  // It is shown where people already are, rather than announced at them.
  assert.match(web, /\$\('#settings-button'\)\.textContent = `Journey settings\$\{waitingSuffix\(awaitingYourAnswer\(trip\)\)\}`/);
  assert.match(screens.sharing, /splitMembers/);
  // Nothing is pushed: no toast, no status banner, no dialog raised for a waiting answer.
  assert.doesNotMatch(web, /showToast\([^)]*to answer/);
  assert.doesNotMatch(web, /showStatus\([^)]*to answer/);
});
