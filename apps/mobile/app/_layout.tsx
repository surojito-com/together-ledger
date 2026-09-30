import { useFonts } from 'expo-font';
import { router, Stack } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';
import { SessionProvider } from '../src/auth/session';
import { ShellOverlays } from '../src/components/dialogs';
import { ShellProvider } from '../src/shell/shell-provider';
import { fontSources, targetSize, ThemeProvider, useTheme } from '../src/theme';

/** Settings from the ledger's header, at the 44-point minimum like everything else. */
function SettingsButton() {
  const { theme } = useTheme();
  return (
    <Pressable accessibilityRole="button" onPress={() => router.push('/settings')} style={({ pressed }) => [styles.headerButton, targetSize, { opacity: pressed ? 0.7 : 1 }]}>
      <Text style={[styles.headerButtonText, { color: theme.colors.accent }]}>Settings</Text>
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
    </Stack>
  );
}

export default function RootLayout() {
  // The serif ships inside the app (#177), so nothing is fetched at runtime.
  const [fontsLoaded] = useFonts(fontSources);
  if (!fontsLoaded) return null;
  return (
    <ThemeProvider>
      <SessionProvider>
        <ShellProvider>
          <ThemedStack />
          <ShellOverlays />
        </ShellProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  headerButton: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  headerButtonText: { fontSize: 16, fontWeight: '700' },
});
