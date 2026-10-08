/**
 * The one way the phone starts a store purchase (#269).
 *
 * Apple and Google sell to their own accounts. The only thing that ties a purchase back to a
 * Together Ledger account, and to the journey it was for, is a value of ours set when the purchase
 * starts: StoreKit's appAccountToken, and Play Billing's obfuscatedAccountId and
 * obfuscatedProfileId. Set later, or not at all, and a person is charged for something nobody can
 * honour. So every purchase is built here, and this refuses to build one without them.
 *
 * Nothing is bought while signed out: the values come from the service, for a signed-in,
 * verified person in the journey (decided on #269).
 *
 * This is also the only file that starts a purchase or tells a store one is finished
 * (startStorePurchase and settleStorePurchase below). The store library itself is passed in
 * (src/billing/store-kit.ts loads it), and tests/mobile-store-purchase.test.js fails if any other
 * phone file names those calls.
 *
 * Kept free of runtime imports so the tests can run it directly.
 */
import type { StoreProductInfo } from './store-products';

/**
 * The base plan each Google subscription is sold through. It is the ID set in Play Console when the
 * subscription is created (the Book, "Together Ledger store products", Play Console step A), it
 * can't be changed afterwards, and the phone buys only through it (docs/STORE_PURCHASES.md).
 */
export const GOOGLE_BASE_PLAN_ID = 'monthly';

export type StorePurchaseIdentity = {
  appAccountToken: string;
  obfuscatedAccountId: string;
  obfuscatedProfileId: string;
};

export type StorePlatform = 'ios' | 'android';

