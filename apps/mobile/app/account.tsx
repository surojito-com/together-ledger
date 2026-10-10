import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { accountMessage, ACCOUNT_NOTICES } from '../src/auth/account-messages';
import { useSession } from '../src/auth/session';
import { ACCOUNT_WHILE_OFFLINE } from '../src/auth/session-state';
import { accountEmailLabel, appleSharedNoEmail, NO_EMAIL_SUPPORT } from '../src/auth/social-sign-in';
import { useJourney } from '../src/journey/use-journey';
import { useWaitingMoments } from '../src/journey/use-waiting-moments';
import { signOutConsequence } from '../src/journey/waiting-moments';
import { useShell } from '../src/shell/shell-provider';
import { SocialSignIn } from '../src/components/social-sign-in';
import { Body, Button, Field, Notice, Screen } from '../src/components/ui';

/**
 * Sign in, or, once signed in, the account itself: who you are, whether your email is verified,
 * and signing out. TL-M-05 (#180). The words are the web's (index.html, src/app.js).
 */
export default function AccountScreen() {
  const session = useSession();
  // A screen that closes after it succeeds (registering, deleting) leaves its message here.
  const { notice: carried } = useLocalSearchParams<{ notice?: keyof typeof ACCOUNT_NOTICES }>();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState<'sign-in' | 'resend' | 'sign-out' | 'refresh' | 'name' | null>(null);
  // The name being edited; null until the person types, so it shows their current name.
  const [name, setName] = useState<string | null>(null);
  const journey = useJourney();
  const waiting = useWaitingMoments();
  const shell = useShell();
  const [notice, setNotice] = useState<string | null>(carried && carried in ACCOUNT_NOTICES ? ACCOUNT_NOTICES[carried] : null);
  const [problem, setProblem] = useState(false);

  async function run(action: typeof pending, work: () => Promise<string | null>) {
    setPending(action);
    setNotice(null);
    try {
      const message = await work();
      setProblem(false);
      setNotice(message);
    } catch (error) {
      setProblem(true);
      setNotice(accountMessage(error));
    } finally {
      setPending(null);
    }
  }

  if (session.status === 'loading') return <Screen title="Account"><Body>Checking this phone’s account…</Body></Screen>;

  // Signed in, but the service could not be asked (#352). The password form would ask for
  // something this phone does not need.
  if (session.status === 'offline') {
    return (
      <Screen title="Account">
        <Body>{ACCOUNT_WHILE_OFFLINE[session.reason]}</Body>
        <Button kind="quiet" label="Try again" pending={pending === 'refresh'} onPress={() => run('refresh', async () => {
          await session.refresh();
          return null;
        })} />
      </Screen>
    );
  }

  if (session.status === 'signed-in') {
    const { user } = session;
    return (
      <Screen title="Account" lead="Passwords are never shared between journeyers.">
        {/* An Apple account with no email shows plain words, not the placeholder it holds (#217). */}
        <Body>{user.displayName || user.username} · {accountEmailLabel(user.email)}</Body>
        <Body>{user.emailVerified ? 'Email verified.' : 'Email not verified yet. Invitations can be accepted once it is.'}</Body>
        {/* The name journeyers see (#253). Each journey notes when it changes; the handle stays private. */}
        <Field label="Name journeyers see" value={name ?? user.displayName} onChangeText={setName} maxLength={80} autoComplete="name" textContentType="name" hint={`Everyone in your journeys sees this name, and each journey notes when it changes. Your handle, @${user.username}, stays private.`} />
        <Button kind="quiet" label="Save name" pending={pending === 'name'} pendingLabel="Saving…" disabled={!(name ?? user.displayName).trim() || (name ?? user.displayName).trim() === user.displayName} onPress={() => run('name', async () => {
          session.setUser(await session.client.changeDisplayName((name ?? user.displayName).trim()));
          setName(null);
          await journey.reload();
          return 'Name saved. Your journeyers see it now.';
        })} />
        {/* An Apple account with no email can't be sent one; it is told where to write (#217). */}
        {appleSharedNoEmail(user.email) ? <Body selectable>{NO_EMAIL_SUPPORT}</Body> : null}
        {!user.emailVerified && !appleSharedNoEmail(user.email) ? (
          <>
            <Button kind="quiet" label="Resend verification email" pending={pending === 'resend'} pendingLabel="Sending…" onPress={() => run('resend', async () => (
              await session.client.resendVerification() ? ACCOUNT_NOTICES.verificationResent : ACCOUNT_NOTICES.verificationDelayed
            ))} />
            <Button kind="quiet" label="I verified it in my browser" pending={pending === 'refresh'} onPress={() => run('refresh', async () => {
              await session.refresh();
              return null;
            })} />
          </>
        ) : null}
        <Notice message={notice} tone={problem ? 'problem' : 'info'} />
        <Body>Signing out removes hosted journeys from this view without deleting them.</Body>
        <Button kind="quiet" label="Sign out" pending={pending === 'sign-out'} onPress={async () => {
          // Moments still waiting on this phone are said, and asked about, before they go (#352).
          const held = waiting.moments.length;
          if (held && !await shell.confirmConsequence(signOutConsequence(held))) return;
          await run('sign-out', async () => {
            if (held) await waiting.clear();
            try {
              await session.client.logout();
            } finally {
              session.setUser(null);
            }
            return ACCOUNT_NOTICES.signedOut;
          });
        }} />
      </Screen>
    );
  }

  return (
    <Screen title="Sign in" lead="Passwords are never shared between journeyers.">
      {/* Continue with Google and Apple (#217): only once the server says they work on this phone. */}
      <SocialSignIn />
      <Field label="Email or username" value={identifier} onChangeText={setIdentifier} autoCapitalize="none" autoComplete="username" textContentType="username" />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" />
      <Notice message={notice} tone={problem ? 'problem' : 'info'} />
      <Button label="Sign in" pending={pending === 'sign-in'} pendingLabel="Signing in…" disabled={!identifier || !password} onPress={() => run('sign-in', async () => {
        session.setUser(await session.client.login({ identifier: identifier.trim(), password }));
        setPassword('');
        return null;
      })} />
      <Button kind="quiet" label="I forgot my password" onPress={() => router.push('/recovery')} />
      <Button kind="quiet" label="Create account" onPress={() => router.push('/register')} />
    </Screen>
  );
}
