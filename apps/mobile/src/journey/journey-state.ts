import type { OfflineReason } from '../auth/session-state';
import type { Journey, Snapshot } from './journey-view';

/**
 * What the phone holds of the signed-in person's journeys, and the rules for what a load that
 * fails leaves on screen (#352). Kept free of runtime imports so the rules can be tested as they
 * are (tests/mobile-offline.test.js).
 */
export type JourneyState =
  | { phase: 'signed-out' }
  /** Signed in on this phone, but the service could not be asked who (#352). No journey is kept on the phone in v1. */
  | { phase: 'offline'; reason: OfflineReason }
  | { phase: 'loading' }
  | { phase: 'no-journeys' }
  /**
   * A first load that failed. `reason` when the connection was lost or the service did not
   * answer, drawn as the offline phase is; otherwise the status region says why.
   */
  | { phase: 'failed'; reason: OfflineReason | null }
  /**
   * `next` is another journey asked for and not open yet: `opening` while it loads, `when-back`
   * once the connection was lost on the way. The open journey stays on screen meanwhile, its name
   * and its moments from the same snapshot, so no moment is ever shown under the wrong name.
   */
  | { phase: 'ready'; journeys: Journey[]; activeId: string; snapshot: Snapshot; next?: { journeyId: string; when: 'opening' | 'when-back' } | null };

/** A failure that is the connection, not an answer: the same two the session tells apart. */
export function connectionReason(error: unknown): OfflineReason | null {
  const code = (error as { code?: string } | null)?.code;
  return code === 'offline' || code === 'unreachable' ? code : null;
}

/** Another journey asked for: the open one stays until the other has loaded. */
export function opening(state: JourneyState, journeyId: string): JourneyState {
  if (state.phase !== 'ready') return state;
  if (journeyId === state.activeId) return state.next ? { ...state, next: null } : state;
  return { ...state, next: { journeyId, when: 'opening' } };
}

/**
 * What a load that failed leaves on screen. What is open stays open: a journey asked for while
 * the connection is lost opens once it is back, and any other failure is said in the status
 * region with the open journey still there. Only a first load that fails says so in its place.
 */
export function failedLoad(current: JourneyState | null, error: unknown): JourneyState {
  const reason = connectionReason(error);
  if (current?.phase === 'ready') {
    if (reason && current.next) return { ...current, next: { journeyId: current.next.journeyId, when: 'when-back' } };
    return current.next ? { ...current, next: null } : current;
  }
  return { phase: 'failed', reason };
}

/** The journey to ask for next: the one asked for, if any, else the open one. */
export function preferredJourney(state: JourneyState): string | null {
  return state.phase === 'ready' ? state.next?.journeyId ?? state.activeId : null;
}

/** The reason to draw a state as offline, if it is: opened offline, or a first load the connection stopped. */
export function offlineReason(state: JourneyState): OfflineReason | null {
  if (state.phase === 'offline') return state.reason;
  if (state.phase === 'failed') return state.reason;
  return null;
}

// The words, for the owner to approve (#352).

/** Under the journey choices, while another journey is asked for. */
export function nextJourneyWords(name: string, when: 'opening' | 'when-back') {
  return when === 'opening' ? `Opening “${name}”…` : `“${name}” opens once the connection is back.`;
}

/** History and Journey sharing, in place of the journey they need, while the phone is offline. */
export function opensWhenBack(screen: string) {
  return `${screen} opens once the connection is back.`;
}

/** A first load that failed for a reason other than the connection; the status region says why. */
export const JOURNEYS_NOT_LOADED = 'Your journeys couldn’t be loaded just now.';

/** History, signed in with no journey yet. */
export const HISTORY_WITHOUT_JOURNEY = 'Your account is ready. Create a private journey, and its history will be here.';
