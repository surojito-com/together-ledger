import * as SecureStore from 'expo-secure-store';
import type { KeptAppleName, KeptAppleNameStore } from './social-sign-in';

/**
 * Where the name from Apple's first authorization waits until our server has it (#217,
 * src/auth/social-sign-in.ts): the keychain, beside the sign-in tokens and on the same terms,
 * never plain storage, and never restored onto another phone. Cleared as soon as a sign-in with
 * Apple succeeds.
 */
const KEY = 'together-ledger.apple-first-authorization';
const OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export const keptAppleName: KeptAppleNameStore = {
  async read() {
    const stored = await SecureStore.getItemAsync(KEY, OPTIONS);
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored) as KeptAppleName;
      return typeof parsed.user === 'string' && typeof parsed.displayName === 'string' ? parsed : null;
    } catch {
      return null;
    }
  },
  async write(kept) {
    await SecureStore.setItemAsync(KEY, JSON.stringify(kept), OPTIONS);
  },
  async clear() {
    await SecureStore.deleteItemAsync(KEY, OPTIONS);
  },
};
