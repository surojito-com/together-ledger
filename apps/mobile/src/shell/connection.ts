/**
 * The standing offline notice (#300), in the web's place (src/app.js, reportConnection) but not
 * in its words. On the phone, holding a new moment is the one thing that waits: it is kept on the
 * phone and sent once the connection returns (#352). Changing anything else still needs the
 * connection. The notice says only that. Kept free of runtime imports so it can be tested as it is.
 */
export const OFFLINE_NOTICE = 'You’re offline. A moment you hold now waits on this phone and is sent when you reconnect. Your journeys will be back then; until then, nothing else can be changed.';

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
