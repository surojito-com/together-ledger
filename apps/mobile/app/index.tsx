import { Redirect, router } from 'expo-router';
import { StyleSheet, Text } from 'react-native';
import { Body, Button, Screen } from '../src/components/ui';
import { INVITATION_WORDS } from '../src/invitations/invitation-words';
import { useShell } from '../src/shell/shell-provider';
import { openingSurface } from '../src/shell/surface';
import { fonts, useTheme } from '../src/theme';

/**
 * Where the app opens. Someone who has begun their ledger goes straight to it; everyone else
 * meets the welcome first (the web's showWelcomeSurface / showLedgerSurface). The words are the
 * web's welcome (index.html).
 */
export default function WelcomeScreen() {
  const shell = useShell();
  const { theme } = useTheme();
  if (openingSurface({ onboardingComplete: shell.onboardingComplete }) === 'ledger') return <Redirect href="/ledger" />;
  return (
    <Screen title="Together Ledger" edges={['top', 'bottom', 'left', 'right']}>
      <Text style={[styles.eyebrow, { color: theme.colors.accent }]}>A shared journey, held with care</Text>
      <Text accessibilityRole="header" style={[styles.headline, fonts.serif, { color: theme.colors.fg }]}>
        Keep what matters, <Text style={fonts.serifItalic}>together.</Text>
      </Text>
      <Body>A private place for two people to hold the moments, plans, and memories they want to come back to—without the noise of a feed.</Body>
      <Button label="Begin your ledger →" onPress={() => {
        shell.completeOnboarding();
        router.replace('/ledger');
      }} />
      {/* Someone who installed the app to join a journey: the iPhone carries no link through the store (#266). */}
      <Button kind="quiet" label={INVITATION_WORDS.haveOne} onPress={() => router.push('/invite')} />
      <Button kind="quiet" label="Account" onPress={() => router.push('/account')} />
      <Button kind="quiet" label="Settings" onPress={() => router.push('/settings')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  eyebrow: { fontSize: 12, fontWeight: '900', letterSpacing: 1.9, textTransform: 'uppercase' },
  headline: { fontSize: 40, lineHeight: 44 },
});