/** What StoreKit 2 is given, or what Play Billing's flow params are given. */
export type PurchaseOptions =
  | { platform: 'ios'; appAccountToken: string }
  | { platform: 'android'; obfuscatedAccountId: string; obfuscatedProfileId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class StorePurchaseRefused extends Error {
  code = 'store_identity_missing';
}

// Said if a purchase is ever about to start without its values. Nothing has been charged.
export const NOT_STARTED_MESSAGE = 'This purchase did not start, and nothing was charged. Try again in a moment.';

/**
 * The options a store purchase must carry. Throws, and so stops the purchase before anything is
 * charged, unless every value is a real UUID from the service.
 */
export function purchaseOptions(identity: StorePurchaseIdentity | null | undefined, platform: StorePlatform): PurchaseOptions {
  const { appAccountToken, obfuscatedAccountId, obfuscatedProfileId } = identity || ({} as Partial<StorePurchaseIdentity>);
  if (platform === 'ios') {
    if (!UUID.test(String(appAccountToken || ''))) throw new StorePurchaseRefused(NOT_STARTED_MESSAGE);
    return { platform, appAccountToken: String(appAccountToken).toLowerCase() };
  }
  if (platform === 'android') {
    if (!UUID.test(String(obfuscatedAccountId || '')) || !UUID.test(String(obfuscatedProfileId || ''))) throw new StorePurchaseRefused(NOT_STARTED_MESSAGE);
    return { platform, obfuscatedAccountId: String(obfuscatedAccountId), obfuscatedProfileId: String(obfuscatedProfileId) };
  }
  throw new StorePurchaseRefused(NOT_STARTED_MESSAGE);
}

// --- Starting a purchase --------------------------------------------------------------------


/** The part of a store's product the phone needs: its price as the store shows it, and, for a Google subscription, the offer to buy. */
export type ListedProduct = {
  id: string;
  displayPrice: string;
  subscriptionOffers?: { offerTokenAndroid?: string | null; basePlanIdAndroid?: string | null }[] | null;
};

/** A purchase as the store library reports it (expo-iap's Purchase), reduced to what is read here. */
export type StoreTransaction = {
  id: string;
  productId: string;
  /** Apple: the StoreKit 2 signed transaction (JWS). Google: the purchase token. */
  purchaseToken?: string | null;
  purchaseState?: string;
  transactionId?: string | null;
  appAccountToken?: string | null;
  obfuscatedProfileIdAndroid?: string | null;
  packageNameAndroid?: string | null;
};

/**
 * The calls this file makes on the store library. src/billing/store-kit.ts passes expo-iap
 * itself, so the names here are expo-iap's.
 */
export type StoreKit = {
  requestPurchase(args: unknown): Promise<unknown>;
  finishTransaction(args: { purchase: never; isConsumable?: boolean }): Promise<unknown>;
};

/** The subscription a Google upgrade or downgrade replaces. Apple needs nothing: both sizes are one group. */
export type Replacing = { productId: string; purchaseToken: string };

/**
 * Asks the store to begin a purchase, carrying our values. What the person decides comes back
 * through the store library's purchase listener, never from here (src/billing/store-provider.tsx).
 */
export async function startStorePurchase({ kit, identity, platform, product, listed, replacing = null }: {
  kit: StoreKit;
  identity: StorePurchaseIdentity | null | undefined;
  platform: StorePlatform;
  product: StoreProductInfo;
  listed: ListedProduct | null | undefined;
  replacing?: Replacing | null;
}) {
  const options = purchaseOptions(identity, platform);
  await kit.requestPurchase(purchaseRequest(options, product, listed, replacing));
}

/** Exactly what the store library is given for one purchase. Exported for the tests. */
export function purchaseRequest(options: PurchaseOptions, product: StoreProductInfo, listed: ListedProduct | null | undefined, replacing: Replacing | null = null) {
  const subscription = product.kind === 'subscription';
  const type = subscription ? 'subs' : 'in-app';
  if (options.platform === 'ios') {
    return { type, request: { apple: { sku: product.id, appAccountToken: options.appAccountToken } } };
  }
  const google: Record<string, unknown> = {
    skus: [product.id],
    obfuscatedAccountId: options.obfuscatedAccountId,
    obfuscatedProfileId: options.obfuscatedProfileId,
  };
  if (subscription) {
    // A Google subscription is bought through its base plan, GOOGLE_BASE_PLAN_ID ('monthly').
    const offer = (listed?.subscriptionOffers || []).find((entry) => entry.offerTokenAndroid && (!entry.basePlanIdAndroid || entry.basePlanIdAndroid === GOOGLE_BASE_PLAN_ID));
    if (!offer?.offerTokenAndroid) throw new StorePurchaseRefused(NOT_STARTED_MESSAGE);
    google.subscriptionOffers = [{ sku: product.id, offerToken: offer.offerTokenAndroid }];
    if (replacing && replacing.productId !== product.id) {
      // Moving up to 101 people starts now and charges the difference; moving down to 51 waits for
      // the end of the 101 period already paid for (docs/STORE_PURCHASES.md).
      google.purchaseToken = replacing.purchaseToken;
      google.subscriptionProductReplacementParams = {
        oldProductId: replacing.productId,
        replacementMode: (product.people || 0) > Number(/\d+/.exec(replacing.productId)?.[0] || 0) ? 'charge-prorated-price' : 'deferred',
      };
    }
  }
  return { type, request: { google } };
}

// --- When a purchase comes back -------------------------------------------------------------

/** What our server answers for a purchase it has honoured (docs/STORE_PURCHASES.md). */
export type GrantedPurchase = {
  purchaseId: string;
  granted: boolean;
  productId: string;
  kind: 'subscription' | 'pass' | 'extra';
  journeyId: string;
  room?: { people: number; state: string; from: string | null; until: string | null };
  extra?: { kind: 'photo' | 'place'; momentId: string };
};

export type StoreClient = {
  sendApplePurchase<R>(body: { signedTransaction: string; momentId?: string }): Promise<R>;
  sendGooglePurchase<R>(body: { productId: string; purchaseToken: string; momentId?: string }): Promise<R>;
};

export type Settled =
  /** Our server honoured it, and the store has been told it is finished. */
  | { outcome: 'granted'; result: GrantedPurchase }
  /** Not honoured yet, and worth sending again: it stays open with the store, which brings it back. */
  | { outcome: 'kept'; message: string; code: string }
  /** Waiting for approval (Ask to Buy, or a Google payment still pending). Nothing was sent. */
  | { outcome: 'waiting' }
  /** Our server refused it for good. Its message says where a refund comes from. */
  | { outcome: 'refused'; message: string; code: string };

export const KEPT_MESSAGE = 'Your purchase is safe with the store, and it will be added when Together Ledger can check it. Nothing more will be charged.';
// Ask to Buy on iOS, and a Google Play payment still pending: nothing is charged until it is approved.
export const WAITING_MESSAGE = 'This purchase is waiting for approval. It will be added once it\u2019s approved, and nothing is charged until then.';

/**
 * Sends one store purchase to our server, and finishes it with the store only as the answer says
 * (#272, docs/STORE_PURCHASES.md, "Refusals").
 *
 * - Honoured: finished. On Google the server has already acknowledged or consumed it; finishing
 *   here as well is harmless and covers a moment when Google could not be reached from the server.
 * - Refused with `retryable: true`, or no answer at all (offline, the service down, a refusal that
 *   does not say): kept. StoreKit redelivers an unfinished transaction on every launch, and Play
 *   returns an unacknowledged purchase, so it is sent again later.
 * - Refused with `retryable: false`: on Apple, finished, so it stops coming back; its message says
 *   where a refund comes from. On Google it is left unacknowledged, so Google refunds it by itself
 *   within three days rather than the phone accepting a payment nobody can honour.
 */
export async function settleStorePurchase({ kit, client, platform, purchase, momentId }: {
  kit: StoreKit;
  client: StoreClient;
  platform: StorePlatform;
  purchase: StoreTransaction;
  momentId?: string | null;
}): Promise<Settled> {
  if (purchase.purchaseState === 'pending') return { outcome: 'waiting' };
  const product = purchase.productId;
  const moment = momentId ? { momentId } : {};
  let result: GrantedPurchase;
  try {
    if (!purchase.purchaseToken) return { outcome: 'kept', message: KEPT_MESSAGE, code: 'store_transaction_incomplete' };
    result = platform === 'ios'
      ? await client.sendApplePurchase<GrantedPurchase>({ signedTransaction: purchase.purchaseToken, ...moment })
      : await client.sendGooglePurchase<GrantedPurchase>({ productId: product, purchaseToken: purchase.purchaseToken, ...moment });
  } catch (error) {
    const refusal = error as { code?: string; message?: string; details?: { retryable?: unknown } | null };
    const code = String(refusal?.code || 'request_failed');
    // Only a refusal that says it will never change is final. Anything else is kept.
    if (refusal?.details?.retryable !== false) return { outcome: 'kept', message: refusal?.details?.retryable === true && refusal.message ? refusal.message : KEPT_MESSAGE, code };
    if (platform === 'ios') await finish(kit, purchase, product);
    return { outcome: 'refused', message: refusal.message || KEPT_MESSAGE, code };
  }
  await finish(kit, purchase, product);
  return { outcome: 'granted', result };
}

async function finish(kit: StoreKit, purchase: StoreTransaction, productId: string) {
  // A pass or an extra can be bought again, so it is consumed; a subscription is acknowledged.
  const isConsumable = !productId.endsWith('_monthly');
  try {
    await kit.finishTransaction({ purchase: purchase as never, isConsumable });
  } catch {
    // On Google the server may already have consumed or acknowledged it, which the store then
    // reports as an error here. What matters, that our server honoured it, has already happened.
  }
}
