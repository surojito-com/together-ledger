/**
 * What the phone says about accounts, in the web's words (src/app.js). The copy is careful on
 * purpose, so it is carried over, not rewritten. Server errors already carry their own message;
 * accountMessage() shows it, exactly as the web does, with one exception below.
 */
export const ACCOUNT_FALLBACK_MESSAGE = 'The account service could not complete that request.';

/**
 * The one place the phone does not use the server's words. When a moment has no room for another
 * place or photo, the web's message points at a monthly add-on paid on the web. The app must never
 * point to a web payment (#268; Apple 3.1.1 and 3.1.3). The phone sells room through the App Store
 * and Google Play (#267); until that is built (TL-P-05 onward), it says only what stays true: room
 * belongs to the journey, the same on every device. Once built, this is where it is offered.
 */
export const NO_ROOM_ADDED_HERE: Record<string, string> = {
  location_payment_required: 'This moment has no room for another place. Room belongs to the journey, and is the same on every device. Remove a place to save the moment.',
  image_payment_required: 'This moment has no room for another photo. Room belongs to the journey, and is the same on every device.',
  not_from_the_app: 'That cannot be done from the app.',
};

export function accountMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error && typeof error.message === 'string') {
    if (typeof error.code === 'string' && Object.hasOwn(NO_ROOM_ADDED_HERE, error.code)) return NO_ROOM_ADDED_HERE[error.code];
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
  // #194, in the web's words (src/app.js).
  signedOutEverywhere: 'Signed out on every device, this one included. Sign in again to continue.',
  signedOutHere: 'This device was signed out. This can happen when the password is changed, when Sign out everywhere is used, or when a sign-in runs out. Sign in again to continue.',
  passwordChangedHere: 'Password changed. Every other device was signed out, and this one stays signed in.',
  deleted: 'Account deleted and sessions revoked.',
} as const;
