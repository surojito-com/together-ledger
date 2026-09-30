import { router } from 'expo-router';
import { Body, Button, Screen } from '../src/components/ui';

/**
 * Welcome. The real introduction and the app shell are TL-M-06 (#181); until then this is the
 * way into the account screens TL-M-05 (#180) builds.
 */
export default function WelcomeScreen() {
  return (
    <Screen title="Together Ledger">
      <Body>A private place for two people to hold the moments, plans, and memories they want to come back to.</Body>
      <Button label="Account" onPress={() => router.push('/account')} />
      <Button kind="quiet" label="Settings" onPress={() => router.push('/settings')} />
    </Screen>
  );
}
