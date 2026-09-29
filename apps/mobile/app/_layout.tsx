import { Stack } from 'expo-router';

export default function RootLayout() {
  return (
    <Stack>
      <Stack.Screen name="index" options={{ title: 'Welcome' }} />
      <Stack.Screen name="ledger" options={{ title: 'Ledger' }} />
      <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      <Stack.Screen name="account" options={{ title: 'Account' }} />
    </Stack>
  );
}
