/**
 * What the phone says about accounts, in the web's words (src/app.js). The copy is careful on
 * purpose, so it is carried over, not rewritten. Server errors already carry their own message;
 * accountMessage() shows it, exactly as the web does.
 */
export const ACCOUNT_FALLBACK_MESSAGE = 'The account service could not complete that request.';

export function accountMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return ACCOUNT_FALLBACK_MESSAGE;
}

export const ACCOUNT_NOTICES = {
  registered: 'Account created. Check your email to verify it.',
  registeredEmailDelayed: 'Account created, but email is delayed. Use resend verification shortly.',
  verificationResent: 'A new verification link is on its way.',
  verificationDelayed: 'Email delivery is still unavailable. Please try again later.',
  verified: 'Email verified. You can now accept invitations.',
  recoverySent: 'If that account exists, a recovery link is on its way.',
  passwordChanged: 'Password changed. Sign in again on every device.',
  passwordsDiffer: 'The new passwords do not match.',
  signedOut: 'Signed out.',
  deleted: 'Account deleted and sessions revoked.',
} as const;
