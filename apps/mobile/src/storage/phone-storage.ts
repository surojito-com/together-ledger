import { Storage } from 'expo-sqlite/kv-store';
import { createWaitingStore } from '../journey/waiting-moments';
import { createPhoneStore, type PhoneStorage } from './ledger-store';

/**
 * Where the phone keeps its own ledger and preferences: a key-value store in SQLite, inside the
 * app's sandbox. Unlike AsyncStorage on Android it has no 2 MB limit on reading one value,
 * which matters because the whole ledger is one value. The only file that touches it.
 *
 * Moments held without a connection wait here too, per account, until the service has them
 * (#352, src/journey/waiting-moments.ts).
 *
 * Sign-in tokens never come here; they stay in the keychain (src/auth/token-storage.ts).
 */
const phoneStorage: PhoneStorage = {
  getItem: (key) => Storage.getItemAsync(key),
  setItem: (key, value) => Storage.setItemAsync(key, value),
  removeItem: (key) => Storage.removeItemAsync(key).then(() => undefined),
};

export const phoneStore = createPhoneStore(phoneStorage);

export const waitingStore = createWaitingStore(phoneStorage);
