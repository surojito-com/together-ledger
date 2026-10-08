import { Platform, StyleSheet, Text, View } from 'react-native';
import {
  HISTORY_ENTRY_PARTS, HISTORY_ENTRY_PARTS_HEADING, HISTORY_EVENT_GROUPS, HISTORY_FIELDS, HISTORY_FIELDS_HEADING, HISTORY_GUIDE_INTRO,
  HISTORY_GUIDE_SECTIONS, HISTORY_GUIDE_TITLE, HISTORY_KINDS_HEADING, HISTORY_NEVER_LABEL, HISTORY_RECORDS_LABEL, HISTORY_RECORDS_NOTHING,
} from '../../../src/history-guide.js';
import { Body, Screen } from '../src/components/ui';
import { fonts, useTheme } from '../src/theme';

/**
 * "How to read your history" (#349), reached from the History intro. The words are the web's own,
 * from src/history-guide.js, so the two never say different things. It needs no journey and no
 * sign-in: it explains History, it doesn't show any.
 */
export default function HistoryGuideScreen() {
  const { theme } = useTheme();
  const heading = [styles.heading, fonts.serif, { color: theme.colors.fg }];
  const card = [styles.card, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface, borderRadius: theme.radius.m }];
  const name = [styles.code, { color: theme.colors.fg }];
  const body = [styles.body, { color: theme.colors.textSecondary }];
  const label = [styles.label, { color: theme.colors.muted }];
  return (
    <Screen title={HISTORY_GUIDE_TITLE} lead={HISTORY_GUIDE_INTRO[0]}>
      {HISTORY_GUIDE_INTRO.slice(1).map((paragraph) => <Body key={paragraph} selectable>{paragraph}</Body>)}
      {HISTORY_GUIDE_SECTIONS.map((section) => (
        <View key={section.id} style={styles.section}>
          <Text accessibilityRole="header" style={heading}>{section.heading}</Text>
          {section.paragraphs.map((paragraph) => <Body key={paragraph} selectable>{paragraph}</Body>)}
        </View>
      ))}

      <Text accessibilityRole="header" style={heading}>{HISTORY_KINDS_HEADING}</Text>
      {HISTORY_EVENT_GROUPS.map((group) => (
        <View key={group.heading} style={styles.section}>
          <Text accessibilityRole="header" style={[styles.subheading, { color: theme.colors.fg }]}>{group.heading}</Text>
          {group.kinds.map((kind) => (
            <View key={kind.action} style={card}>
              <Text selectable style={[styles.title, { color: theme.colors.fg }]}>{kind.reads.join(' / ')}</Text>
              <Text selectable style={name}>{kind.action}</Text>
              <Text selectable style={body}>{kind.when}</Text>
              <Text selectable style={body}><Text style={label}>{HISTORY_RECORDS_LABEL}: </Text>{kind.records.length ? kind.records.join(', ') : HISTORY_RECORDS_NOTHING}</Text>
              <Text selectable style={body}><Text style={label}>{HISTORY_NEVER_LABEL}: </Text>{kind.never}</Text>
            </View>
          ))}
        </View>
      ))}

      <Text accessibilityRole="header" style={heading}>{HISTORY_FIELDS_HEADING}</Text>
      {Object.entries(HISTORY_FIELDS).map(([field, meaning]) => (
        <View key={field} style={styles.term}>
          <Text selectable style={name}>{field}</Text>
          <Text selectable style={body}>{meaning}</Text>
        </View>
      ))}

      <Text accessibilityRole="header" style={heading}>{HISTORY_ENTRY_PARTS_HEADING}</Text>
      {Object.entries(HISTORY_ENTRY_PARTS).map(([part, meaning]) => (
        <View key={part} style={styles.term}>
          <Text selectable style={name}>{part}</Text>
          <Text selectable style={body}>{meaning}</Text>
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  heading: { fontSize: 22, lineHeight: 28, marginTop: 12 },
  subheading: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  card: { borderWidth: 1, padding: 14, gap: 4 },
  title: { fontSize: 16, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 22 },
  label: { fontWeight: '700' },
  code: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 14 },
  term: { gap: 2 },
});
