import { useIsFocused } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useShell } from '../shell/shell-provider';
import { STATUS_TONES } from '../shell/status';
import { targetSize, useTheme } from '../theme';

/**
 * The one status region (the web's #status-banner). It sits above the work so nothing is
 * covered. A dialog draws over the screen, so while one is open the region shows inside the
 * dialog instead: still one region, moved to wherever the work currently is.
 */
export function StatusRegion({ place }: { place: 'screen' | 'dialog' }) {
  const { status, clearStatus, dialogOpen } = useShell();
  const { theme } = useTheme();
  const here = place === 'dialog' || !dialogOpen;
  if (!status || !here) return null;
  // The web's own pairing: caution for a condition, destructive for a problem (src/styles.css).
  const toneColor = status.tone === 'problem' ? theme.colors.destructive : theme.colors.caution;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.banner, { borderColor: theme.colors.border, borderLeftColor: toneColor, borderRadius: theme.radius.m, backgroundColor: theme.colors.surface }]}
    >
      <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.glyph, { color: toneColor }]}>{STATUS_TONES[status.tone].glyph}</Text>
      <Text style={[styles.message, { color: theme.colors.fg }]}>{status.message}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        onPress={() => clearStatus()}
        style={({ pressed }) => [styles.dismiss, targetSize, { borderColor: theme.colors.border, borderRadius: theme.radius.pill, opacity: pressed ? 0.7 : 1 }]}
      >
        <Text style={[styles.dismissText, { color: theme.colors.fg }]}>Dismiss</Text>
      </Pressable>
    </View>
  );
}

/** The screen's copy of the region, shown only on the screen in front. */
export function ScreenStatusRegion() {
  const focused = useIsFocused();
  return focused ? <StatusRegion place="screen" /> : null;
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderLeftWidth: 5, paddingVertical: 12, paddingHorizontal: 14 },
  glyph: { fontSize: 14 },
  message: { flex: 1, fontSize: 16, lineHeight: 23 },
  dismiss: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, paddingHorizontal: 14 },
  dismissText: { fontSize: 14, fontWeight: '800' },
});
