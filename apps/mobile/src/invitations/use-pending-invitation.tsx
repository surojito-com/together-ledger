import * as SecureStore from 'expo-secure-store';
import { router, usePathname, useRootNavigationState } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSession } from '../auth/session';
import { INVITATION_PATH } from './invitation-link';
import { bringBack, createPendingInvitationStore } from './pending-invitation';

// The keychain, as the sign-in tokens are kept: this phone only, never in a backup (#258).
const OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const store = createPendingInvitationStore({
  getItem: (key) => SecureStore.getItemAsync(key, OPTIONS),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, OPTIONS),
  removeItem: (key) => SecureStore.deleteItemAsync(key, OPTIONS),
});

type PendingValue = {
  /** False until the keychain has been read once. */
  loaded: boolean;
  code: string | null;
  keep: (code: string) => Promise<void>;
  forget: () => Promise<void>;
};

const PendingContext = createContext<PendingValue | null>(null);

/** The invitation this phone holds until it is answered (src/invitations/pending-invitation.ts). */
export function PendingInvitationProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    store.read().then((pending) => {
      if (!active) return;
      // A link that arrived while the keychain was still being read is newer than what it held.
      setCode((current) => current ?? pending?.code ?? null);
      setLoaded(true);
    });
    return () => { active = false; };
  }, []);

  // Held for this run straight away; a keychain that can't be written still leaves it here.
  const keep = useCallback(async (next: string) => {
    setCode(next);
    await store.keep(next).catch(() => undefined);
  }, []);
  const forget = useCallback(async () => {
    setCode(null);
    await store.forget().catch(() => undefined);
  }, []);

  const value = useMemo(() => ({ loaded, code, keep, forget }), [loaded, code, keep, forget]);
  return <PendingContext.Provider value={value}>{children}</PendingContext.Provider>;
}

export function usePendingInvitation(): PendingValue {
  const value = useContext(PendingContext);
  if (!value) throw new Error('usePendingInvitation must be used inside PendingInvitationProvider');
  return value;
}

/**
 * Someone who tapped an invitation, then signed in or created an account (with a password, Google
 * or Apple), lands back on the invitation rather than on an empty ledger (#266). Once for each
 * account that signs in, so leaving the invitation without answering is not undone at every turn.
 */
export function PendingInvitationWatch() {
  const session = useSession();
  const pending = usePendingInvitation();
  const pathname = usePathname();
  const navigation = useRootNavigationState();
  const userId = session.status === 'signed-in' ? session.user.id : null;
  const broughtBackFor = useRef<string | null>(null);

  useEffect(() => {
    const next = bringBack({
      status: session.status,
      userId,
      loaded: pending.loaded,
      code: pending.code,
      broughtBackFor: broughtBackFor.current,
      onInvitation: pathname === INVITATION_PATH,
      invitationInStack: Boolean(navigation?.routes?.some((route) => route.name === 'invite')),
    });
    broughtBackFor.current = next.broughtBackFor;
    // Back to the invitation they signed in from, or onto it if they never saw it here.
    if (next.go === 'back-to-it') router.dismissTo(INVITATION_PATH);
    if (next.go === 'onto-it') router.push(INVITATION_PATH);
  }, [session.status, userId, pending.loaded, pending.code, pathname, navigation]);

  return null;
}
