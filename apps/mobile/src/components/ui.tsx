import { useEffect, useRef, type ReactNode, type Ref, type RefObject } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { fitTyping } from '../../../../src/display-text.js';
import { PENDING_LABEL } from '../shell/defaults';
import { STATUS_TONES } from '../shell/status';
import { useShell } from '../shell/shell-provider';
import { ScreenStatusRegion } from './status-region';
import { fonts, targetSize, useTheme } from '../theme';

/**
 * The small set of pieces every screen is built from. Each screen carries the status region
 * at the top of its work (TL-M-06, #181). Every tappable thing meets the
 * 44-point minimum (#178), and colour comes from semantic roles only.
 */
export function Screen({ title, lead, children, edges = ['bottom', 'left', 'right'], refresh, scrollRef }: {
  title: string;
  lead?: string;
  children: ReactNode;
  edges?: Edge[];
  /** Pull to refresh, as on the ledger, for a screen that shows what other journeyers change. */
  refresh?: { refreshing: boolean; onRefresh: () => void };
  /** For a form that takes the person to a field that needs them (#354). */
  scrollRef?: RefObject<ScrollView | null>;
}) {
  const { theme } = useTheme();
  const { status } = useShell();
  const own = useRef<ScrollView>(null);
  const scroll = scrollRef ?? own;
  // Being in the right place is not the same as being seen (the web's placeStatus): a message
  // raised at the foot of a long form brings the region at its top into view.
  useEffect(() => {
    if (status) scroll.current?.scrollTo({ y: 0, animated: true });
  }, [status, scroll]);
  // The header covers the top inset; a screen without one passes 'top' too, so nothing sits
  // under a notch or the status bar.
  return (
    <SafeAreaView edges={edges} style={[styles.fill, { backgroundColor: theme.colors.bg }]}>
      <ScrollView
        ref={scroll}
        contentContainerStyle={styles.screen}
        keyboardShouldPersistTaps="handled"
        refreshControl={refresh ? <RefreshControl refreshing={refresh.refreshing} onRefresh={refresh.onRefresh} tintColor={theme.colors.accent} colors={[theme.colors.accent]} /> : undefined}
      >
        <ScreenStatusRegion />
        <Text accessibilityRole="header" style={[styles.title, fonts.serif, { color: theme.colors.fg }]}>{title}</Text>
        {lead ? <Text style={[styles.body, { color: theme.colors.textSecondary }]}>{lead}</Text> : null}
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * A labelled text box. `problem` marks the box itself, by a shape and words under it as well as
 * its border, so what needs the person is told where they are looking, not only at the top.
 *
 * `limit` is for a name (owner, Oct 10, 2026): it counts the characters a person sees, the way the
 * server and the web do (src/display-text.js), where maxLength counts UTF-16 units and could cut
 * an emoji in half. An edit that would go past it keeps as much of what was typed as fits.
 */
export function Field({ label, hint, problem, style, ref, limit, ...input }: { label: string; hint?: string; problem?: string | null; ref?: Ref<TextInput>; limit?: number } & TextInputProps) {
  const { theme } = useTheme();
  const { onChangeText, value } = input;
  const changeText = limit && onChangeText ? (next: string) => onChangeText(fitTyping(value ?? '', next, limit).value) : onChangeText;
  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.colors.fg }]}>{label}</Text>
      <TextInput
        ref={ref}
        accessibilityLabel={label}
        accessibilityHint={problem || undefined}
        placeholderTextColor={theme.colors.muted}
        style={[styles.input, targetSize, { color: theme.colors.fg, borderColor: problem ? theme.colors.caution : theme.colors.border, borderWidth: problem ? 2 : 1, backgroundColor: theme.colors.surfaceElevated, borderRadius: theme.radius.m }, style]}
        {...input}
        onChangeText={changeText}
      />
      {problem ? (
        <View accessibilityLiveRegion="polite" style={styles.problem}>
          <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.problemGlyph, { color: theme.colors.caution }]}>{STATUS_TONES.caution.glyph}</Text>
          <Text style={[styles.problemText, { color: theme.colors.fg }]}>{problem}</Text>
        </View>
      ) : null}
      {hint ? <Text style={[styles.hint, { color: theme.colors.muted }]}>{hint}</Text> : null}
    </View>
  );
}

type ButtonKind = 'primary' | 'quiet' | 'destructive';

/**
 * A pending button (the web's setButtonPending) is disabled, marked busy, and says what it is
 * doing, "Working…" unless the caller names the work; its own label comes back when it is done.
 */
export function Button({ label, onPress, kind = 'primary', pending = false, pendingLabel = PENDING_LABEL, disabled = false, ref }: {
  label: string;
  onPress: () => void;
  kind?: ButtonKind;
  pending?: boolean;
  pendingLabel?: string;
  disabled?: boolean;
  ref?: Ref<View>;
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
      ref={ref}
      style={({ pressed }) => [styles.button, targetSize, { backgroundColor: fill, borderRadius: theme.radius.pill, borderColor: kind === 'quiet' ? theme.colors.border : fill, opacity: pressed || disabled ? 0.7 : 1 }]}
    >
      {pending ? <ActivityIndicator color={text} /> : null}
      <Text style={[styles.buttonText, { color: text }]}>{pending ? pendingLabel : label}</Text>
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

/** Body copy. `selectable` lets a person copy it, for an address they need to write to. */
export function Body({ children, selectable = false }: { children: ReactNode; selectable?: boolean }) {
  const { theme } = useTheme();
  return <Text selectable={selectable} style={[styles.body, { color: theme.colors.textSecondary }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  screen: { padding: 24, gap: 16 },
  title: { fontSize: 30, lineHeight: 36 },
  body: { fontSize: 16, lineHeight: 23 },
  field: { gap: 6 },
  label: { fontSize: 15, fontWeight: '600' },
  hint: { fontSize: 13, lineHeight: 18 },
  problem: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  problemGlyph: { fontSize: 13 },
  problemText: { flex: 1, fontSize: 15, lineHeight: 21, fontWeight: '600' },
  input: { borderWidth: 1, paddingHorizontal: 14, paddingVertical: 10, fontSize: 16 },
  button: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20, borderWidth: 1 },
  buttonText: { fontSize: 16, fontWeight: '700' },
  notice: { borderWidth: 1, padding: 14 },
});
