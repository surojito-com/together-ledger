import { router } from 'expo-router';
import { useState } from 'react';
import { accountMessage } from '../src/auth/account-messages';
import { useSession } from '../src/auth/session';
import { Button, Field, Notice, Screen } from '../src/components/ui';

/** Create an account from the phone. The hints are the web form's, word for word. */
export default function RegisterScreen() {
  const session = useSession();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function register() {
    setPending(true);
    setNotice(null);
    try {
      const { user, verificationSent } = await session.client.register({ username: username.trim(), email: email.trim(), password });
      session.setUser(user);
      router.replace({ pathname: '/account', params: { notice: verificationSent ? 'registered' : 'registeredEmailDelayed' } });
    } catch (error) {
      setNotice(accountMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Screen title="Create account">
      <Field label="Choose a username" hint="3–30 lowercase letters, numbers, or single hyphens. It is for signing in and is not shown to your journeyer. You can choose the names used together when a journey calls for them." value={username} onChangeText={setUsername} autoCapitalize="none" autoComplete="username-new" textContentType="username" />
      <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" textContentType="emailAddress" />
      <Field label="Password" hint="Use at least 12 characters. We send a verification link before invitations can be accepted." value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" />
      <Notice message={notice} tone="problem" />
      <Button label="Create secure account" pending={pending} pendingLabel="Creating account…" disabled={!username || !email || !password} onPress={register} />
    </Screen>
  );
}
