import { Platform } from 'react-native';
import type { StoreKit, StorePlatform } from './store-purchase';

/**
 * The App Store and Google Play, through expo-iap (StoreKit 2 on iOS, Play Billing on Android; an
 * Expo module, so it works with the New Architecture this app runs on). The only file that
 * imports it.
 *
 * It is loaded when first needed rather than at start-up, because a development build made before
 * the library was added has no native module for it, and importing it there would stop the app.
 * There, and on any platform without a store, this answers null and nothing can be bought.
 *
 * Purchases are started and finished only in src/billing/store-purchase.ts, which is handed this
 * module whole; nothing here calls either.
 */
export type ExpoIap = typeof import('expo-iap');

let loading: Promise<ExpoIap | null> | null = null;

export function storePlatform(): StorePlatform | null {
  return Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : null;
}

export function loadStoreKit(): Promise<ExpoIap | null> {
  if (!storePlatform()) return Promise.resolve(null);
  loading ??= import('expo-iap').then((module) => module, () => null);
  return loading;
}

/** The library as store-purchase.ts expects it. */
export function asStoreKit(iap: ExpoIap): StoreKit {
  return iap as unknown as StoreKit;
}
