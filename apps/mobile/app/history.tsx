import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { accountMessage } from '../src/auth/account-messages';
import { useSession } from '../src/auth/session';
import { Body, Button, Screen } from '../src/components/ui';
import { CONSEQUENCES, concernsByRecency, dateTimeLabel, historyEvents, valueLabel, type ConcernRecord, type SharingSnapshot } from '../src/journey/sharing-view';
import { useJourney } from '../src/journey/use-journey';
import { useShell } from '../src/shell/shell-provider';
import { targetSize, useTheme } from '../src/theme';

/**
 * The web's event manager (renderEventManager): conversations to return to, then the journey's
 * append-only, account-attributed history, newest first (TL-M-09, #184).
 */
export default function HistoryScreen() {
  const session = useSession();
  const { state } = useJourney();
  if (session.status !== 'signed-in' || state.phase !== 'ready') return <Screen title="History"><Body>Sign in and open a journey to see its history.</Body></Screen>;
  return <History snapshot={state.snapshot as unknown as SharingSnapshot} />;
}

function History({ snapshot }: { snapshot: SharingSnapshot }) {
  const { theme } = useTheme();
  const { client } = useSession();
  const { reload } = useJourney();
  const { confirmConsequence, showStatus, showToast } = useShell();
  const [pending, setPending] = useState<string | null>(null);
  const concerns = concernsByRecency(snapshot.concerns);
  const events = historyEvents(snapshot);

  const remove = async (concern: ConcernRecord) => {
    if (!await confirmConsequence(CONSEQUENCES.deleteConcern(concern.title))) return;
    setPending(concern.id);
    try {
      await client.deleteConcern(snapshot.journey.id, concern.id, concern.version);
      await reload();
      showToast('Conversation deleted. The history keeps a tombstone.');
    } catch (error) {
      showStatus(accountMessage(error));
    } finally {
      setPending(null);
    }
  };

  return (
    <Screen title={`${snapshot.journey.name} history`} lead="Server-authoritative, account-attributed history. HMAC chaining makes database changes detectable; deleted records retain privacy-bounded tombstones.">
      <Text accessibilityRole="header" style={[styles.section, { color: theme.colors.fg }]}>Return-to conversations</Text>
      <Button label="Start a return-to conversation" onPress={() => router.push('/concern')} />
      {concerns.length ? concerns.map((concern) => (
        <View key={concern.id} style={[styles.card, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface, borderRadius: theme.radius.m }]}>
          <Text style={[styles.chip, { color: theme.colors.muted }]}>{concern.status === 'open' ? 'Open' : 'Resolved'}</Text>
          <Text style={[styles.title, { color: theme.colors.fg }]}>{concern.title}</Text>
          {concern.detail ? <Text style={[styles.body, { color: theme.colors.textSecondary }]}>{concern.detail}</Text> : null}
          <Text style={[styles.meta, { color: theme.colors.muted }]}>Updated {dateTimeLabel(concern.updatedAt)}</Text>
          <View style={styles.actions}>
            <Button kind="quiet" label="Edit" onPress={() => router.push({ pathname: '/concern', params: { id: concern.id } })} />
            <Button kind="quiet" label="Delete" pending={pending === concern.id} onPress={() => remove(concern)} />
          </View>
        </View>
      )) : <Body>Nothing to return to yet. Conversations you want to come back to together will appear here.</Body>}

      <Text accessibilityRole="header" style={[styles.section, { color: theme.colors.fg }]}>Recorded changes</Text>
      {events.length ? events.map((event) => <EventRow key={event.id} event={event} />) : <Body>No recorded changes yet. Changes appear here as they happen. Activity from before the Event Manager began cannot be reconstructed.</Body>}
    </Screen>
  );
}

function EventRow({ event }: { event: ReturnType<typeof historyEvents>[number] }) {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.card, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface, borderRadius: theme.radius.m }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} style={[targetSize, styles.eventHead]}>
        <View style={styles.eventText}>
          <Text style={[styles.title, { color: theme.colors.fg }]}>#{event.sequence} · {event.summary}</Text>
          <Text style={[styles.meta, { color: theme.colors.muted }]}>{event.actorName} · {dateTimeLabel(event.createdAt)}</Text>
        </View>
        <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.toggle, { color: theme.colors.accent }]}>{open ? '−' : '＋'}</Text>
      </Pressable>
      {open ? (
        <View style={styles.detail}>
          {event.changes.length ? event.changes.map(({ key, before, after }) => (
            <Text key={key} style={[styles.body, { color: theme.colors.textSecondary }]}>
              <Text style={{ fontWeight: '700', color: theme.colors.fg }}>{key}</Text> {valueLabel(key, before)} → {valueLabel(key, after)}
            </Text>
          )) : <Text style={[styles.body, { color: theme.colors.textSecondary }]}>No field-level value change was stored for this event.</Text>}
          <Text style={[styles.meta, { color: theme.colors.muted }]}>
            Event ID {event.id} · Previous {event.previousEventId || 'none'} · server-authoritative{event.eventHash ? ` · Hash ${event.eventHash.slice(0, 12)}…` : ''}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 18, fontWeight: '700', marginTop: 8 },
  card: { borderWidth: 1, padding: 14, gap: 4 },
  chip: { fontSize: 12, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase' },
  title: { fontSize: 16, fontWeight: '700' },
  body: { fontSize: 15, lineHeight: 22 },
  meta: { fontSize: 13, lineHeight: 18 },
  actions: { gap: 8, marginTop: 8 },
  eventHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  eventText: { flex: 1, gap: 2 },
  toggle: { fontSize: 20, fontWeight: '700' },
  detail: { gap: 6, marginTop: 6 },
});
