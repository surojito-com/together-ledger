import { router } from 'expo-router';
import { useState } from 'react';
import { accountMessage } from '../src/auth/account-messages';
import { useSession } from '../src/auth/session';
import { STORE_SUBSCRIPTION_NOT_CANCELLED } from '../src/billing/store-products';
import { Body, Button, Field, Screen } from '../src/components/ui';
import { useWaitingMoments } from '../src/journey/use-waiting-moments';
import { removedWithAccount } from '../src/journey/waiting-moments';
import { useShell } from '../src/shell/shell-provider';

/**
 * Delete the account: say plainly what goes and what stays, ask for the password and the word
 * DELETE as the web does, then confirm once more in the consequence dialog (#243). An account
 * opened with Apple or Google has no password, so it is asked only for DELETE (#217): still three
 * taps from Settings, and no password prompt. The words are
 * the web's and the privacy policy's, with one addition the web has no need of: a subscription
 * bought in the App Store or Google Play carries on after the account is deleted, and only Apple or
 * Google can cancel it, so the phone says so before anything is deleted.
 */
/**
 * What stays, and the one payment that stops a deletion: a subscription paid for on the web, by
 * the person or in a journey they own (server/billing.js, assertAccountDeletable). A store
 * subscription doesn't, which is why the next paragraph says deleting doesn't cancel it (#355).
 */
const DELETION_KEEPS = "What stays: moments you had shared, with their places and photos, stay with the other people in that journey, and the journey's history records that a member deleted their account. The email address you were invited at stays in the journey's invitation history and in any proposal to add you. The people in the journey see it only partly, such as s••d@gmail.com, and the journey's history, which records each step of inviting you, shows it the same way.";
const DELETION_WAITS_ON_WEB_PAYMENT = 'If you pay on the web for room in a journey, or own a journey whose room is paid for on the web, that payment must end first.';

export default function DeleteAccountScreen() {
  const session = useSession();
  const shell = useShell();
  const waiting = useWaitingMoments();
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  // Only an account that has a password is asked for it; the server says which (`hasPassword`).
  const asksForPassword = session.status !== 'signed-in' || session.user.hasPassword !== false;

  async function confirm() {
    // A moment still waiting on this phone can never be sent once the account is gone (#352).
    const unsent = removedWithAccount(waiting.moments.length);
    if (!await shell.confirmConsequence({ title: 'Permanently delete this account?', consequence: `This follows the journey ownership rules shown here and cannot be undone. ${STORE_SUBSCRIPTION_NOT_CANCELLED}${unsent ? ` ${unsent}` : ''}`, confirmLabel: 'Permanently delete account', destructive: true })) return;
    setPending(true);
    shell.clearStatus('account-deletion');
    try {
      await session.client.deleteAccount(asksForPassword ? password : null);
      await waiting.clear();
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
      {/* Said in PRIVACY.md's own words (#355), and checked against it by tests/mobile-account.test.js. */}
      <Body>{DELETION_KEEPS}</Body>
      <Body>{DELETION_WAITS_ON_WEB_PAYMENT}</Body>
      {/* Owner, Oct 8, 2026 (docs/STORE_PURCHASES.md), and App Store guideline 5.1.1(v). */}
      <Body>{STORE_SUBSCRIPTION_NOT_CANCELLED}</Body>
      {asksForPassword ? <Field label="Current password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" /> : null}
      <Field label="Type DELETE" value={typed} onChangeText={setTyped} autoCapitalize="characters" autoCorrect={false} />
      <Button kind="destructive" label="Permanently delete account" pending={pending} pendingLabel="Deleting…" disabled={(asksForPassword && !password) || typed !== 'DELETE'} onPress={confirm} />
    </Screen>
  );
}
