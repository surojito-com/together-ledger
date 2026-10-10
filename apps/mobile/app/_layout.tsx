import { useFonts } from 'expo-font';
import { router, Stack } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { SessionProvider, useSession } from '../src/auth/session';
import { StoreProvider } from '../src/billing/store-provider';
import { ShellOverlays } from '../src/components/dialogs';
import { awaitingYourAnswer } from '../src/journey/sharing-view';
import { JourneyProvider, useJourney } from '../src/journey/use-journey';
import { MomentViewProvider } from '../src/journey/use-moment-view';
import { useWaitingMoments, WaitingMomentsProvider } from '../src/journey/use-waiting-moments';
import { ShellProvider, useShell } from '../src/shell/shell-provider';
import { CONNECTION_SOURCE, OFFLINE_NOTICE } from '../src/shell/connection';
import { useConnectionWatch } from '../src/shell/use-connection';
import { useStoredPreferences, type SaveFailure } from '../src/storage/use-stored-preferences';
import { fontSources, targetSize, ThemeProvider, useTheme } from '../src/theme';

/** Settings from the ledger's header, at the 44-point minimum like everything else. */
function SettingsButton() {
  const { theme } = useTheme();
  const journey = useJourney();
  // Seen from the ledger, where people actually are, and spelled out in full one screen in.
  const waiting = awaitingYourAnswer(journey.state.phase === 'ready' ? journey.state.snapshot : null);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={waiting ? `Settings, ${waiting} to answer` : 'Settings'}
      onPress={() => router.push('/settings')}
      style={({ pressed }) => [styles.headerButton, targetSize, { opacity: pressed ? 0.7 : 1 }]}
    >
      <Text style={[styles.headerButtonText, { color: theme.colors.accent }]}>Settings{waiting ? ` · ${waiting}` : ''}</Text>
    </Pressable>
  );
}

function ThemedStack() {
  const { theme } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.fg,
        contentStyle: { backgroundColor: theme.colors.bg },
      }}
    >
      {/* The two surfaces (TL-M-06, #181). index decides which one opens. */}
      <Stack.Screen name="index" options={{ title: 'Welcome', headerShown: false }} />
      <Stack.Screen name="ledger" options={{ title: 'Ledger', headerRight: () => <SettingsButton /> }} />
      <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      <Stack.Screen name="account" options={{ title: 'Account' }} />
      <Stack.Screen name="register" options={{ title: 'Create account' }} />
      <Stack.Screen name="recovery" options={{ title: 'Account recovery' }} />
      <Stack.Screen name="recovery-confirm" options={{ title: 'Account recovery' }} />
      <Stack.Screen name="verify-email" options={{ title: 'Verify email' }} />
      <Stack.Screen name="delete-account" options={{ title: 'Delete account' }} />
      <Stack.Screen name="moment" options={{ title: 'Hold a moment', presentation: 'modal' }} />
      <Stack.Screen name="new-journey" options={{ title: 'New journey', presentation: 'modal' }} />
      <Stack.Screen name="journey-settings" options={{ title: 'Journey sharing' }} />
      <Stack.Screen name="history" options={{ title: 'History' }} />
      <Stack.Screen name="history-guide" options={{ title: 'How to read your history' }} />
      <Stack.Screen name="privacy" options={{ title: 'Privacy' }} />
      <Stack.Screen name="terms" options={{ title: 'Terms of use' }} />
      <Stack.Screen name="concern" options={{ title: 'Return-to conversation', presentation: 'modal' }} />
    </Stack>
  );
}

/** A change the phone could not save is said in the status region, never as a crash. */
function SaveFailureNotice({ failure }: { failure: SaveFailure }) {
  const { showStatus } = useShell();
  useEffect(() => {
    if (failure) showStatus(failure.message, { tone: 'caution', source: 'storage' });
  }, [failure, showStatus]);
  return null;
}

/**
 * The standing offline notice, as a caution, cleared by its own source when the connection
 * returns (#300). Coming back online, or back to the foreground, checks the session again and
 * reloads the journeys, so an app opened offline recovers without a restart or a password, and
 * sends whatever moments were held while it was away (#352).
 */
function ConnectionWatch() {
  const { refresh } = useSession();
  const { reload } = useJourney();
  const { sendNow } = useWaitingMoments();
  const { showStatus, clearStatus } = useShell();
  const recheck = useCallback(() => {
    refresh().then(sendNow);
    reload();
  }, [refresh, reload, sendNow]);
  useConnectionWatch({
    onOffline: () => showStatus(OFFLINE_NOTICE, { tone: 'caution', source: CONNECTION_SOURCE }),
    onOnline: () => {
      clearStatus(CONNECTION_SOURCE);
      recheck();
    },
    onForeground: recheck,
  });
  return null;
}

export default function RootLayout() {
  // The serif ships inside the app (#177), so nothing is fetched at runtime.
  const [fontsLoaded] = useFonts(fontSources);
  // What the phone remembers (#185), read before the first screen so the saved theme is the first one drawn.
  const { stored, failure, saveTheme, saveMomentView, completeOnboarding } = useStoredPreferences();
  if (!fontsLoaded || !stored) return null;
  return (
    <ThemeProvider initialChoice={stored.theme} onChoiceChange={saveTheme}>
      <SessionProvider>
        <ShellProvider initialOnboardingComplete={stored.onboardingComplete} onOnboardingComplete={completeOnboarding}>
          <JourneyProvider>
            {/* Moments held without a connection, kept on this phone until they are sent (#352). */}
            <WaitingMomentsProvider>
              {/* The App Store or Google Play, while someone is signed in (#272). */}
              <StoreProvider>
                {/* Moments in full or compact (Oct 9), remembered on this phone like the theme. */}
                <MomentViewProvider initialView={stored.momentView} onViewChange={saveMomentView}>
                  <ThemedStack />
                </MomentViewProvider>
              </StoreProvider>
              <ConnectionWatch />
            </WaitingMomentsProvider>
          </JourneyProvider>
          <ShellOverlays />
          <SaveFailureNotice failure={failure} />
        </ShellProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  headerButton: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  headerButtonText: { fontSize: 16, fontWeight: '700' },
});
