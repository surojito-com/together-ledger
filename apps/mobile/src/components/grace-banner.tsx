import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { accountMessage } from '../auth/account-messages';
import { useSession } from '../auth/session';
import { GRACE_REQUESTED, graceBannerCopy, graceRequestNote, mayRequestGrace, type Grace } from '../journey/sharing-view';
import { useJourney } from '../journey/use-journey';
import { useShell } from '../shell/shell-provider';
import { useTheme } from '../theme';
import { Button } from './ui';

/**
 * The web's #grace-banner: while a journey waits on a payment, everyone in it is told who pays,
 * the time left, the weeks asked for this year and who can still add if it isn't paid (the Book,
 * 4.7). Waiting is not a failure, so it takes the caution role and never the destructive one,
 * and it stays while the grace does, with nothing to dismiss. Only the payer is offered the ask.
 */
export function GraceBanner({ journeyId, grace, peopleHere }: { journeyId: string; grace: Grace | null | undefined; peopleHere: number }) {
  const session = useSession();
  const { reload } = useJourney();
  const { showStatus, showToast } = useShell();
  const { theme } = useTheme();
  const [pending, setPending] = useState(false);
  if (!grace) return null;
  const viewerId = session.user?.id;
  const note = graceRequestNote(grace, viewerId);

  const ask = async () => {
    setPending(true);
    try {
      await session.client.requestMoreGrace(journeyId);
      await reload();
      showToast(GRACE_REQUESTED);
    } catch (error) {
      showStatus(accountMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.banner, { borderColor: theme.colors.border, borderLeftColor: theme.colors.caution, borderRadius: theme.radius.m, backgroundColor: theme.colors.surface }]}
    >
      <View style={styles.head}>
        <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.glyph, { color: theme.colors.caution }]}>▲</Text>
        <Text style={[styles.message, { color: theme.colors.fg }]}>{graceBannerCopy(grace, viewerId, peopleHere)}</Text>
      </View>
      {note ? <Text style={[styles.note, { color: theme.colors.muted }]}>{note}</Text> : null}
      {mayRequestGrace(grace, viewerId) ? <Button kind="quiet" label={`Ask for ${grace.requestDays} more days`} pending={pending} onPress={ask} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { borderWidth: 1, borderLeftWidth: 5, padding: 14, gap: 8 },
  head: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  glyph: { fontSize: 14, lineHeight: 23 },
  message: { flex: 1, fontSize: 16, lineHeight: 23 },
  note: { fontSize: 14, lineHeight: 20 },
});
