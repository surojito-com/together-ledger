import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { accountMessage, ACCOUNT_NOTICES } from '../src/auth/account-messages';
import { useSession } from '../src/auth/session';
import { Body, Button, Notice, Screen } from '../src/components/ui';

/**
 * Where the verification link lands, carrying its one-time token as `?token=`. It verifies once,
 * on arrival, and says what happened. Opening the emailed link straight into this screen is
 * part 3 of #180; until then the link completes in the browser.
 */
export default function VerifyEmailScreen() {
  const session = useSession();
  const { token } = useLocalSearchParams<{ token?: string }>();
  const [notice, setNotice] = useState<{ message: string; problem: boolean } | null>(null);

  useEffect(() => {
    if (!token) return;
    let active = true;
    session.client.verifyEmail(String(token))
      .then(async () => {
        if (!active) return;
        setNotice({ message: ACCOUNT_NOTICES.verified, problem: false });
        await session.refresh();
      })
      .catch((error) => active && setNotice({ message: accountMessage(error), problem: true }));
    return () => { active = false; };
    // Verify once per token; the session object changes identity as it refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <Screen title="Verify your email">
      {!token ? <Body>Open the verification link from your email to verify it.</Body> : null}
      {token && !notice ? <Body>Verifying…</Body> : null}
      <Notice message={notice?.message ?? null} tone={notice?.problem ? 'problem' : 'info'} />
      <Button kind="quiet" label="Go to account" onPress={() => router.replace('/account')} />
    </Screen>
  );
}
