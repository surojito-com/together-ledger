/**
 * Reading an invitation's code from what the phone is given (#266): a link tapped in an email or a
 * message, or text pasted into "Have an invitation?". Kept free of runtime imports so the tests can
 * run it directly (tests/mobile-invitation.test.js).
 *
 * An invitation link is https://app.together-ledger.com/invite#invite=<code>. Older links carry the
 * code after the # at / (#261), or in the query (?invite=), and an invitation lasts 14 days, so
 * every shape is still read. The code itself is base64url, so someone can also paste just that.
 */
export const INVITATION_PATH = '/invite';

/** What pasted text turned out to be. */
export type PastedInvitation =
  | { code: string }
  | { problem: 'empty' | 'not-an-invitation' | 'verification-link' | 'recovery-link' };

// A code is 43 characters of base64url from the server; this allows a little either side.
const BARE_CODE = /^[A-Za-z0-9_-]{16,200}$/;
// Characters a code never contains, so they can only be what surrounded it when it was copied.
const SURROUNDINGS = /^[\s<>"'“”‘’()[\].,;:!]+|[\s<>"'“”‘’()[\].,;:!]+$/g;

type Link = { scheme: string; host: string; path: string; query: string; fragment: string };

// Read with string operations, not URL: React Native's URL is an approximation of the standard
// one, and this must read a link the same on the phone as in the tests.
function parse(text: string): Link | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(text);
  if (!match) return null;
  return { scheme: match[1].toLowerCase(), host: match[2].toLowerCase(), path: match[3], query: match[4] ?? '', fragment: match[5] ?? '' };
}

function param(part: string, key: string): string | null {
  for (const pair of part.split('&')) {
    const at = pair.indexOf('=');
    if (at < 0 || pair.slice(0, at) !== key) continue;
    let value = pair.slice(at + 1);
    try {
      value = decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
      return null;
    }
    return BARE_CODE.test(value.trim()) ? value.trim() : null;
  }
  return null;
}

// After the # first, as links are sent now; the query only for links sent before that.
function keyedCode(link: Link, key: string): string | null {
  return param(link.fragment, key) ?? param(link.query, key);
}

/** Pasted text: the whole link, in any shape it has been sent in, or just the code. */
export function readPastedInvitation(text: string): PastedInvitation {
  const trimmed = text.replace(SURROUNDINGS, '');
  if (!trimmed) return { problem: 'empty' };
  if (BARE_CODE.test(trimmed)) return { code: trimmed };
  // An address copied without its scheme still reads as one.
  const link = parse(trimmed) ?? parse(`https://${trimmed}`);
  if (!link || !['http', 'https'].includes(link.scheme)) return { problem: 'not-an-invitation' };
  const code = keyedCode(link, 'invite');
  if (code) return { code };
  if (keyedCode(link, 'verify')) return { problem: 'verification-link' };
  if (keyedCode(link, 'recovery')) return { problem: 'recovery-link' };
  return { problem: 'not-an-invitation' };
}

/**
 * A link the phone was opened with (+native-intent.tsx). Only an invitation's path is ever claimed
 * (Universal Links and App Links), so anything else is left to the router as it came. Answers
 * undefined for a link that is not an invitation, null for the invitation path with no usable code,
 * and the code otherwise.
 */
export function openedInvitation(opened: string): string | null | undefined {
  // The router may hand over a whole URL or only its path.
  const link = parse(opened) ?? parse(`app://${opened.startsWith('/') ? '' : '/'}${opened}`);
  if (!link) return undefined;
  // togetherledger://invite#invite=… carries "invite" where a web address has its host.
  const path = ['http', 'https', 'app'].includes(link.scheme) ? link.path : `/${link.host}${link.path}`;
  if (path.replace(/\/+$/, '') !== INVITATION_PATH) return undefined;
  return keyedCode(link, 'invite');
}
