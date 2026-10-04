import * as SecureStore from 'expo-secure-store';
import type { Tokens, TokenStore } from '../api/client';

/**
 * Where the phone keeps its sign-in tokens: the platform keychain (iOS Keychain; Android
 * Keystore-backed encrypted storage, through expo-secure-store). Never AsyncStorage, never
 * plain preferences. THIS_DEVICE_ONLY keeps them out of backups restored onto another phone.
 */
const KEY = 'together-ledger.tokens';
const OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export const secureTokenStore: TokenStore = {
  async read() {
    const stored = await SecureStore.getItemAsync(KEY, OPTIONS);
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored) as Tokens;
      return parsed.token && parsed.refreshToken ? parsed : null;
    } catch {
      return null;
    }
  },
  async write(tokens) {
    await SecureStore.setItemAsync(KEY, JSON.stringify(tokens), OPTIONS);
  },
  async clear() {
    await SecureStore.deleteItemAsync(KEY, OPTIONS);
  },
};
