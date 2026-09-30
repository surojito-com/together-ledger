import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
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
    </Stack>
  );
}

export default function RootLayout() {
  // The serif ships inside the app (#177), so nothing is fetched at runtime.
  const [fontsLoaded] = useFonts(fontSources);
  if (!fontsLoaded) return null;
  return (
    <ThemeProvider>
      <ThemedStack />
    </ThemeProvider>
  );
}
