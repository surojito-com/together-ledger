import { router } from 'expo-router';
import { StyleSheet, Text } from 'react-native';
import { useSession } from '../src/auth/session';
import { STILL_SIGNED_IN } from '../src/auth/session-state';
import { awaitingYourAnswer, waitingSuffix } from '../src/journey/sharing-view';
import { useJourney } from '../src/journey/use-journey';
import { RestorePurchases } from '../src/components/store-offers';
import { ThemePicker } from '../src/components/theme-picker';
import { Body, Button, Screen } from '../src/components/ui';
import { useTheme } from '../src/theme';

/**
 * Settings. The theme picker offers all four themes (#181). Journey sharing and the journey's
 * history open from here (#184). Account deletion is one tap away
 * here, then a screen that says what it removes and keeps, then a confirmation: three taps, the
 * bar the stores set (#180). The privacy policy and the addresses to write to are here for
 * everyone, signed in or not: the people who most need them may be the ones who cannot sign in.
 */
export default function SettingsScreen() {
  const session = useSession();
  const journey = useJourney();
  const { theme } = useTheme();
  // The ledger's header says how many wait; here it says what they are waiting for.
  const waiting = awaitingYourAnswer(journey.state.phase === 'ready' ? journey.state.snapshot : null);
  return (
    <Screen title="Settings">
      <Text accessibilityRole="header" style={[styles.section, { color: theme.colors.fg }]}>Appearance</Text>
      <ThemePicker />
      <Body>Your theme changes only your own view. Each journeyer chooses what feels right on their screen.</Body>
      {session.status === 'signed-in' ? (
        <>
          <Text accessibilityRole="header" style={[styles.section, { color: theme.colors.fg }]}>This journey</Text>
          <Button kind="quiet" label={`Journey sharing${waitingSuffix(waiting)}`} onPress={() => router.push('/journey-settings')} />
          <Button kind="quiet" label="History and conversations" onPress={() => router.push('/history')} />
        </>
      ) : null}
      <Text accessibilityRole="header" style={[styles.section, { color: theme.colors.fg }]}>Account</Text>
      <Button kind="quiet" label="Account" onPress={() => router.push('/account')} />
      {session.status === 'signed-in' ? (
        <>
          {/* Room and extras bought in the App Store or Google Play, honoured again on this phone (#275). */}
          <RestorePurchases />
          <Button kind="quiet" label="Delete account" onPress={() => router.push('/delete-account')} />
        </>
      ) : session.status === 'offline' ? (
        <Body>{STILL_SIGNED_IN[session.reason]}</Body>
      ) : (
        <Body>Sign in to manage or delete your account.</Body>
      )}
      <Text accessibilityRole="header" style={[styles.section, { color: theme.colors.fg }]}>Privacy and help</Text>
      <Button kind="quiet" label="Privacy policy" onPress={() => router.push('/privacy')} />
      <Button kind="quiet" label="Terms of use" onPress={() => router.push('/terms')} />
      <Body selectable>For help using Together Ledger, write to ledger-support@together-ledger.com. For anything about your privacy or your data, write to legal@together-ledger.com.</Body>
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 18, fontWeight: '700', marginTop: 8 },
});
