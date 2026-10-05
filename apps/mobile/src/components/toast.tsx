import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';

/**
 * The web's #toast: a passing confirmation, near the bottom, never in the way of a tap. Only
 * things that are fine to miss go here; a problem goes to the status region and stays.
 */
export function Toast({ message }: { message: string | null }) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  if (!message) return null;
  return (
    <View pointerEvents="none" style={[styles.frame, { bottom: insets.bottom + 20 }]}>
      <View accessibilityLiveRegion="polite" style={[styles.toast, { backgroundColor: theme.colors.accent, borderRadius: theme.radius.pill }]}>
        <Text style={[styles.text, { color: theme.colors.onAccent }]}>{message}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  toast: { paddingVertical: 12, paddingHorizontal: 18, maxWidth: '100%' },
  text: { fontSize: 15, fontWeight: '800', textAlign: 'center' },
});
