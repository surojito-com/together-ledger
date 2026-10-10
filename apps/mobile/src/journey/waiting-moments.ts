import type { PhoneStorage } from '../storage/ledger-store';

/**
 * Moments held on this phone that the service does not have yet (#352, the owner's Oct 8
 * decision). A moment held without a connection, or whose send could not reach the service,
 * waits here and sends itself once the connection returns or the app opens.
 *
 * Each one carries a key chosen on this phone. The server remembers which moment a key made, for
 * this person in this journey only, so a moment sent again after a reply that never arrived is
 * the same moment, never a second one (server/platform.js, holdMoment).
 *
 * Kept in the phone's own storage (src/storage/phone-storage.ts), never the keychain, and per
 * account: each account's waiting moments are kept under its own id and only ever read for it.
 * Signing out on purpose asks before they are cleared; a sign-in that ends by itself keeps them
 * for when the same account signs in again.
 *
 * Kept free of runtime imports so the rules can be tested as they are (tests/mobile-waiting.test.js).
 */

/** What the service said no to, kept with the moment until the person acts on it. */
export type Refusal = { code: string; message: string };

export type WaitingMoment = {
  /** Chosen on this phone, sent with the moment, and the same every time it is sent. */
  key: string;
  journeyId: string;
  /** The journey's name when the moment was held, so it can be shown while that journey is not open. */
  journeyName: string;
  heldAt: string;
  /** Exactly what is sent: the form's payload (src/journey/moment-draft.ts, payloadFrom). */
  moment: { title: string; visibility: string; kind: string; kindLabel?: string; occurredOn: string } & Record<string, unknown>;
  refusal: Refusal | null;
};

const PREFIX = 'together-ledger.waiting-moments.';

/**
 * Which account this phone's sign-in belongs to, the last time the service said. An app opened
 * without a connection cannot ask, and still needs to say what is waiting for that account, and
 * for nobody else's. Cleared whenever the phone is signed out.
 */
export const SIGNED_IN_ACCOUNT_KEY = 'together-ledger.signed-in-account';

export function waitingKeyFor(accountId: string) {
  return `${PREFIX}${accountId}`;
}

function wellFormed(entry: unknown): entry is WaitingMoment {
  const value = entry as WaitingMoment | null;
  return Boolean(value && typeof value.key === 'string' && typeof value.journeyId === 'string'
    && value.moment && typeof value.moment === 'object' && typeof value.moment.title === 'string');
}

/**
 * The waiting moments, one list per account. Every change reads, changes and writes the list in
 * turn, never two at once, so two sends finishing together cannot lose each other's change.
 */
export function createWaitingStore(storage: PhoneStorage) {
  let queue: Promise<unknown> = Promise.resolve();
  function inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }

  async function read(accountId: string): Promise<WaitingMoment[]> {
    const stored = await storage.getItem(waitingKeyFor(accountId));
    if (!stored) return [];
    try {
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed.filter(wellFormed).map((entry) => ({ ...entry, refusal: entry.refusal ?? null })) : [];
    } catch {
      return [];
    }
  }

  async function write(accountId: string, list: WaitingMoment[]) {
    if (list.length) await storage.setItem(waitingKeyFor(accountId), JSON.stringify(list));
    else await storage.removeItem(waitingKeyFor(accountId));
    return list;
  }

  function change(accountId: string, apply: (list: WaitingMoment[]) => WaitingMoment[]) {
    return inTurn(async () => write(accountId, apply(await read(accountId))));
  }

  return {
    list: (accountId: string) => inTurn(() => read(accountId)),
    /** Kept before it is first sent, so closing the app mid-send loses nothing. */
    add: (accountId: string, entry: WaitingMoment) => change(accountId, (list) => (list.some((held) => held.key === entry.key) ? list : [...list, entry])),
    refuse: (accountId: string, key: string, refusal: Refusal | null) => change(accountId, (list) => list.map((held) => (held.key === key ? { ...held, refusal } : held))),
    remove: (accountId: string, key: string) => change(accountId, (list) => list.filter((held) => held.key !== key)),
    /** Leaving a journey (#96): what waits for it can never be sent, and the person was told so first. */
    removeJourney: (accountId: string, journeyId: string) => change(accountId, (list) => list.filter((held) => held.journeyId !== journeyId)),
    clear: (accountId: string) => inTurn(() => write(accountId, [])),
    rememberSignedIn: (accountId: string | null) => inTurn(() => (accountId ? storage.setItem(SIGNED_IN_ACCOUNT_KEY, accountId) : storage.removeItem(SIGNED_IN_ACCOUNT_KEY))),
    signedInAccount: () => inTurn(() => storage.getItem(SIGNED_IN_ACCOUNT_KEY)),
  };
}

export type WaitingStore = ReturnType<typeof createWaitingStore>;

/**
 * What a failed send means for a waiting moment.
 * - `wait`: the service could not be reached, or could not answer (no connection, a 5xx, a 429).
 *   It stays waiting, and nothing after it is sent until the connection returns: they go in order.
 * - `signed-out`: the sign-in was refused. It stays, for when the same account signs in again.
 * - `refused`: the service answered no (a conflict, needing room or an add-on, a validation
 *   error). It stays, with the service's words, until the person tries again or discards it.
 */
