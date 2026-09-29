import * as SecureStore from 'expo-secure-store';

/**
 * Stub for the auth token storage that #179 (bearer auth) and #180 (auth
 * screens) will build on. No tokens exist yet — this only fixes where they
 * go once they do: the platform keychain (iOS Keychain via
 * `expo-secure-store`, EncryptedSharedPreferences on Android), never
 * `AsyncStorage`, `UserDefaults`, or plain `SharedPreferences`.
 */
const ACCESS_TOKEN_KEY = 'together-ledger.access-token';

export async function getStoredAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
}

export async function setStoredAccessToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, token);
}

export async function clearStoredAccessToken(): Promise<void> {
  await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
}
