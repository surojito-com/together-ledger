import { useFocusEffect } from 'expo-router';
import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { accountMessage } from '../auth/account-messages';
import { useSession } from '../auth/session';
import { CONNECTION_SOURCE } from '../shell/connection';
import { useShell } from '../shell/shell-provider';
import { failedLoad, opening, preferredJourney, type JourneyState } from './journey-state';
import { chooseJourney, type Journey, type Snapshot } from './journey-view';

export type { JourneyState } from './journey-state';

type Held = { forUser: string; state: JourneyState };

/**
 * Loads the signed-in person's journeys and the open one's snapshot, the way the web's
 * refreshCloudState() does (TL-M-07, #182). What is held belongs to one account: it is keyed by
 * who loaded it, so after signing out or switching account nothing of the last one is shown.
 *
 * It is held once, above every screen, so the ledger and the moment form (#183) read and
 * refresh the same journey.
 */
function useJourneyLoader() {
  const session = useSession();
  const shell = useShell();
  const { client, setUser } = session;
  const { showStatus, clearStatus, showToast } = shell;
  const userId = session.status === 'signed-in' ? session.user.id : null;
  const [held, setHeld] = useState<Held | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);

  // Fetching and applying are kept apart, as the session provider keeps them: the fetch touches
  // no state, and only its answer does, so nothing is set while an effect is still running.
  const fetchState = useCallback(async (preferredId: string | null): Promise<JourneyState> => {
    const journeys = await client.journeys<Journey>();
    const activeId = chooseJourney(journeys, preferredId);
    if (!activeId) return { phase: 'no-journeys' };
    return { phase: 'ready', journeys, activeId, snapshot: await client.snapshot<Snapshot>(activeId) };
  }, [client]);

  const load = useCallback((forUser: string, preferredId: string | null, { announce = false } = {}) => {
    const attempt = ++latest.current;
    return fetchState(preferredId).then((next) => {
      if (attempt !== latest.current) return;
      setHeld({ forUser, state: next });
      clearStatus('journey');
      // An answer proves the connection, even where the phone never said it was back.
      clearStatus(CONNECTION_SOURCE);
      if (announce && next.phase === 'ready') showToast('Private journeys refreshed.');
    }, (error) => {
      if (attempt !== latest.current) return;
      if ((error as { code?: string }).code === 'authentication_required') setUser(null);
      // Offline, these are the connection notice's own words, and take its place (src/shell/status.ts).
      showStatus(accountMessage(error), { source: 'journey' });
      // What is open stays open, and a journey asked for offline opens once the connection is
      // back (#352); only a first load that fails says so in its place (src/journey/journey-state.ts).
      setHeld((current) => ({ forUser, state: failedLoad(current?.forUser === forUser ? current.state : null, error) }));
    });
  }, [fetchState, setUser, showStatus, clearStatus, showToast]);

  useEffect(() => {
    if (userId) load(userId, null);
  }, [userId, load]);

  const state: JourneyState = session.status === 'loading'
    ? { phase: 'loading' }
    : session.status === 'offline'
      ? { phase: 'offline', reason: session.reason }
      : !userId
        ? { phase: 'signed-out' }
        : held?.forUser === userId ? held.state : { phase: 'loading' };

  const activeId = state.phase === 'ready' ? state.activeId : null;
  // Re-reading opens the journey asked for while offline, once the connection lets it.
  const preferredId = preferredJourney(state);
  const reload = useCallback(async () => {
    if (userId) await load(userId, preferredId);
  }, [userId, preferredId, load]);

  return {
    state,
    refreshing,
    /** Pull to refresh: re-read the journeys and the open journey's snapshot. */
    refresh: async () => {
      if (!userId) return;
      setRefreshing(true);
      try {
        await load(userId, preferredId, { announce: true });
      } finally {
        setRefreshing(false);
      }
    },
    /**
     * Opening another journey keeps this one on screen until the other has loaded, and offline
     * says it opens once the connection is back (#352). Name and moments come from one snapshot,
     * so no moment is ever shown under the wrong name. Choosing the open one again stays there.
     */
    select: (journeyId: string) => {
      if (!userId) return;
      setHeld((current) => (current?.forUser === userId ? { forUser: userId, state: opening(current.state, journeyId) } : current));
      // Choosing the open one again while another loads re-reads it, so the other's answer is dropped.
      if (journeyId !== activeId || (state.phase === 'ready' && state.next)) load(userId, journeyId);
    },
    /** Open a journey this phone just began. It works from an empty start too, where nothing is open yet. */
    open: async (journeyId: string) => {
      if (userId) await load(userId, journeyId);
    },
    retry: () => {
      if (userId) load(userId, preferredId);
    },
    /** Re-read quietly after a change this phone made, such as holding a moment. */
    reload,
  };
}

export type JourneyValue = ReturnType<typeof useJourneyLoader>;

const JourneyContext = createContext<JourneyValue | null>(null);

export function JourneyProvider({ children }: { children: ReactNode }) {
  return createElement(JourneyContext.Provider, { value: useJourneyLoader() }, children);
}

export function useJourney(): JourneyValue {
  const value = useContext(JourneyContext);
  if (!value) throw new Error('useJourney must be used inside JourneyProvider');
  return value;
}

/**
 * Re-read quietly each time a screen comes into view. What other journeyers did since (a
 * proposal to answer, a conversation started) is otherwise only seen after a pull on the
 * ledger, and a question about someone's access should never be answered from a stale view.
 */
export function useReloadWhenShown() {
  const { reload } = useJourney();
  useFocusEffect(useCallback(() => {
    reload();
  }, [reload]));
}
