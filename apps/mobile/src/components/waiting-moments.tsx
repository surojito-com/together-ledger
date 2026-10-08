import { StyleSheet, Text, View } from 'react-native';
import { dateLabel, momentLabel } from '../journey/journey-view';
import { useWaitingMoments } from '../journey/use-waiting-moments';
import { DISCARD_LABEL, discardConsequence, inJourney, onceSent, SEND_NOW_LABEL, TRY_AGAIN_LABEL, WAITING_CUE, WAITING_HELP, WAITING_TITLE, type WaitingMoment } from '../journey/waiting-moments';
import { useShell } from '../shell/shell-provider';
import { fonts, useTheme } from '../theme';
import { CardAction } from './moment-card';
import { Button } from './ui';

/**
 * The moments held on this phone that the service does not have yet (#352), above the ledger's
 * own. Never drawn as a moment card: a card carries its visibility cue, and a moment that is
 * waiting is not shared, whatever it will be once it is sent. Its cue is its own, in shape, word
 * and border: ▲ Waiting to send, or ▲ Not sent with the service's words when it was refused.
 */
export function WaitingMoments({ activeJourneyId }: { activeJourneyId: string }) {
  const waiting = useWaitingMoments();
  const { theme } = useTheme();
  const colors = theme.colors;
  if (!waiting.moments.length) return null;
  const sendable = waiting.moments.some((entry) => !entry.refusal);
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[styles.title, fonts.serif, { color: colors.fg }]}>{WAITING_TITLE}</Text>
      <Text style={[styles.body, { color: colors.muted }]}>{WAITING_HELP}</Text>
      {waiting.moments.map((entry) => <WaitingCard key={entry.key} entry={entry} elsewhere={entry.journeyId !== activeJourneyId} />)}
      {sendable ? <Button kind="quiet" label={SEND_NOW_LABEL} onPress={waiting.sendNow} /> : null}
    </View>
  );
}

function WaitingCard({ entry, elsewhere }: { entry: WaitingMoment; elsewhere: boolean }) {
  const waiting = useWaitingMoments();
  const shell = useShell();
  const { theme } = useTheme();
  const colors = theme.colors;
  const cue = entry.refusal ? WAITING_CUE.refused : WAITING_CUE.waiting;
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border, borderLeftColor: colors.caution, borderRadius: theme.radius.l }]}>
      <View style={styles.meta}>
        <View style={[styles.chip, { borderColor: colors.border, borderRadius: theme.radius.pill }]}>
          <Text style={[styles.chipText, { color: colors.fg }]}>{momentLabel(entry.moment.kind, entry.moment.kindLabel)}</Text>
        </View>
        <Text style={[styles.metaText, { color: colors.muted }]}>{dateLabel(entry.moment.occurredOn)}</Text>
        <View accessible accessibilityLabel={cue} style={[styles.chip, { borderColor: colors.caution, borderRadius: theme.radius.pill }]}>
          <Text style={[styles.chipText, { color: colors.caution }]}>
            <Text style={styles.glyph}>{WAITING_CUE.glyph} </Text>
            {cue}
          </Text>
        </View>
      </View>
      <Text style={[styles.cardTitle, fonts.serif, { color: colors.fg }]}>{entry.moment.title}</Text>
      {elsewhere && entry.journeyName ? <Text style={[styles.body, { color: colors.muted }]}>{inJourney(entry.journeyName)}</Text> : null}
      <Text style={[styles.body, { color: colors.muted }]}>{onceSent(entry.moment.visibility)}</Text>
      {entry.refusal ? (
        <>
          <Text accessibilityLiveRegion="polite" style={[styles.refusal, { color: colors.fg }]}>{entry.refusal.message}</Text>
          <View style={styles.actions}>
            <CardAction label={TRY_AGAIN_LABEL} colors={colors} onPress={() => waiting.retry(entry.key)} />
            <CardAction label={DISCARD_LABEL} colors={colors} onPress={async () => {
              if (await shell.confirmConsequence(discardConsequence(entry))) await waiting.discard(entry.key);
            }} />
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10, marginTop: 8 },
  title: { fontSize: 20, lineHeight: 26 },
  body: { fontSize: 15, lineHeight: 22 },
  card: { borderWidth: 1, borderLeftWidth: 5, padding: 16, gap: 6 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7 },
  metaText: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  chip: { borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4 },
  chipText: { fontSize: 14, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  glyph: { fontSize: 12 },
  cardTitle: { fontSize: 22, lineHeight: 28 },
  refusal: { fontSize: 15, lineHeight: 22, fontWeight: '700' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
});
