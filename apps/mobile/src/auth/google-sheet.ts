import { AuthRequest, exchangeCodeAsync, ResponseType } from 'expo-auth-session';
import { GOOGLE_AUTHORIZATION, GOOGLE_SCOPES, googleBrowserOutcome, googleRedirectUri } from './social-sign-in';

/**
 * Continue with Google on an iPhone (#217): Google's own page in the system's sign-in sheet, through
 * expo-auth-session, never Google's SDK (owner, Oct 9, 2026). Android has its own file,
 * google-sheet.android.ts, which Metro takes instead of this one there; this file is never in the
 * Android bundle, and the Google SDK is never in the iOS app (apps/mobile/package.json,
 * `expo.autolinking.ios.exclude`).
 *
 * Resolves Google's ID token, or null when the person changed their mind. The access token Google
 * also returns is neither kept nor used.
 */
export async function googleIdTokenFromSheet(clientId: string): Promise<string | null> {
  const redirectUri = googleRedirectUri(clientId);
  if (!redirectUri) throw new Error('No Google client is configured for this build.');
  const request = new AuthRequest({
    clientId,
    redirectUri,
    scopes: [...GOOGLE_SCOPES],
    responseType: ResponseType.Code,
    usePKCE: true,
    // Google asks which account each time, as it does on Android.
    extraParams: { prompt: 'select_account' },
  });
  const outcome = googleBrowserOutcome(await request.promptAsync(GOOGLE_AUTHORIZATION));
  if (outcome === 'cancelled') return null;
  if (outcome === 'failed' || !request.codeVerifier) throw new Error('Google did not finish signing in.');
  const tokens = await exchangeCodeAsync({ clientId, code: outcome.code, redirectUri, extraParams: { code_verifier: request.codeVerifier } }, GOOGLE_AUTHORIZATION);
  if (!tokens.idToken) throw new Error('Google did not return an ID token.');
  return tokens.idToken;
}
