import type { InvitationPreview } from '../api/client';
import type { PastedInvitation } from './invitation-link';

/**
 * Every sentence the phone says about an invitation (#266), in one place so they can be read and
 * approved together. Kept free of runtime imports so the tests can run it directly.
 *
 * An invitation reaches someone only after everyone already in the journey agreed to it
 * (022_agree-together-before-adding-someone.sql). Joining is the last decision, and it is theirs:
 * the phone shows it as waiting for their answer, and never says they joined until they have.
 */
export const INVITATION_WORDS = {
  title: 'Invitation',
  haveOne: 'Have an invitation?',
  pasteLead: 'Paste the link from your invitation email. Just the code after “invite=” works too.',
  pasteLabel: 'Invitation link or code',
  openPasted: 'Open invitation',
  signedOut: 'You have an invitation waiting. Sign in or create an account with the email address it was sent to, and it will be here when you do. It stays on this phone until you answer it.',
  reading: 'Opening your invitation…',
  waitingEyebrow: 'Waiting for your answer',
  agreed: 'Everyone already in this journey agreed to invite you. Joining is your decision.',
  join: 'Join this journey',
  joining: 'Joining…',
  notNow: 'Not now',
  verifyEmail: 'Verify your email to answer this invitation. Open the verification link we sent you, in your browser, then come back here.',
  anotherAccount: 'This invitation was sent to a different email address. Sign in with the account for that address to answer it. It stays on this phone until then.',
  goToAccount: 'Go to account',
  openJourney: 'Open the journey',
  withdrawn: 'This invitation was withdrawn, so it can’t be used. Nothing changed for you.',
  closed: 'This invitation is no longer open. Ask whoever invited you to send a new one.',
  notFound: 'We couldn’t find this invitation. Check that you copied the whole link or code. If it still doesn’t work, ask whoever invited you to send a new one.',
  pasted: {
    empty: 'Paste the link or code first.',
    'not-an-invitation': 'That doesn’t look like an invitation link or code. Paste the whole link from the email, or the code after “invite=”.',
    'verification-link': 'That link verifies an email address; it isn’t an invitation. Open it in your browser.',
    'recovery-link': 'That link sets a new password; it isn’t an invitation. Open it in your browser.',
  } satisfies Record<Exclude<PastedInvitation, { code: string }>['problem'], string>,
  invitedBy: (inviter: string, journey: string) => `${inviter} invited you to join “${journey}”.`,
  openUntil: (date: string) => `This invitation is open until ${date}.`,
  notNowDone: (date: string | null) => (date
    ? `Nothing was sent. The invitation stays open until ${date}, so the link in your email still works if you change your mind.`
    : 'Nothing was sent. The link in your email still works if you change your mind.'),
  joined: (journey: string) => `You joined “${journey}”.`,
  alreadyMember: (journey: string) => `You’re already in “${journey}”. Nothing was used up.`,
  used: (inviter: string) => `This invitation has already been used, and each one works once. To join again, ask ${inviter} to send a new one.`,
  expired: (inviter: string) => `This invitation ran out before it was used. Ask ${inviter} to send it again.`,
} as const;

/** The sentence for an invitation that can't be answered, or null for one that can. */
export function closedInvitationMessage(preview: InvitationPreview): string | null {
  switch (preview.state) {
    case 'already_member': return INVITATION_WORDS.alreadyMember(preview.journeyName);
    case 'used': return INVITATION_WORDS.used(preview.invitedByDisplayName);
    case 'expired': return INVITATION_WORDS.expired(preview.invitedByDisplayName);
    case 'withdrawn': return INVITATION_WORDS.withdrawn;
    case 'closed': return INVITATION_WORDS.closed;
    case 'not_found': return INVITATION_WORDS.notFound;
    default: return null;
  }
}

/** Once one of these is known, the phone forgets the invitation: it can never be answered. */
export function isSettled(preview: InvitationPreview): boolean {
  return closedInvitationMessage(preview) !== null;
}

export function invitationDate(value: string | null | undefined): string | null {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date) : null;
}
