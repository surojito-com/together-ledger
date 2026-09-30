import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useShell } from '../shell/shell-provider';
import { targetSize, themes, useTheme } from '../theme';

const FOLLOW_PHONE = 'Match this phone';

/**
 * The web's theme picker, as a list the thumb can reach: all four themes, plus following the
 * phone's own light or dark setting, which is where the app starts. The chosen row carries a
 * filled mark as well as a border, so the choice is not told by colour alone.
 */
export function ThemePicker() {
  const { theme, choice, setChoice } = useTheme();
  const { showToast } = useShell();
  const options = [{ id: null, label: FOLLOW_PHONE }, ...themes.map(({ id, label }) => ({ id, label }))];
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel="Color theme" style={styles.group}>
      {options.map((option) => {
        const selected = option.id === null ? choice === null : choice !== null && theme.id === option.id;
        return (
          <Pressable
            key={option.id ?? 'phone'}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            onPress={() => {
              setChoice(option.id);
              showToast(option.id === null ? 'Theme matches this phone.' : `${option.label} applied.`);
            }}
            style={({ pressed }) => [styles.option, targetSize, {
              borderColor: selected ? theme.colors.accent : theme.colors.border,
              borderRadius: theme.radius.m,
              backgroundColor: theme.colors.surfaceElevated,
              opacity: pressed ? 0.7 : 1,
            }]}
          >
            <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.mark, { color: selected ? theme.colors.accent : theme.colors.muted }]}>{selected ? '●' : '○'}</Text>
            <Text style={[styles.label, { color: theme.colors.fg }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 8 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 10 },
  mark: { fontSize: 16 },
  label: { fontSize: 16, flex: 1 },
});
