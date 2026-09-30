import { type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { fonts, targetSize, useTheme } from '../theme';

/**
 * The small set of pieces the account screens are built from. Every tappable thing meets the
 * 44-point minimum (#178), and colour comes from semantic roles only.
 */
export function Screen({ title, lead, children }: { title: string; lead?: string; children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <SafeAreaView edges={['bottom']} style={[styles.fill, { backgroundColor: theme.colors.bg }]}>
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={[styles.title, fonts.serif, { color: theme.colors.fg }]}>{title}</Text>
        {lead ? <Text style={[styles.body, { color: theme.colors.textSecondary }]}>{lead}</Text> : null}
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Field({ label, hint, ...input }: { label: string; hint?: string } & TextInputProps) {
  const { theme } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.colors.fg }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={theme.colors.muted}
        style={[styles.input, targetSize, { color: theme.colors.fg, borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceElevated, borderRadius: theme.radius.m }]}
        {...input}
      />
      {hint ? <Text style={[styles.hint, { color: theme.colors.muted }]}>{hint}</Text> : null}
    </View>
  );
}

type ButtonKind = 'primary' | 'quiet' | 'destructive';

export function Button({ label, onPress, kind = 'primary', pending = false, pendingLabel, disabled = false }: {
  label: string;
  onPress: () => void;
  kind?: ButtonKind;
  pending?: boolean;
  pendingLabel?: string;
  disabled?: boolean;
}) {
  const { theme } = useTheme();
  // The destructive colour is only for what cannot be undone (CLAUDE.md).
  const fill = kind === 'primary' ? theme.colors.accent : kind === 'destructive' ? theme.colors.destructive : 'transparent';
  const text = kind === 'quiet' ? theme.colors.accent : theme.colors.onAccent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || pending, busy: pending }}
      disabled={disabled || pending}
      onPress={onPress}
      style={({ pressed }) => [styles.button, targetSize, { backgroundColor: fill, borderRadius: theme.radius.pill, borderColor: kind === 'quiet' ? theme.colors.border : fill, opacity: pressed || disabled ? 0.7 : 1 }]}
    >
      {pending ? <ActivityIndicator color={text} /> : null}
      <Text style={[styles.buttonText, { color: text }]}>{pending && pendingLabel ? pendingLabel : label}</Text>
    </Pressable>
  );
}

/** A message that stays until it is replaced, so a slow reader never misses it. */
export function Notice({ message, tone = 'info' }: { message: string | null; tone?: 'info' | 'problem' }) {
  const { theme } = useTheme();
  if (!message) return null;
  return (
    <View accessibilityLiveRegion="polite" style={[styles.notice, { backgroundColor: theme.colors.surface, borderColor: tone === 'problem' ? theme.colors.caution : theme.colors.border, borderRadius: theme.radius.m }]}>
      <Text style={[styles.body, { color: theme.colors.fg }]}>{message}</Text>
    </View>
  );
}

export function Body({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  return <Text style={[styles.body, { color: theme.colors.textSecondary }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  screen: { padding: 24, gap: 16 },
  title: { fontSize: 30, lineHeight: 36 },
  body: { fontSize: 16, lineHeight: 23 },
  field: { gap: 6 },
  label: { fontSize: 15, fontWeight: '600' },
  hint: { fontSize: 13, lineHeight: 18 },
  input: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16 },
  button: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, borderWidth: 1 },
  buttonText: { fontSize: 16, fontWeight: '700' },
  notice: { borderWidth: 1, padding: 14 },
});
