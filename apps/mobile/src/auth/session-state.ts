import type { AccountUser } from '../api/client';

/**
 * Who this phone is signed in as, as far as it can tell (#352). Kept free of React so the rules
 * can be tested as they are (tests/mobile-account.test.js).
 *
 * `offline` is not `signed-out`. The phone still holds its tokens; the service just could not be
 * asked (`offline`) or did not answer (`unreachable`). Only a refusal signs anyone out.
 */
export type OfflineReason = 'offline' | 'unreachable';

export type SessionState =
  | { status: 'loading'; user: null }
  | { status: 'signed-out'; user: null }
  | { status: 'offline'; user: null; reason: OfflineReason }
  | { status: 'signed-in'; user: AccountUser };

export function sessionAnswered(user: AccountUser | null): SessionState {
  return user ? { status: 'signed-in', user } : { status: 'signed-out', user: null };
}

/**
 * A check that failed. A refusal signs out. Anything else keeps whoever was signed in, and a
 * phone that had not yet heard back (opening the app without a connection) is offline, not signed
 * out: the account client only fails a check while it still holds tokens.
 */
export function sessionFailed(current: SessionState, error: unknown): SessionState {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'authentication_required') return { status: 'signed-out', user: null };
  if (current.status === 'signed-in') return current;
  return { status: 'offline', user: null, reason: code === 'offline' ? 'offline' : 'unreachable' };
}

/** What the phone says while it holds a sign-in it cannot check, short enough for Settings. */
export const STILL_SIGNED_IN: Readonly<Record<OfflineReason, string>> = Object.freeze({
  offline: 'This phone is offline. You’re still signed in.',
  unreachable: 'Private sync can’t be reached right now. You’re still signed in.',
});

/** The ledger in place of its journeys, which are not kept on the phone in v1 (#352, #360). */
export const LEDGER_WHILE_OFFLINE: Readonly<Record<OfflineReason, string>> = Object.freeze({
  offline: 'This phone is offline. You’re still signed in, and your journeys will be back here when it reconnects.',
  unreachable: 'Private sync can’t be reached right now. You’re still signed in on this phone. Try again in a moment.',
});

/** The account screen in place of the sign-in form, which this phone does not need. */
export const ACCOUNT_WHILE_OFFLINE: Readonly<Record<OfflineReason, string>> = Object.freeze({
  offline: 'This phone is offline. You’re still signed in, and your account will be here when it reconnects.',
  unreachable: 'Private sync can’t be reached right now. You’re still signed in on this phone. Try again in a moment.',
});
