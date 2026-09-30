import { StyleSheet, Text, View } from 'react-native';
import { fonts, useTheme } from '../theme';

/**
 * The web's emptyState(): an empty surface still says what it is and why it is empty, rather
 * than trailing off. The compact variant is for a list inside a larger screen.
 */
export function EmptyState({ title, body, compact = false }: { title: string; body: string; compact?: boolean }) {
  const { theme } = useTheme();
  return (
    <View style={compact ? styles.compact : styles.empty}>
      <Text style={[styles.title, fonts.serif, { color: theme.colors.fg }]}>{title}</Text>
      <Text style={[styles.body, { color: theme.colors.muted }]}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { paddingVertical: 45, paddingHorizontal: 25 },
  compact: { paddingVertical: 25, paddingHorizontal: 10 },
  title: { fontSize: 19, lineHeight: 25, textAlign: 'center' },
  body: { fontSize: 16, lineHeight: 23, marginTop: 6, textAlign: 'center' },
});
