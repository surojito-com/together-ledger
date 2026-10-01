import { useState } from 'react';
import { accountMessage, ACCOUNT_NOTICES } from '../src/auth/account-messages';
import { useSession } from '../src/auth/session';
import { Button, Field, Notice, Screen } from '../src/components/ui';

/** Ask for a recovery link. The answer never says whether the account exists. */
export default function RecoveryRequestScreen() {
  const session = useSession();
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ message: string; problem: boolean } | null>(null);

  async function send() {
    setPending(true);
    setNotice(null);
    try {
      await session.client.requestRecovery(email.trim());
      setNotice({ message: ACCOUNT_NOTICES.recoverySent, problem: false });
    } catch (error) {
      setNotice({ message: accountMessage(error), problem: true });
    } finally {
      setPending(false);
    }
  }

  return (
    <Screen title="Request a recovery link" lead="The response is identical whether an account exists or not.">
      <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" textContentType="emailAddress" />
      <Notice message={notice?.message ?? null} tone={notice?.problem ? 'problem' : 'info'} />
      <Button label="Send recovery link" pending={pending} pendingLabel="Sending…" disabled={!email} onPress={send} />
    </Screen>
  );
}
