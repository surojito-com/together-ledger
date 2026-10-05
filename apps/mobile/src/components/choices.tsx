import { Pressable, StyleSheet, Text, View } from 'react-native';
import { targetSize, useTheme } from '../theme';

/**
 * A single choice among a few, as a row of options a thumb can reach. The chosen one is marked
 * by a filled shape as well as colour, so it is not told by colour alone.
 */
export function Choices({ label, options, selected, onSelect, disabled }: {
  label: string;
  options: [string, string][];
  selected: string;
  onSelect: (value: string) => void;
  disabled?: (value: string) => boolean;
}) {
  const { theme } = useTheme();
  const colors = theme.colors;
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.choices}>
      {options.map(([value, text]) => {
        const active = value === selected;
        const off = disabled?.(value) ?? false;
        return (
          <Pressable
            key={value}
            accessibilityRole="radio"
            accessibilityState={{ checked: active, disabled: off }}
            disabled={off}
            onPress={() => onSelect(value)}
            style={({ pressed }) => [styles.choice, targetSize, { borderColor: active ? colors.accent : colors.border, backgroundColor: active ? colors.accent : colors.surface, borderRadius: theme.radius.pill, opacity: pressed || off ? 0.55 : 1 }]}
          >
            <Text style={[styles.choiceText, { color: active ? colors.onAccent : colors.fg }]}>{active ? '● ' : ''}{text}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { borderWidth: 1, paddingHorizontal: 14, justifyContent: 'center' },
  choiceText: { fontSize: 15, fontWeight: '700' },
});
