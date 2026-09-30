import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { SessionProvider } from '../src/auth/session';
import { fontSources, ThemeProvider, useTheme } from '../src/theme';

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
      <Stack.Screen name="index" options={{ title: 'Welcome' }} />
      <Stack.Screen name="ledger" options={{ title: 'Ledger' }} />
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
        <ThemedStack />
      </SessionProvider>
    </ThemeProvider>
  );
}
