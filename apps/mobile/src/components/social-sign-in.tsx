import * as AppleAuthentication from 'expo-apple-authentication';
import { GoogleSignin, GoogleSigninButton, statusCodes } from '@react-native-google-signin/google-signin';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { AccountUser, AppleSignInBody, GoogleSignInBody } from '../api/client';
import { accountMessage } from '../auth/account-messages';
import { keptAppleName } from '../auth/kept-apple-name';
import { useSession } from '../auth/session';
import { appleCancelled, appleSignInBody, googleCancelled, googleIdToken, NOTHING_OFFERED, offeredSignIns, type Offer } from '../auth/social-sign-in';
import { googleClientId, phonePlatform } from '../config/google';
import { useTheme } from '../theme';
import { Button, Field, Notice } from './ui';

// The library's own words for a sheet that was closed, or is still open from a first tap.
const GOOGLE_QUIET = [statusCodes.SIGN_IN_CANCELLED, statusCodes.IN_PROGRESS];
// Both buttons are this tall, and as wide as each other: over the 44-point minimum (#178), and the
// height Google draws its own button at.
const PROVIDER_BUTTON = { width: '100%', maxWidth: 400, height: 48, alignSelf: 'center' } as const;

type Provider = 'google' | 'apple';
type PendingLink = { provider: Provider; body: GoogleSignInBody | AppleSignInBody; email: string };

/**
 * Continue with Google and Apple (TL-S-04, #217), on the screens that sign in with an email. Nothing
 * shows until the server says what is ready for this phone (src/auth/social-sign-in.ts). The ID
 * token goes to our server and nowhere else, and comes back as the same token pair a password
 * sign-in gets, kept in the keychain (#180). Closing either sheet is silent. An email that already
 * has a password account asks for that password once, in the web's words (src/app.js).
 */
export function SocialSignIn({ onSignedIn }: { onSignedIn?: (user: AccountUser) => void }) {
  const session = useSession();
  const { theme } = useTheme();
  const [offer, setOffer] = useState<Offer>(NOTHING_OFFERED);
  const [pending, setPending] = useState<Provider | 'link' | null>(null);
  const [link, setLink] = useState<PendingLink | null>(null);
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const { client } = session;

  useEffect(() => {
    let current = true;
    (async () => {
      const appleSheet = phonePlatform === 'ios' && await AppleAuthentication.isAvailableAsync().catch(() => false);
      const answer = await client.providers(phonePlatform, googleClientId);
      const offered = offeredSignIns(phonePlatform, answer, { appleSheet });
      if (offered.google && googleClientId) {
        GoogleSignin.configure(phonePlatform === 'ios' ? { iosClientId: googleClientId } : { webClientId: googleClientId });
      }
      if (current) setOffer(offered);
    })().catch(() => {
      // Not ready, or not reachable: email sign-in is still here, and that is all that shows.
    });
    return () => { current = false; };
  }, [client]);

  async function finish(provider: Provider, signIn: () => Promise<AccountUser>, body: GoogleSignInBody | AppleSignInBody) {
    try {
      const user = await signIn();
      if (provider === 'apple') await keptAppleName.clear().catch(() => {});
      setLink(null);
      setPassword('');
      session.setUser(user);
      onSignedIn?.(user);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      const email = (error as { details?: { email?: unknown } | null } | null)?.details?.email;
      if (code === 'link_required') setLink({ provider, body, email: typeof email === 'string' ? email : 'this email' });
      // A sign-in that has run out, or belongs to another account, starts again from its button.
      else if (code === 'invalid_token' || code === 'identity_in_use') setLink(null);
      setNotice(accountMessage(error));
    }
  }

  async function continueWithGoogle() {
    setPending('google');
    setNotice(null);
    try {
      if (phonePlatform === 'android') await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      const outcome = await GoogleSignin.signIn();
      if (googleCancelled(outcome, GOOGLE_QUIET)) return;
      const idToken = googleIdToken(outcome);
      // The phone keeps no Google session of its own: the next time, Google asks which account.
      await GoogleSignin.signOut().catch(() => {});
      if (!idToken) {
        setNotice(accountMessage(null));
        return;
      }
      const body = { idToken };
      await finish('google', () => client.signInWithGoogle(body), body);
    } catch (error) {
      // Only Google's own library throws here (our server's answers are handled in finish), and
      // its words are not ours: the account's fallback is said, as the web does for Apple's.
      if (!googleCancelled(error, GOOGLE_QUIET)) setNotice(accountMessage(null));
    } finally {
      setPending(null);
    }
  }

  async function continueWithApple() {
    setPending('apple');
    setNotice(null);
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
      });
      const body = await appleSignInBody(credential, keptAppleName);
      if (!body) {
        setNotice(accountMessage(null));
        return;
      }
      await finish('apple', () => client.signInWithApple(body), body);
    } catch (error) {
      if (!appleCancelled(error)) setNotice(accountMessage(null));
    } finally {
      setPending(null);
    }
  }

  async function connect() {
    if (!link) return;
    setPending('link');
    setNotice(null);
    await finish(link.provider, () => client.linkIdentity(link.provider, link.body, password), link.body);
    setPending(null);
  }

  if (!offer.google && !offer.apple) return null;
  const dark = theme.base === 'dark';
  const busy = pending !== null;

  if (link) {
    return (
      <View style={styles.group}>
        <Text accessibilityRole="header" style={[styles.heading, { color: theme.colors.fg }]}>{link.provider === 'apple' ? 'Connect Apple to your account' : 'Connect Google to your account'}</Text>
        <Field label={`Password for ${link.email}`} value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" />
        <Notice message={notice} tone="problem" />
        <Button label="Connect and sign in" pending={pending === 'link'} pendingLabel="Connecting…" disabled={!password} onPress={connect} />
        <Button kind="quiet" label="Not now" disabled={busy} onPress={() => { setLink(null); setPassword(''); setNotice(null); }} />
      </View>
    );
  }

  return (
    <View style={styles.group} accessibilityLabel="Continue with Google or Apple">
      {offer.apple ? (
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
          buttonStyle={dark ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={theme.radius.s}
          style={[PROVIDER_BUTTON, busy ? styles.waiting : null]}
          onPress={() => { if (!busy) continueWithApple(); }}
        />
      ) : null}
      {offer.google ? (
        <GoogleSigninButton
          size={GoogleSigninButton.Size.Wide}
          color={dark ? 'dark' : 'light'}
          disabled={busy}
          style={PROVIDER_BUTTON}
          onPress={continueWithGoogle}
        />
      ) : null}
      <Notice message={notice} tone="problem" />
      <Text style={[styles.or, { color: theme.colors.muted }]}>or</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 12, alignItems: 'stretch' },
  heading: { fontSize: 18, fontWeight: '700' },
  waiting: { opacity: 0.7 },
  or: { fontSize: 15, textAlign: 'center' },
});
