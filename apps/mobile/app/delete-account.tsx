import { router } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import { accountMessage } from '../src/auth/account-messages';
import { useSession } from '../src/auth/session';
import { Body, Button, Field, Notice, Screen } from '../src/components/ui';

/**
 * Delete the account, following the consequence-dialog pattern: say plainly what goes and what
 * stays, ask for the password and the word DELETE as the web does, then confirm once more. The
 * words are the web's and the privacy policy's.
 */
export default function DeleteAccountScreen() {
  const session = useSession();
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ message: string; problem: boolean } | null>(null);

  async function remove() {
    setPending(true);
    setNotice(null);
    try {
      await session.client.deleteAccount(password);
      session.setUser(null);
      router.replace({ pathname: '/account', params: { notice: 'deleted' } });
    } catch (error) {
      setNotice({ message: accountMessage(error), problem: true });
    } finally {
      setPending(false);
    }
  }

  function confirm() {
    Alert.alert('Permanently delete this account?', 'This follows the journey ownership rules shown here and cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Permanently delete account', style: 'destructive', onPress: remove },
    ]);
  }

  if (session.status !== 'signed-in') {
    return (
      <Screen title="Delete account">
        <Body>Sign in to delete your account.</Body>
        <Button kind="quiet" label="Sign in" onPress={() => router.replace('/account')} />
      </Screen>
    );
  }

  return (
    <Screen title="Delete account" lead="Deletion revokes every session. A journey held only by you is erased. Transfer ownership of each shared journey deliberately before deleting your account; your membership can then be removed without erasing the journey for everyone else.">
      <Body>What is deleted: journeys only you were in, your private and share-later moments with their places and photos, and your sign-in. Your email, username and name are replaced, and the account shows as Deleted account.</Body>
      <Body>What stays: moments you had shared stay with the people in that journey, and its history records that a member deleted their account, without your email. If you pay for capacity, that payment has to end first.</Body>
      <Field label="Current password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" />
      <Field label="Type DELETE" value={typed} onChangeText={setTyped} autoCapitalize="characters" autoCorrect={false} />
      <Notice message={notice?.message ?? null} tone={notice?.problem ? 'problem' : 'info'} />
      <Button kind="destructive" label="Permanently delete account" pending={pending} pendingLabel="Deleting…" disabled={!password || typed !== 'DELETE'} onPress={confirm} />
    </Screen>
  );
}
