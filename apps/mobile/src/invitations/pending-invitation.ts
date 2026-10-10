/**
 * An invitation this phone was given and has not answered yet (#266). It survives signing in,
 * creating an account and verifying an email, so whoever tapped the link lands on the invitation
 * afterwards rather than on an empty ledger. It is kept on this phone only, in the keychain beside
 * the sign-in tokens (out of every backup, src/auth/token-storage.ts), and forgotten once it is
 * used, refused, or can no longer be used. Kept free of runtime imports so the tests can run it
 * directly (tests/mobile-invitation.test.js).
 */
export type KeyValue = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export const PENDING_INVITATION_KEY = 'together-ledger.pending-invitation';

export type PendingInvitation = { code: string; keptAt: string };

export function createPendingInvitationStore(storage: KeyValue, now: () => Date = () => new Date()) {
  return {
    async read(): Promise<PendingInvitation | null> {
      let stored: string | null;
      try {
        stored = await storage.getItem(PENDING_INVITATION_KEY);
      } catch {
        return null;
      }
      if (!stored) return null;
      try {
        const parsed = JSON.parse(stored) as Partial<PendingInvitation>;
        return typeof parsed.code === 'string' && parsed.code ? { code: parsed.code, keptAt: String(parsed.keptAt ?? '') } : null;
      } catch {
        return null;
      }
    },
    /** A newer invitation replaces an older one: the phone holds one at a time. */
    async keep(code: string): Promise<PendingInvitation> {
      const pending = { code, keptAt: now().toISOString() };
      await storage.setItem(PENDING_INVITATION_KEY, JSON.stringify(pending));
      return pending;
    },
    async forget(): Promise<void> {
      await storage.removeItem(PENDING_INVITATION_KEY);
    },
  };
}

export type PendingInvitationStore = ReturnType<typeof createPendingInvitationStore>;

/**
 * Whether to bring someone back to the invitation they hold (src/invitations/use-pending-invitation.tsx).
 * Once for each account that signs in, by any means (a password, a new account, Google or Apple),
 * so leaving the invitation without answering is not undone at every turn. `broughtBackFor` is
 * the account it last did this for, cleared when the phone is signed out.
 */
export function bringBack({ status, userId, loaded, code, broughtBackFor, onInvitation, invitationInStack }: {
  status: 'loading' | 'signed-out' | 'offline' | 'signed-in';
  userId: string | null;
  loaded: boolean;
  code: string | null;
  broughtBackFor: string | null;
  onInvitation: boolean;
  invitationInStack: boolean;
}): { go: 'stay' | 'back-to-it' | 'onto-it'; broughtBackFor: string | null } {
  const remembered = status === 'signed-out' ? null : broughtBackFor;
  if (!userId || !loaded || !code || remembered === userId) return { go: 'stay', broughtBackFor: remembered };
  if (onInvitation) return { go: 'stay', broughtBackFor: userId };
  return { go: invitationInStack ? 'back-to-it' : 'onto-it', broughtBackFor: userId };
}
