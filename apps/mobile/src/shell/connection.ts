/**
 * The standing offline notice (#300), in the web's place (src/app.js, reportConnection) but not
 * in its words. The web promises that anything needing the account service "will wait"; on the
 * phone nothing waits yet, so a moment held offline is refused and stays in its form (#352). The
 * notice says only what is true today. Kept free of runtime imports so it can be tested as it is.
 */
export const OFFLINE_NOTICE = 'You are offline. Until you reconnect, nothing can be held or changed in your journeys.';

/** Reconnecting clears only this source's message, never a problem the person has not read. */
export const CONNECTION_SOURCE = 'connection';

export type ConnectionChange = 'went-offline' | 'came-back' | null;

/**
 * What a new reading of the connection means, from the last one known. `null` is "not known
 * yet", which changes nothing. Coming back only counts after the phone was known to be offline,
 * so opening the app with a connection does not check the session a second time.
 */
export function connectionChange(before: boolean | null, now: boolean | null): ConnectionChange {
  if (now === null || now === before) return null;
  if (!now) return 'went-offline';
  return before === false ? 'came-back' : null;
}
