/**
 * The persistent status region's rules, ported from the web (src/app.js: STATUS_TONES,
 * showStatus, clearStatus). Kept free of React so the rules can be tested as they are.
 *
 * A confirmation may pass; a problem must not. Anything a person needs to read twice, act on,
 * or copy down stays on screen until they dismiss it. Tone is carried by a shape as well as a
 * colour, so the two kinds are told apart without it.
 */
export type StatusTone = 'caution' | 'problem';

export const STATUS_TONES: Readonly<Record<StatusTone, { glyph: string }>> = Object.freeze({
  caution: { glyph: '▲' },
  problem: { glyph: '■' },
});

/** `inDialog` records that the message was raised while a dialog was open, so it belongs to it. */
export type Status = { message: string; tone: StatusTone; source: string; inDialog: boolean } | null;

/**
 * Being offline, or the service being out of reach, loses nothing, so it is a caution (▲), never
 * the destructive colour (#300, #352). These are the account client's OFFLINE_MESSAGE,
 * UNREACHABLE_MESSAGE and UNAVAILABLE_MESSAGE (src/api/client.ts), repeated because this file has
 * no runtime imports; tests/mobile-shell.test.js holds the copies the same. The first is the
 * connection notice's own words (src/shell/connection.ts, OFFLINE_NOTICE). Every other message is
 * still a problem unless its caller says otherwise (#244 decides those).
 */
export const CONNECTION_MESSAGES: readonly string[] = Object.freeze([
  'You’re offline. A moment you hold now waits on this phone and is sent when you reconnect. Your journeys will be back then; until then, nothing else can be changed.',
  'Together Ledger can’t be reached right now. You’re still signed in. Try again in a moment.',
  'Private accounts are being connected. No account details were sent.',
]);

/**
 * Being offline is one notice, whoever noticed it (#352): a request that could not be sent says
 * it in the same words as the connection watch, and with the watch's source, so reconnecting
 * clears it and saying it twice changes nothing.
 */
export const OFFLINE_SOURCE = 'connection';

export function showStatus(message: string, { tone, source = 'action', inDialog = false }: { tone?: StatusTone; source?: string; inDialog?: boolean } = {}): Status {
  const chosen = tone ?? (CONNECTION_MESSAGES.includes(message) ? 'caution' : 'problem');
  const from = message === CONNECTION_MESSAGES[0] ? OFFLINE_SOURCE : source;
  return { message, tone: chosen in STATUS_TONES ? chosen : 'problem', source: from, inDialog };
}

/**
 * Reconnecting clears the offline notice, but never a problem the person has not read: with a
 * source, only a message from that source is cleared. Dismissing passes no source.
 */
export function clearStatus(current: Status, source?: string): Status {
  if (!current || (source && current.source !== source)) return current;
  return null;
}

/**
 * A problem belonging to a dialog leaves with it, so the next problem on the screen beneath is
 * not stranded inside something that is closed. One raised on the screen itself stays.
 */
export function closeDialog(current: Status): Status {
  return current?.inDialog ? null : current;
}
