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
 * verified person in the journey (decided on #269). There is no purchase screen yet; the store
 * purchase work (TL-P-05 onward, #267) calls this, and tests/mobile-store-purchase.test.js fails
 * if a store purchase is started anywhere else.
 *
 * Kept free of runtime imports so the tests can run it directly.
 */
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
