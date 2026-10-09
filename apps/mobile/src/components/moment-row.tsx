import { Pressable, StyleSheet, Text, View } from 'react-native';
import { compactRowLabel, dateLabel, momentLabel, normalizeMomentTheme, visibilityCue, visibilityRole, type ShownMoment } from '../journey/journey-view';
import { fonts, getTheme, targetSize, useTheme } from '../theme';
import { MomentCard } from './moment-card';

/**
 * One moment as a single short row, for the ledger's compact view (Oct 9): its title on one line,
 * its date and kind, and its visibility cue. The detail, places, photos, money, "Held by" and the
 * actions wait for the full card, which a tap opens in place, beneath the row, with the moment's
 * own Edit and Share now. Tapping the row again folds the card away.
 *
 * The cue is drawn with the title, as on the card: shape, word and border together, never colour
 * alone. A moment with its own theme keeps its own colours here too.
 */
export function MomentRow({ moment, open, onToggle, actions }: { moment: ShownMoment; open: boolean; onToggle: () => void; actions?: React.ReactNode }) {
  const app = useTheme().theme;
  const ownTheme = normalizeMomentTheme(moment.theme);
  const colors = ownTheme ? getTheme(ownTheme).colors : app.colors;
  const radius = app.radius;
  const cue = visibilityCue(moment.visibility);
  const cueColor = colors[visibilityRole(moment.visibility)];
  const background = ownTheme ? colors.bg : colors.surface;
  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={compactRowLabel(moment)}
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={({ pressed }) => [styles.row, targetSize, { backgroundColor: background, borderColor: colors.border, borderLeftColor: cueColor, borderRadius: radius.m, opacity: pressed ? 0.7 : 1 }]}
      >
        <View style={styles.copy}>
          <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.title, fonts.serif, { color: colors.fg }]}>{moment.title}</Text>
          <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.meta, { color: colors.muted }]}>{dateLabel(moment.occurredOn)} · {momentLabel(moment.kind, moment.kindLabel)}</Text>
        </View>
        <View style={[styles.chip, { borderColor: colors.border, borderRadius: radius.pill, backgroundColor: background }]}>
          <Text style={[styles.chipText, { color: cueColor }]}>
            <Text style={styles.glyph}>{cue.glyph} </Text>
            {cue.label}
          </Text>
        </View>
        <Text style={[styles.fold, { color: colors.muted }]}>{open ? '−' : '+'}</Text>
      </Pressable>
      {open ? <MomentCard moment={moment} actions={actions} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderLeftWidth: 5, paddingVertical: 9, paddingLeft: 12, paddingRight: 10 },
  copy: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 18, lineHeight: 23 },
  meta: { fontSize: 12, lineHeight: 16, fontWeight: '800', textTransform: 'uppercase' },
  chip: { borderWidth: 1, paddingHorizontal: 7, paddingVertical: 3, flexShrink: 0 },
  chipText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' },
  glyph: { fontSize: 11 },
  fold: { fontSize: 18, fontWeight: '700', width: 14, textAlign: 'center' },
});