export function sendOutcome(error: unknown): 'wait' | 'signed-out' | 'refused' {
  const { code, status } = (error ?? {}) as { code?: string; status?: number };
  if (code === 'authentication_required') return 'signed-out';
  if (code === 'offline' || code === 'unreachable' || code === 'accounts_unavailable') return 'wait';
  if (!status || status >= 500 || status === 429 || status === 408) return 'wait';
  return 'refused';
}

/**
 * Send what is waiting for one account, oldest first. A refused moment is left for the person and
 * the next one is sent; anything that means the service is out of reach stops, and the rest wait.
 */
export async function sendWaiting(accountId: string, { store, send, describe }: {
  store: WaitingStore;
  send: (entry: WaitingMoment) => Promise<void>;
  /** The words a refusal is kept with: the phone's own (src/auth/account-messages.ts). */
  describe: (error: unknown) => string;
}): Promise<{ sent: string[]; stopped: 'wait' | 'signed-out' | null }> {
  const sent: string[] = [];
  for (const entry of await store.list(accountId)) {
    if (entry.refusal) continue;
    try {
      await send(entry);
    } catch (error) {
      const outcome = sendOutcome(error);
      if (outcome !== 'refused') return { sent, stopped: outcome };
      await store.refuse(accountId, entry.key, { code: (error as { code?: string }).code || 'refused', message: describe(error) });
      continue;
    }
    await store.remove(accountId, entry.key);
    sent.push(entry.key);
  }
  return { sent, stopped: null };
}

// The words, for the owner to approve (#352).

export const WAITING_TITLE = 'Waiting to send';
export const WAITING_HELP = 'Kept on this phone until the service has them, and sent in the order you held them. Nobody else sees them before then.';
export const WAITING_CUE = { glyph: '▲', waiting: 'Waiting to send', refused: 'Not sent' } as const;
export const SEND_NOW_LABEL = 'Try sending now';
export const TRY_AGAIN_LABEL = 'Try again';
export const DISCARD_LABEL = 'Discard';

/** What happens once it is sent. It is never shown as shared before the service has it. */
export function onceSent(visibility: string) {
  if (visibility === 'shared-now') return 'Once it’s sent, everyone in this journey will see it.';
  if (visibility === 'share-later') return 'Once it’s sent, it stays with you until you share it.';
  return 'Once it’s sent, it stays with you.';
}

export function inJourney(name: string) {
  return `In ${name}`;
}

/** The toast when a moment is held without reaching the service. */
export const KEPT_ON_PHONE = 'Kept on this phone. It will be sent when the connection returns.';

export function sentFromPhone(n: number) {
  return n === 1 ? 'Your waiting moment was sent.' : `${n} waiting moments were sent.`;
}

/** The ledger while the app was opened offline, in place of the journeys it cannot show (#360). */
export function waitingWhileOffline(n: number) {
  return n === 1
    ? 'One moment you held is waiting on this phone. It will be sent when the connection returns.'
    : `${n} moments you held are waiting on this phone. They will be sent when the connection returns.`;
}

export function discardConsequence(entry: WaitingMoment) {
  return {
    title: 'Discard this moment?',
    consequence: `“${entry.moment.title}” was never sent. Discarding removes it from this phone, and it can’t be brought back.`,
    confirmLabel: 'Discard moment',
    destructive: true,
  };
}

/** Signing out on purpose, with moments still waiting: said, and asked, before they are cleared. */
export function signOutConsequence(n: number) {
  return {
    title: 'Sign out with moments waiting?',
    consequence: n === 1
      ? 'One moment you held hasn’t been sent yet. Signing out removes it from this phone, and it can’t be sent later.'
      : `${n} moments you held haven’t been sent yet. Signing out removes them from this phone, and they can’t be sent later.`,
    confirmLabel: n === 1 ? 'Sign out and remove it' : 'Sign out and remove them',
    destructive: true,
  };
}

/** Every device, this one included, signs in again (#194); in the web's words (src/app.js). */
export const SIGN_OUT_EVERYWHERE_CONSEQUENCE = 'Every device signed in to this account, this one included, will need to sign in again. Nothing in your journeys is deleted.';

/**
 * Signing out everywhere, said and asked as signing out is (#194). Moments still waiting on this
 * phone are named in signing out's own words, and then the act is the one that cannot be undone.
 */
export function signOutEverywhereConsequence(n: number) {
  if (!n) return { title: 'Sign out everywhere?', consequence: SIGN_OUT_EVERYWHERE_CONSEQUENCE, confirmLabel: 'Sign out everywhere', destructive: false };
  return {
    title: 'Sign out everywhere with moments waiting?',
    consequence: `${SIGN_OUT_EVERYWHERE_CONSEQUENCE} ${signOutConsequence(n).consequence}`,
    confirmLabel: n === 1 ? 'Sign out everywhere and remove it' : 'Sign out everywhere and remove them',
    destructive: true,
  };
}

/** Added to leaving's consequence when something held for that journey is still waiting (#96). */
export function unsentWhenLeaving(n: number) {
  if (!n) return '';
  return n === 1
    ? 'One moment you held for this journey hasn’t been sent yet. Leaving removes it from this phone, and it can’t be sent later.'
    : `${n} moments you held for this journey haven’t been sent yet. Leaving removes them from this phone, and they can’t be sent later.`;
}

/** Added to the deletion's last question when something is still waiting: it can never be sent. */
export function removedWithAccount(n: number) {
  if (!n) return '';
  return n === 1
    ? 'One moment waiting on this phone was never sent, and is removed too.'
    : `${n} moments waiting on this phone were never sent, and are removed too.`;
}
