import { useRef, useState } from 'react';
import { AccessibilityInfo, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KEEP_LABEL } from '../shell/defaults';
import { fonts, targetSize, useTheme } from '../theme';
import { Button } from './ui';

/**
 * One compact choice among several, as the web's <select> is (#351): a single control that
 * shows what is chosen, and opens the full list only when it is tapped. The empty value is
 * drawn as the placeholder it is, in the muted colour, never as a chosen option. In the list,
 * the chosen option is marked by a filled shape as well as colour, so it is not told by colour
 * alone, and the screen reader starts on it. Android's back gesture keeps things as they are.
 */
export function DropDown({ label, options, selected, onSelect }: {
  label: string;
  /** [value, words] pairs. A '' value is "nothing chosen". */
  options: [string, string][];
  selected: string;
  onSelect: (value: string) => void;
}) {
  const { theme } = useTheme();
  const colors = theme.colors;
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const chosenOption = useRef<View>(null);
  const chosen = options.find(([value]) => value === selected) ?? options[0];
  const empty = !chosen || chosen[0] === '';

  function choose(value: string) {
    setOpen(false);
    onSelect(value);
  }

  return (
    <View style={styles.field}>
      <Text style={[styles.label, { color: colors.fg }]}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${chosen?.[1] ?? ''}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.control, targetSize, { borderColor: colors.border, backgroundColor: colors.surfaceElevated, borderRadius: theme.radius.m, opacity: pressed ? 0.7 : 1 }]}
      >
        <Text style={[styles.value, { color: empty ? colors.muted : colors.fg, fontWeight: empty ? '400' : '600' }]}>{chosen?.[1]}</Text>
        <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.chevron, { color: colors.muted }]}>▾</Text>
      </Pressable>
      <Modal
        visible={open}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setOpen(false)}
        onShow={() => { if (chosenOption.current) AccessibilityInfo.sendAccessibilityEvent(chosenOption.current, 'focus'); }}
      >
        <View style={[styles.frame, { paddingTop: insets.top + 14, paddingBottom: insets.bottom + 14, paddingLeft: insets.left + 14, paddingRight: insets.right + 14 }]}>
          {/* The shell dialog's backdrop: the text colour at 72%. */}
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[StyleSheet.absoluteFill, { backgroundColor: colors.fg, opacity: 0.72 }]} />
          <View accessibilityViewIsModal style={[styles.card, { backgroundColor: colors.surface, borderRadius: theme.radius.xl }]}>
            <ScrollView contentContainerStyle={styles.content}>
              <Text accessibilityRole="header" style={[styles.title, fonts.serif, { color: colors.fg }]}>{label}</Text>
              <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.options}>
                {options.map(([value, words]) => {
                  const active = value === chosen?.[0];
                  return (
                    <Pressable
                      key={value || 'none'}
                      ref={active ? chosenOption : undefined}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: active }}
                      onPress={() => choose(value)}
                      style={({ pressed }) => [styles.option, targetSize, { borderColor: active ? colors.accent : colors.border, backgroundColor: active ? colors.accent : colors.surface, borderRadius: theme.radius.m, opacity: pressed ? 0.7 : 1 }]}
                    >
                      <Text style={[styles.optionText, { color: active ? colors.onAccent : colors.fg }]}>{active ? '● ' : ''}{words}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <Button kind="quiet" label={KEEP_LABEL} onPress={() => setOpen(false)} />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  label: { fontSize: 15, fontWeight: '600' },
  control: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 10 },
  value: { flex: 1, fontSize: 16 },
  chevron: { fontSize: 16 },
  frame: { flex: 1, justifyContent: 'center' },
  card: { maxHeight: '100%', width: '100%', maxWidth: 520, alignSelf: 'center' },
  content: { padding: 24, gap: 12 },
  title: { fontSize: 24, lineHeight: 30 },
  options: { gap: 8 },
  option: { borderWidth: 1, paddingHorizontal: 14, justifyContent: 'center' },
  optionText: { fontSize: 16, fontWeight: '700' },
});
