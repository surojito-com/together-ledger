import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';
import { googleCancelled, googleIdToken } from './social-sign-in';

/**
 * Continue with Google on Android (#217): Google's own sheet, through the native library, which
 * asks for a token issued to the web client (`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`). The iPhone's
 * browser-based sign-in is google-sheet.ts.
 *
 * Resolves Google's ID token, or null when the person changed their mind.
 */
// The library's own words for a sheet that was closed, or is still open from a first tap.
const QUIET = [statusCodes.SIGN_IN_CANCELLED, statusCodes.IN_PROGRESS];
let configuredFor: string | null = null;

export async function googleIdTokenFromSheet(clientId: string): Promise<string | null> {
  if (configuredFor !== clientId) {
    GoogleSignin.configure({ webClientId: clientId });
    configuredFor = clientId;
  }
  let outcome;
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    outcome = await GoogleSignin.signIn();
  } catch (error) {
    if (googleCancelled(error, QUIET)) return null;
    throw error;
  }
  if (googleCancelled(outcome, QUIET)) return null;
  // The phone keeps no Google session of its own: the next time, Google asks which account.
  await GoogleSignin.signOut().catch(() => {});
  const idToken = googleIdToken(outcome);
  if (!idToken) throw new Error('Google did not return an ID token.');
  return idToken;
}
