import { useCallback, useEffect, useState } from 'react';
import { getTheme } from '../theme/themes';
import { phoneStore } from './phone-storage';
import { SAVE_FAILED_MESSAGE, type PhoneStore } from './ledger-store';

export type StoredPreferences = { theme: string | null; onboardingComplete: boolean };

/** One failed write; the id lets the same message be raised again for a second failure. */
export type SaveFailure = { id: number; message: string } | null;

/**
 * What the phone remembers between launches (TL-M-10, #185): the chosen theme and whether the
 * ledger has been begun. Both are read once at launch; until then `stored` is null, so the first
 * screen is drawn with the saved theme rather than flashing the default.
 *
 * Nothing here throws. A store that cannot be read gives the defaults (a blocked store still
 * renders); a write that fails is handed back as `failure`, for the status region to say.
 */
export function useStoredPreferences(store: PhoneStore = phoneStore) {
  const [stored, setStored] = useState<StoredPreferences | null>(null);
  const [failure, setFailure] = useState<SaveFailure>(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      store.loadTheme((id) => getTheme(id).id),
      store.loadState().then((state) => state.preferences.onboardingComplete === true, () => false),
    ]).then(([theme, onboardingComplete]) => {
      if (live) setStored({ theme, onboardingComplete });
    });
    return () => { live = false; };
  }, [store]);

  const failed = useCallback(() => {
    setFailure((current) => ({ id: (current?.id ?? 0) + 1, message: SAVE_FAILED_MESSAGE }));
  }, []);

  const saveTheme = useCallback((themeId: string | null) => {
    store.saveTheme(themeId).catch(failed);
  }, [store, failed]);

  const completeOnboarding = useCallback(() => {
    store.completeOnboarding().catch(failed);
  }, [store, failed]);

  return { stored, failure, saveTheme, completeOnboarding };
}
