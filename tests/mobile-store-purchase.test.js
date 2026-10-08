import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// TL-P-02 (#269): a store purchase that does not carry our values cannot be tied to anyone, so the
// person is charged for something nobody can honour. Every purchase is built by purchaseOptions()
// in apps/mobile/src/billing/store-purchase.ts, and this fails if one is started anywhere else.

const root = fileURLToPath(new URL('..', import.meta.url));
const mobile = join(root, 'apps/mobile');
const MODULE = 'apps/mobile/src/billing/store-purchase.ts';

async function importMobile(path) {
  const source = await readFile(join(root, path), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

async function walk(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path));
    else if (['.ts', '.tsx', '.js', '.jsx'].includes(extname(entry.name))) found.push(path);
  }
  return found;
}

const store = await importMobile(MODULE);
// Made fresh each run, as the service makes them.
const journeyValue = randomUUID();
const identity = { appAccountToken: journeyValue, obfuscatedAccountId: randomUUID(), obfuscatedProfileId: journeyValue };

test('Apple is given the journey value, and Google the account and the journey', () => {
  assert.deepEqual(store.purchaseOptions(identity, 'ios'), { platform: 'ios', appAccountToken: identity.appAccountToken });
  assert.deepEqual(store.purchaseOptions(identity, 'android'), { platform: 'android', obfuscatedAccountId: identity.obfuscatedAccountId, obfuscatedProfileId: identity.obfuscatedProfileId });
});

test('a purchase without its values never starts, and says nothing was charged', () => {
  const cases = [
    [null, 'ios'],
    [undefined, 'android'],
    [{ ...identity, appAccountToken: '' }, 'ios'],
    [{ ...identity, appAccountToken: 'not-a-uuid' }, 'ios'],
    [{ ...identity, obfuscatedAccountId: '' }, 'android'],
    [{ ...identity, obfuscatedProfileId: undefined }, 'android'],
    [identity, 'web'],
  ];
  for (const [given, platform] of cases) {
    assert.throws(() => store.purchaseOptions(given, platform), (error) => error instanceof store.StorePurchaseRefused && error.code === 'store_identity_missing', `${platform} ${JSON.stringify(given)}`);
  }
  assert.match(store.NOT_STARTED_MESSAGE, /nothing was charged/);
  assert.doesNotMatch(store.NOT_STARTED_MESSAGE, /[$€£]\s?\d|seat|slot|licen[cs]e|upgrade|unlock/i);
});

