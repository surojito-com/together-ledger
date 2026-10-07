import { Platform, StyleSheet, Text, View } from 'react-native';
import policy from '../src/policies/privacy.json';
import { Body, Screen } from '../src/components/ui';
import { fonts, useTheme } from '../src/theme';

type Span = { text: string; bold?: boolean; code?: boolean };

/**
 * The privacy policy, on the phone itself. Both stores ask that it can be read from inside the
 * app. It is PRIVACY.md, generated into privacy.json by scripts/mobile-policies.mjs with the same
 * parse as the web's /privacy page, so the two never say different things. It is shown here
 * rather than opened in a browser, because the phone opens no web page (#268); a link in the
 * policy reads as its words. Reachable from Settings whether or not anyone is signed in.
 */
export default function PrivacyScreen() {
  const { theme } = useTheme();
  const runs = (spans: Span[]) => spans.map((span, index) => (
    <Text key={index} style={[span.bold && styles.bold, span.code && styles.code]}>{span.text}</Text>
  ));
  return (
    <Screen title={policy.title}>
      {policy.blocks.map((block, index) => {
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
      <Body selectable>Questions about this policy, or a request about your data: legal@together-ledger.com.</Body>
    </Screen>
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
