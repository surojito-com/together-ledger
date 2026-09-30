import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { accountMessage, ACCOUNT_NOTICES } from '../src/auth/account-messages';
import { useSession } from '../src/auth/session';
import { Body, Button, Field, Notice, Screen } from '../src/components/ui';

/**
 * Choose a new password. Reached from the recovery link, which carries its one-time token as
 * `?token=`. Opening the emailed link straight into this screen is part 3 of #180.
 */
export default function RecoveryConfirmScreen() {
  const session = useSession();
  const { token } = useLocalSearchParams<{ token?: string }>();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ message: string; problem: boolean } | null>(null);

  async function change() {
    // A mismatch has to be fixed by retyping, so the message stays until the next attempt.
    if (password !== confirmPassword) {
      setNotice({ message: ACCOUNT_NOTICES.passwordsDiffer, problem: true });
      return;
    }
    setPending(true);
    setNotice(null);
    try {
      await session.client.confirmRecovery(String(token), password);
      session.setUser(null);
      setNotice({ message: ACCOUNT_NOTICES.passwordChanged, problem: false });
    } catch (error) {
      setNotice({ message: accountMessage(error), problem: true });
    } finally {
      setPending(false);
    }
  }

  if (!token) {
    return (
      <Screen title="Choose a new password">
        <Body>Open the recovery link from your email to choose a new password.</Body>
        <Button kind="quiet" label="Request a recovery link" onPress={() => router.replace('/recovery')} />
      </Screen>
    );
  }

  return (
    <Screen title="Choose a new password" lead="Completing recovery signs the account out on every device.">
      <Field label="New password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" />
      <Field label="Confirm new password" value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" />
      <Notice message={notice?.message ?? null} tone={notice?.problem ? 'problem' : 'info'} />
      <Button label="Change password" pending={pending} pendingLabel="Changing…" disabled={!password || !confirmPassword} onPress={change} />
      <Button kind="quiet" label="Sign in" onPress={() => router.replace('/account')} />
    </Screen>
  );
}
