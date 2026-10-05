import { createPhoneLedgerStore } from '../../../../src/store.js';

/**
 * The phone's own ledger, kept on the phone (TL-M-10, #185). The load chain is the web's, from
 * src/store.js: the same migrations from every earlier schema, the same fallback through the
 * three storage keys, and the same validity gate before every write. Only the storage beneath
 * it differs, and it answers with promises.
 *
 * Imports nothing native, so tests/mobile-store.test.js runs it against the browser's store.
 */
export type PhoneStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

/** The web's key for a chosen theme (src/themes.js), so a choice reads the same everywhere. */
export const THEME_KEY = 'theme';

/** Said in the status region when a change could not be written; it is not a crash. */
export const SAVE_FAILED_MESSAGE = 'This phone could not save that change. It shows for now, but may not be here the next time the app opens.';

export function createPhoneStore(storage: PhoneStorage) {
  const ledger = createPhoneLedgerStore(storage);
  return {
    ...ledger,

    /**
     * The saved theme, settled the way src/themes.js settles it: a retired id lands on its
     * survivor and the survivor is saved once, so the retired name is not carried forward.
     * Null when nothing is saved, or the store cannot be read: the phone's preference decides.
     */
    async loadTheme(resolve: (id: string) => string): Promise<string | null> {
      let saved: string | null;
      try {
        saved = await storage.getItem(THEME_KEY);
      } catch {
        return null;
      }
      if (!saved) return null;
      const applied = resolve(saved);
      if (applied !== saved) {
        try { await storage.setItem(THEME_KEY, applied); } catch { /* a blocked store still renders */ }
      }
      return applied;
    },

    /** Null goes back to following the phone. */
    saveTheme(themeId: string | null): Promise<void> {
      return themeId ? storage.setItem(THEME_KEY, themeId) : storage.removeItem(THEME_KEY);
    },

    /** Begin the ledger, as the web's showLedgerSurface({ persist: true }) does. */
    async completeOnboarding(): Promise<void> {
      const state = await ledger.loadState();
      if (state.preferences.onboardingComplete) return;
      state.preferences.onboardingComplete = true;
      await ledger.saveState(state);
    },
  };
}

export type PhoneStore = ReturnType<typeof createPhoneStore>;
