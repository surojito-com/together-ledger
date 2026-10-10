import { randomUUID } from 'expo-crypto';
import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { accountMessage } from '../auth/account-messages';
import { useSession } from '../auth/session';
import { useShell } from '../shell/shell-provider';
import { waitingStore } from '../storage/phone-storage';
import { useJourney } from './use-journey';
import { sendWaiting, sentFromPhone, type WaitingMoment } from './waiting-moments';

type Held = { forAccount: string; moments: WaitingMoment[] };
type Drained = { sent: string[]; stopped: 'wait' | 'signed-out' | null };

/**
 * The moments waiting on this phone for the signed-in account (#352), and the one place that
 * sends them. Sending happens in turn: a second call while one is running asks it to go round
 * once more, so a moment held mid-send is never left behind and never sent twice at once.
 *
 * While the app was opened offline, the account is the one the phone last knew it was signed in
 * as, so what waits can be counted; nothing is sent until the service says who is signed in.
 */
function useWaitingLoader() {
  const session = useSession();
  const { client, refresh } = session;
  const { reload } = useJourney();
  const { showToast } = useShell();
  const signedInId = session.status === 'signed-in' ? session.user.id : null;
  const [offlineAccount, setOfflineAccount] = useState<string | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const accountId = signedInId ?? (session.status === 'offline' ? offlineAccount : null);

  // Only the account the service has confirmed ever sends.
  const sender = useRef<string | null>(null);
  useEffect(() => {
    sender.current = signedInId;
  }, [signedInId]);

  useEffect(() => {
    if (signedInId) waitingStore.rememberSignedIn(signedInId).catch(() => undefined);
    else if (session.status === 'signed-out') waitingStore.rememberSignedIn(null).catch(() => undefined);
    else if (session.status === 'offline') waitingStore.signedInAccount().then(setOfflineAccount, () => setOfflineAccount(null));
  }, [session.status, signedInId]);

  useEffect(() => {
    if (!accountId) return;
    let current = true;
    waitingStore.list(accountId).then((moments) => {
      if (current) setHeld({ forAccount: accountId, moments });
    }, () => undefined);
    return () => { current = false; };
  }, [accountId]);

  const running = useRef<Promise<Drained> | null>(null);
  const again = useRef(false);

  const drain = useCallback((): Promise<Drained> => {
    if (running.current) {
      again.current = true;
      return running.current;
    }
    const run = (async (): Promise<Drained> => {
      const sent: string[] = [];
      let stopped: Drained['stopped'] = null;
      do {
        again.current = false;
        const forAccount = sender.current;
        if (!forAccount) break;
        try {
          const result = await sendWaiting(forAccount, {
            store: waitingStore,
            send: (entry) => client.createMoment(entry.journeyId, entry.moment, entry.key).then(() => undefined),
            describe: accountMessage,
          });
          sent.push(...result.sent);
          stopped = result.stopped;
          setHeld({ forAccount, moments: await waitingStore.list(forAccount) });
        } catch {
          // The phone's storage could not be read or written. What it holds stays as it is.
          stopped = 'wait';
          break;
        }
        // The sign-in was refused: the session finds out and signs out; what waits stays.
        if (stopped === 'signed-out') {
          refresh();
          break;
        }
      } while (again.current);
      return { sent, stopped };
    })().finally(() => { running.current = null; });
    running.current = run;
    return run;
  }, [client, refresh]);

  /** Send what is waiting, and say so if anything went. */
  const sendNow = useCallback(async () => {
    const { sent } = await drain();
    if (sent.length) {
      await reload();
      showToast(sentFromPhone(sent.length));
    }
  }, [drain, reload, showToast]);

  // When the service confirms who is signed in: opening the app, signing in, the connection
  // returning after an offline start. Coming back online while already signed in is the
  // connection watch's call (app/_layout.tsx).
  const latestSendNow = useRef(sendNow);
  useEffect(() => {
    latestSendNow.current = sendNow;
  });
  useEffect(() => {
    if (signedInId) latestSendNow.current();
  }, [signedInId]);

  const moments = held && held.forAccount === accountId ? held.moments : [];

  return {
    /** What waits for this account, oldest first. */
    moments,
    /**
     * Hold a new moment. It is kept on the phone before it is first sent, then sent in turn after
     * anything already waiting. `sent` once the service has it; `waiting` when it could not be
     * reached. A refusal at once is thrown, and the moment is not kept: the form it came from
     * still holds every word, and says why, as it did before anything could wait.
     */
    async hold(journeyId: string, journeyName: string, moment: WaitingMoment['moment']): Promise<'sent' | 'waiting'> {
      const forAccount = sender.current;
      const key = randomUUID();
      const entry: WaitingMoment = { key, journeyId, journeyName, heldAt: new Date().toISOString(), moment, refusal: null };
      try {
        if (!forAccount) throw new Error('No confirmed account to keep it for.');
        setHeld({ forAccount, moments: await waitingStore.add(forAccount, entry) });
      } catch {
        // Nowhere to keep it: send it as before, and any failure stays in the form.
        await client.createMoment(journeyId, moment, key);
        return 'sent';
      }
      await drain();
      const after = await waitingStore.list(forAccount);
      const mine = after.find((waiting) => waiting.key === key);
      if (!mine) return 'sent';
      if (mine.refusal) {
        setHeld({ forAccount, moments: await waitingStore.remove(forAccount, key) });
        throw Object.assign(new Error(mine.refusal.message), { code: mine.refusal.code });
      }
      return 'waiting';
    },
    sendNow,
    /** A refused moment, sent again because the person asked (after making room, say). */
    async retry(key: string) {
      const forAccount = sender.current;
      if (!forAccount) return;
      setHeld({ forAccount, moments: await waitingStore.refuse(forAccount, key, null) });
      await sendNow();
    },
    /** Only ever after the person has read what discarding means. */
    async discard(key: string) {
      if (!accountId) return;
      setHeld({ forAccount: accountId, moments: await waitingStore.remove(accountId, key) });
    },
    /** Leaving a journey, after the person was told what waits for it (#96). */
    async leftJourney(journeyId: string) {
      if (!accountId) return;
      setHeld({ forAccount: accountId, moments: await waitingStore.removeJourney(accountId, journeyId) });
    },
    /** Signing out on purpose, or deleting the account, after the person was told what waits. */
    async clear() {
      if (!accountId) return;
      await waitingStore.clear(accountId);
      setHeld({ forAccount: accountId, moments: [] });
    },
  };
}

export type WaitingValue = ReturnType<typeof useWaitingLoader>;

const WaitingContext = createContext<WaitingValue | null>(null);

export function WaitingMomentsProvider({ children }: { children: ReactNode }) {
  return createElement(WaitingContext.Provider, { value: useWaitingLoader() }, children);
}

export function useWaitingMoments(): WaitingValue {
  const value = useContext(WaitingContext);
  if (!value) throw new Error('useWaitingMoments must be used inside WaitingMomentsProvider');
  return value;
}
