import { router } from 'expo-router';
import { useState } from 'react';
import { accountMessage } from '../src/auth/account-messages';
import { useSession } from '../src/auth/session';
import { STORE_SUBSCRIPTION_NOT_CANCELLED } from '../src/billing/store-products';
import { Body, Button, Field, Screen } from '../src/components/ui';
import { useShell } from '../src/shell/shell-provider';

/**
 * Delete the account: say plainly what goes and what stays, ask for the password and the word
 * DELETE as the web does, then confirm once more in the consequence dialog (#243). The words are
 * the web's and the privacy policy's, with one addition the web has no need of: a subscription
 * bought in the App Store or Google Play carries on after the account is deleted, and only Apple or
 * Google can cancel it, so the phone says so before anything is deleted.
 */
export default function DeleteAccountScreen() {
  const session = useSession();
  const shell = useShell();
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);

  async function confirm() {
    if (!await shell.confirmConsequence({ title: 'Permanently delete this account?', consequence: `This follows the journey ownership rules shown here and cannot be undone. ${STORE_SUBSCRIPTION_NOT_CANCELLED}`, confirmLabel: 'Permanently delete account', destructive: true })) return;
    setPending(true);
    shell.clearStatus('account-deletion');
    try {
      await session.client.deleteAccount(password);
      session.setUser(null);
      router.replace({ pathname: '/account', params: { notice: 'deleted' } });
    } catch (error) {
      shell.showStatus(accountMessage(error), { source: 'account-deletion' });
    } finally {
      setPending(false);
    }
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
      {/* Owner, Oct 8, 2026 (docs/STORE_PURCHASES.md), and App Store guideline 5.1.1(v). */}
      <Body>{STORE_SUBSCRIPTION_NOT_CANCELLED}</Body>
      <Field label="Current password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" />
      <Field label="Type DELETE" value={typed} onChangeText={setTyped} autoCapitalize="characters" autoCorrect={false} />
      <Button kind="destructive" label="Permanently delete account" pending={pending} pendingLabel="Deleting…" disabled={!password || typed !== 'DELETE'} onPress={confirm} />
    </Screen>
  );
}
