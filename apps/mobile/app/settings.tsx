import { router } from 'expo-router';
import { useSession } from '../src/auth/session';
import { Body, Button, Screen } from '../src/components/ui';

/**
 * Settings. Account deletion is one tap away here, then a screen that says what it removes and
 * keeps, then a confirmation: three taps, the bar the stores set (#180).
 */
export default function SettingsScreen() {
  const session = useSession();
  return (
    <Screen title="Settings">
      <Button kind="quiet" label="Account" onPress={() => router.push('/account')} />
      {session.status === 'signed-in' ? (
        <Button kind="quiet" label="Delete account" onPress={() => router.push('/delete-account')} />
      ) : (
        <Body>Sign in to manage or delete your account.</Body>
      )}
    </Screen>
  );
}