test('the values come from the service, signed in, for one journey', async () => {
  const client = await readFile(join(mobile, 'src/api/client.ts'), 'utf8');
  assert.match(client, /async storePurchaseIdentity\(journeyId: string\) \{\s*return request<[^>]+>\(`\/journeys\/\$\{encodeURIComponent\(journeyId\)\}\/billing\/store-identity`, \{ method: 'POST', body: \{\}, signedIn: true \}\);/);
});

test('no store purchase is started anywhere but through purchaseOptions()', async () => {
  // The calls StoreKit, Play Billing and the React Native wrappers use to begin a purchase.
  const STARTS = /\b(?:requestPurchase|requestSubscription|launchBillingFlow|purchaseItemAsync|purchaseAsync|buyProduct)\s*\(|\.purchase\s*\(\s*\{/;
  const files = [...await walk(join(mobile, 'app')), ...await walk(join(mobile, 'src'))];
  assert.ok(files.length > 10, 'the guard reads the phone app');
  for (const file of files) {
    const name = relative(root, file);
    const source = await readFile(file, 'utf8');
    const match = STARTS.exec(source);
    if (!match) continue;
    assert.ok(/purchaseOptions\(/.test(source), `${name} starts a store purchase ("${match[0]}") without purchaseOptions() from ${MODULE} (#269)`);
  }
});

// TL-P-05 (#272): the purchase screen. The store library is handed to store-purchase.ts whole, so
// only that file can start a purchase or tell a store one is finished, and only store-kit.ts
// imports the library at all.

const products = await importMobile('apps/mobile/src/billing/store-products.ts');
const product = (id) => products.STORE_PRODUCTS[id];

function fakeKit() {
  const calls = { requests: [], finished: [] };
  return {
    calls,
    async requestPurchase(args) { calls.requests.push(args); },
    async finishTransaction(args) { calls.finished.push(args); },
  };
}

function fakeClient(answer) {
  const sent = [];
  const reply = async (store, body) => {
    sent.push({ store, body });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { sent, sendApplePurchase: (body) => reply('apple', body), sendGooglePurchase: (body) => reply('google', body) };
}

function refusal(code, retryable) {
  const error = new Error(`refused: ${code}`);
  error.code = code;
  error.details = retryable === undefined ? null : { retryable };
  return error;
}

const GRANTED = { purchaseId: 'p', granted: true, productId: 'room_51_week_pass', kind: 'pass', journeyId: 'j', room: { people: 51, state: 'active', from: null, until: null } };

test('the phone sells exactly the server\'s eight products', async () => {
  const server = await import('../server/store-products.js');
  assert.deepEqual(Object.keys(products.STORE_PRODUCTS).sort(), Object.keys(server.STORE_PRODUCTS).sort());
  for (const [id, info] of Object.entries(products.STORE_PRODUCTS)) {
    assert.equal(info.kind, server.STORE_PRODUCTS[id].kind, id);
    if (info.people) assert.equal(info.people, server.STORE_PRODUCTS[id].people, id);
  }
  assert.deepEqual([...products.SUBSCRIPTION_IDS, ...products.ONE_TIME_IDS].sort(), Object.keys(server.STORE_PRODUCTS).sort());
});

test('a purchase carries our values to each store, and a Google subscription its monthly offer', () => {
  const ios = store.purchaseOptions(identity, 'ios');
  const android = store.purchaseOptions(identity, 'android');
  assert.deepEqual(store.purchaseRequest(ios, product('room_51_monthly'), null), { type: 'subs', request: { apple: { sku: 'room_51_monthly', appAccountToken: identity.appAccountToken } } });
  assert.deepEqual(store.purchaseRequest(ios, product('extra_place'), null), { type: 'in-app', request: { apple: { sku: 'extra_place', appAccountToken: identity.appAccountToken } } });
  assert.deepEqual(store.purchaseRequest(android, product('room_101_week_pass'), null), { type: 'in-app', request: { google: { skus: ['room_101_week_pass'], obfuscatedAccountId: identity.obfuscatedAccountId, obfuscatedProfileId: identity.obfuscatedProfileId } } });
  const listed = { id: 'room_51_monthly', displayPrice: 'x', subscriptionOffers: [{ basePlanIdAndroid: 'monthly', offerTokenAndroid: 'offer-1' }] };
  assert.deepEqual(store.purchaseRequest(android, product('room_51_monthly'), listed).request.google.subscriptionOffers, [{ sku: 'room_51_monthly', offerToken: 'offer-1' }]);
  assert.throws(() => store.purchaseRequest(android, product('room_51_monthly'), { id: 'room_51_monthly', displayPrice: 'x' }), store.StorePurchaseRefused, 'no offer from Google, no purchase');
});

test('on Google, moving up to 101 people starts now, and moving down waits for the paid period to end', () => {
  const android = store.purchaseOptions(identity, 'android');
  const listed = (id) => ({ id, displayPrice: 'x', subscriptionOffers: [{ basePlanIdAndroid: 'monthly', offerTokenAndroid: `offer-${id}` }] });
  const up = store.purchaseRequest(android, product('room_101_monthly'), listed('room_101_monthly'), { productId: 'room_51_monthly', purchaseToken: 'old' }).request.google;
  assert.equal(up.purchaseToken, 'old');
  assert.deepEqual(up.subscriptionProductReplacementParams, { oldProductId: 'room_51_monthly', replacementMode: 'charge-prorated-price' });
  const down = store.purchaseRequest(android, product('room_51_monthly'), listed('room_51_monthly'), { productId: 'room_101_monthly', purchaseToken: 'old' }).request.google;
  assert.equal(down.subscriptionProductReplacementParams.replacementMode, 'deferred');
});

test('a purchase does not start without our values, and nothing reaches the store', async () => {
  const kit = fakeKit();
  await assert.rejects(store.startStorePurchase({ kit, identity: null, platform: 'ios', product: product('extra_photo'), listed: null }), store.StorePurchaseRefused);
  assert.equal(kit.calls.requests.length, 0);
  await store.startStorePurchase({ kit, identity, platform: 'ios', product: product('extra_photo'), listed: null });
  assert.equal(kit.calls.requests.length, 1);
});

test('a purchase is finished only on success or a final refusal, as details.retryable says', async () => {
  const apple = { id: 't1', productId: 'room_51_week_pass', purchaseToken: 'a.signed.jws', transactionId: '1' };
  const google = { id: 't2', productId: 'extra_place', purchaseToken: 'token', purchaseState: 'purchased' };

  let kit = fakeKit();
  let client = fakeClient(GRANTED);
  assert.equal((await store.settleStorePurchase({ kit, client, platform: 'ios', purchase: apple })).outcome, 'granted');
  assert.deepEqual(client.sent, [{ store: 'apple', body: { signedTransaction: apple.purchaseToken } }]);
  assert.equal(kit.calls.finished.length, 1, 'honoured: finished');
  assert.equal(kit.calls.finished[0].isConsumable, true, 'a pass can be bought again');

  kit = fakeKit();
  client = fakeClient({ ...GRANTED, productId: 'extra_place', kind: 'extra' });
  await store.settleStorePurchase({ kit, client, platform: 'android', purchase: google, momentId: 'm1' });
  assert.deepEqual(client.sent, [{ store: 'google', body: { productId: 'extra_place', purchaseToken: 'token', momentId: 'm1' } }], 'an extra names its moment');

  for (const [answer, platform, finished, outcome] of [
    [refusal('store_unavailable', true), 'ios', 0, 'kept'],
    [refusal('store_extra_needs_moment', true), 'android', 0, 'kept'],
    [refusal('offline'), 'ios', 0, 'kept'],
    [refusal('authentication_required'), 'android', 0, 'kept'],
    [refusal('store_purchase_other_account', false), 'ios', 1, 'refused'],
    // Google refunds what nobody acknowledged, so a purchase we can never honour is left for it to.
    [refusal('store_purchase_other_account', false), 'android', 0, 'refused'],
  ]) {
    kit = fakeKit();
    const settled = await store.settleStorePurchase({ kit, client: fakeClient(answer), platform, purchase: platform === 'ios' ? apple : google });
    assert.equal(settled.outcome, outcome, `${platform} ${answer.code}`);
    assert.equal(kit.calls.finished.length, finished, `${platform} ${answer.code}`);
  }

  kit = fakeKit();
  client = fakeClient(GRANTED);
  assert.equal((await store.settleStorePurchase({ kit, client, platform: 'android', purchase: { ...google, purchaseState: 'pending' } })).outcome, 'waiting');
  assert.equal(client.sent.length + kit.calls.finished.length, 0, 'a payment Google is waiting on is neither sent nor finished');
});

test('the first paid journey is offered the subscriptions, every other one the passes', () => {
  const here = randomUUID();
  const elsewhere = randomUUID();
  assert.deepEqual(products.roomOfferFor([], here), { shape: 'subscriptions', current: null, products: products.SUBSCRIPTION_IDS });
  const own = { productId: 'room_51_monthly', journeyValue: here.toUpperCase() };
  assert.deepEqual(products.roomOfferFor([own], here), { shape: 'subscriptions', current: own, products: products.SUBSCRIPTION_IDS }, 'its own subscription can change size');
  assert.deepEqual(products.roomOfferFor([{ productId: 'room_51_monthly', journeyValue: elsewhere }], here), { shape: 'passes', current: null, products: products.PASS_IDS }, 'a second subscription would move the first journey\'s room');
});

test('an extra place is offered only where the server counts it, once the free first place is used (#340)', () => {
  const on = { place: true };
  assert.deepEqual(products.extrasFor({}, on), []);
  assert.deepEqual(products.extrasFor({ locations: [{}] }, on), ['extra_place']);
  assert.deepEqual(products.extrasFor({ locations: [{}] }, { place: false }), [], 'the server does not count a paid place here');
  assert.deepEqual(products.extrasFor({ locations: [{}] }, undefined), [], 'a server that does not say is not asked to');
});

test('no extra photo is sold on the phone until it can add photos (#187)', async () => {
  assert.deepEqual(products.extrasFor({ locations: [{}, {}], images: [{}, {}] }, { place: true }), ['extra_place']);
  assert.doesNotMatch(products.EXTRAS_INTRO, /photo/i);
  const form = await readFile(join(mobile, 'app/moment.tsx'), 'utf8');
  assert.match(form, /offered=\{extrasFor\(\{ locations: before\.locations \}, journey\.state\.snapshot\.extras\)\}/, 'the moment asks the snapshot');
});

test('only store-purchase.ts starts or finishes a purchase, and only store-kit.ts loads the store library', async () => {
  const files = [...await walk(join(mobile, 'app')), ...await walk(join(mobile, 'src'))];
  for (const file of files) {
    const name = relative(root, file);
    const source = await readFile(file, 'utf8');
    if (name !== MODULE) assert.doesNotMatch(source, /\b(?:requestPurchase|finishTransaction)\b/, `${name} names a store purchase call; only ${MODULE} may`);
    if (name !== 'apps/mobile/src/billing/store-kit.ts') assert.doesNotMatch(source, /['"](?:expo-iap|react-native-iap)['"]/, `${name} imports the store library`);
  }
  const pkg = JSON.parse(await readFile(join(mobile, 'package.json'), 'utf8'));
  assert.match(pkg.dependencies['expo-iap'], /^\d+\.\d+\.\d+$/, 'pinned exactly, like every other dependency');
});

test('prices come from the store, and the words are people, room and rest', async () => {
  const sources = await Promise.all(['src/billing/store-products.ts', 'src/billing/store-provider.tsx', 'src/components/store-offers.tsx'].map((path) => readFile(join(mobile, path), 'utf8')));
  assert.match(sources[2], /const price = listed\?\.displayPrice;/, 'the price shown is the store\'s');
  for (const source of sources) {
    assert.doesNotMatch(source, /[$€£]\s?\d|\b\d+\.\d\d\b/, 'no price of ours');
    assert.doesNotMatch(source, /\bseats?\b|\blicen[cs]es?\b|\bslots?\b|\bremoved\b/i);
    assert.doesNotMatch(source, /kind="destructive"|destructive/, 'paying and waiting are not failures');
  }
  assert.match(products.STORE_SUBSCRIPTION_NOT_CANCELLED, /not cancelled by deleting your account\. Cancel it with Apple or Google/);
});

// The review of #340 (Oct 8, 2026).

test('a purchase waiting for approval, Ask to Buy or a pending Google payment, is not sent, and says so', async () => {
  for (const platform of ['ios', 'android']) {
    const kit = fakeKit();
    const client = fakeClient(GRANTED);
    const settled = await store.settleStorePurchase({ kit, client, platform, purchase: { id: 'w', productId: 'room_51_week_pass', purchaseToken: 't', purchaseState: 'pending' } });
    assert.equal(settled.outcome, 'waiting', platform);
    assert.equal(client.sent.length + kit.calls.finished.length, 0, platform);
  }
  assert.match(store.WAITING_MESSAGE, /waiting for approval/);
  assert.match(store.WAITING_MESSAGE, /nothing is charged until then/);
});

test('restore gives one answer, and counts only what it added', () => {
  const granted = (fresh) => ({ outcome: 'granted', result: { ...GRANTED, granted: fresh } });
  const refused = { outcome: 'refused', message: 'This purchase belongs to another Together Ledger account.', code: 'store_purchase_other_account' };
  const kept = { outcome: 'kept', message: store.KEPT_MESSAGE, code: 'store_unavailable' };
  assert.deepEqual(products.restoreAnswer([granted(false), refused], 'ios'), { kind: 'status', tone: 'problem', message: refused.message }, 'a refusal on its own, never then "nothing to restore"');
  assert.deepEqual(products.restoreAnswer([kept, null], 'android'), { kind: 'status', tone: 'caution', message: store.KEPT_MESSAGE });
  assert.match(products.restoreAnswer([granted(true), granted(false), granted(false)], 'ios').message, /One purchase was added/, 'an old pass already honoured is not restored');
  assert.match(products.restoreAnswer([granted(false), granted(false)], 'ios').message, /already in place/);
  assert.match(products.restoreAnswer([], 'android').message, /Checked with Google Play\. There was nothing to restore/);
});

test('a monthly subscription says its length, its price and how to cancel, and the Google base plan is "monthly"', async () => {
  assert.match(products.subscriptionTerms('£10.99', 'ios'), /^Length: 1 month\. £10\.99 each month, renewing automatically until you cancel it\. Cancel it with Apple at least 24 hours before it renews/);
  assert.match(products.subscriptionTerms(undefined, 'android'), /Cancel it with Google before it renews/);
  assert.equal(store.GOOGLE_BASE_PLAN_ID, 'monthly');
  assert.match(await readFile(join(root, 'docs/STORE_PURCHASES.md'), 'utf8'), /base plan, whose ID must be exactly \*\*`monthly`\*\*/);
});

test('the store connection lives with the account, listens before it connects, and sweeps on the way back', async () => {
  const provider = await readFile(join(mobile, 'src/billing/store-provider.tsx'), 'utf8');
  const connect = provider.slice(provider.indexOf('// Connect while someone is signed in.'));
  const effect = connect.slice(0, connect.indexOf('const identity = useCallback'));
  assert.ok(effect.indexOf('purchaseUpdatedListener(') < effect.indexOf('initConnection()'), 'the purchase listener is registered before the connection opens');
  assert.ok(effect.indexOf('purchaseErrorListener(') < effect.indexOf('initConnection()'), 'so is the error listener');
  assert.match(effect, /\}, \[userId, platform\]\);/, 'switching journeys never reconnects, clears what was started or re-sends purchases');
  assert.doesNotMatch(effect, /\bsettle\(|\breload\(|\bsweep\(/, 'it reaches settle, reload and sweep through refs');
  assert.match(effect, /AppState\.addEventListener\('change'[\s\S]*?state === 'active'[\s\S]*?sweepRef\.current\(kit\)/, 'a kept purchase is tried again when the app comes back');
  assert.match(provider, /getPendingTransactionsIOS\(\)/, 'an unfinished consumable on iOS is swept too');
  assert.match(provider, /DeferredPayment/, 'Ask to Buy is said as waiting for approval');
});

test('subscriptions are offered only once the store has said what this account holds', async () => {
  const provider = await readFile(join(mobile, 'src/billing/store-provider.tsx'), 'utf8');
  const offers = await readFile(join(mobile, 'src/components/store-offers.tsx'), 'utf8');
  assert.match(offers, /value === undefined \|\| !store\.heldReady \?/);
  assert.match(provider, /if \(info\?\.kind === 'subscription'\) refreshHeld\(kit\);/, 'held is read again once the purchase has arrived');
  assert.match(provider, /const buyRoom = useCallback\(\(journeyId: string, productId: RoomProductId, replacing: Replacing \| null = null\) => buy\(journeyId, productId, null, replacing\), \[buy\]\);/, 'not when the purchase flow returns');
});
