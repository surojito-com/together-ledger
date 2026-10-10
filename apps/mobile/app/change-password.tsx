import { Redirect } from 'expo-router';
import { useState } from 'react';
import { accountMessage, ACCOUNT_NOTICES } from '../src/auth/account-messages';
import { useSession } from '../src/auth/session';
import { Button, Field, Notice, Screen } from '../src/components/ui';

/**
 * Change the password while signed in (#194). The current password is asked for as signing in asks
 * for it, and a wrong one is answered in signing in's words. This phone stays signed in with the
 * tokens it has; every other phone and browser is signed out, and the account's address is sent
 * a plain email saying the password changed. The words are the web's (index.html, src/app.js).
 *
 * An account opened with Apple or Google has no password, so it is never offered this screen;
 * reached anyway, it goes back to the account.
 */
export default function ChangePasswordScreen() {
  const session = useSession();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ message: string; problem: boolean } | null>(null);

  if (session.status !== 'signed-in' || session.user.hasPassword === false) return <Redirect href="/account" />;

  async function change() {
    // As in recovery: a mismatch is fixed by retyping, so the message stays until the next attempt.
    if (newPassword !== confirmPassword) {
      setNotice({ message: ACCOUNT_NOTICES.passwordsDiffer, problem: true });
      return;
    }
    setPending(true);
    setNotice(null);
    try {
      session.setUser(await session.client.changePassword(currentPassword, newPassword));
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setNotice({ message: ACCOUNT_NOTICES.passwordChangedHere, problem: false });
    } catch (error) {
      setNotice({ message: accountMessage(error), problem: true });
    } finally {
      setPending(false);
    }
  }

  return (
    <Screen title="Change password" lead="Changing your password signs out every other device. This one stays signed in, and we email you to say the password changed.">
      <Field label="Current password" value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry autoComplete="current-password" textContentType="password" />
      <Field label="New password" value={newPassword} onChangeText={setNewPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" />
      <Field label="Confirm new password" value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry autoComplete="new-password" textContentType="newPassword" />
      <Notice message={notice?.message ?? null} tone={notice?.problem ? 'problem' : 'info'} />
      <Button label="Change password" pending={pending} pendingLabel="Changing…" disabled={!currentPassword || !newPassword || !confirmPassword} onPress={change} />
    </Screen>
  );
}
