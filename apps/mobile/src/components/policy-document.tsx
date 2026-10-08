import { Platform, StyleSheet, Text, View } from 'react-native';
import { fonts, useTheme } from '../theme';

type Span = { text: string; bold?: boolean; code?: boolean };
type Block = { kind: string; level?: number; spans?: Span[]; items?: Span[][] };

/**
 * A policy generated from the repository's Markdown by scripts/mobile-policies.mjs (PRIVACY.md,
 * TERMS.md), drawn as text. A link in the source reads as its words: the phone opens no web page
 * (#268).
 */
export function PolicyDocument({ blocks }: { blocks: Block[] }) {
  const { theme } = useTheme();
  const runs = (spans: Span[]) => spans.map((span, index) => (
    <Text key={index} style={[span.bold && styles.bold, span.code && styles.code]}>{span.text}</Text>
  ));
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          return (
            <Text key={index} accessibilityRole="header" style={[block.level === 2 ? styles.heading : styles.subheading, fonts.serif, { color: theme.colors.fg }]}>
              {runs(block.spans ?? [])}
            </Text>
          );
        }
        if (block.kind === 'list') {
          return (
            <View key={index} style={styles.list}>
              {(block.items ?? []).map((item, itemIndex) => (
                <View key={itemIndex} style={styles.item}>
                  <Text style={[styles.text, { color: theme.colors.fg }]}>{'•'}</Text>
                  <Text selectable style={[styles.text, styles.itemText, { color: theme.colors.fg }]}>{runs(item)}</Text>
                </View>
              ))}
            </View>
          );
        }
        return <Text key={index} selectable style={[styles.text, { color: theme.colors.fg }]}>{runs(block.spans ?? [])}</Text>;
      })}
    </>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: 22, lineHeight: 28, marginTop: 8 },
  subheading: { fontSize: 18, lineHeight: 24 },
  text: { fontSize: 16, lineHeight: 23 },
  bold: { fontWeight: '700' },
  code: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  list: { gap: 8 },
  item: { flexDirection: 'row', gap: 8 },
  itemText: { flex: 1 },
});
