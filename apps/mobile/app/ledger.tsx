import { router } from 'expo-router';
import { useState } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSession } from '../src/auth/session';
import { LEDGER_WHILE_OFFLINE, type OfflineReason } from '../src/auth/session-state';
import { Choices } from '../src/components/choices';
import { EmptyState } from '../src/components/empty-state';
import { GraceBanner } from '../src/components/grace-banner';
import { CardAction, MomentCard, momentColors } from '../src/components/moment-card';
import { MomentRow } from '../src/components/moment-row';
import { ScreenStatusRegion } from '../src/components/status-region';
import { Body, Button, Screen } from '../src/components/ui';
import { INVITATION_WORDS } from '../src/invitations/invitation-words';
import { journeyPeriod, momentFilters, momentListHeading, momentListing, MOMENT_TYPES, MOMENT_VIEW_LABEL, MOMENT_VIEWS, openThreads, recentMoments, seeAllLabel, type Concern, type Journey } from '../src/journey/journey-view';
import { useMomentActions } from '../src/journey/moment-actions';
import type { EditableMoment } from '../src/journey/moment-draft';
import { JOURNEYS_NOT_LOADED, nextJourneyWords } from '../src/journey/journey-state';
import { useJourney } from '../src/journey/use-journey';
import { useMomentView } from '../src/journey/use-moment-view';
import { WaitingMoments } from '../src/components/waiting-moments';
import type { MomentView } from '../src/storage/ledger-store';
import { fonts, useTheme } from '../src/theme';

/**
 * The ledger surface: the open journey and its moments (TL-M-07, #182), ported from the web's
 * render() and renderSharedJourney(). Holding, editing and sharing a moment is #183, in app/moment.tsx.
 */
export default function LedgerScreen() {
  const session = useSession();
  const journey = useJourney();
  const actions = useMomentActions();
  const { theme } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState('all');
  const momentView = useMomentView();
  // The compact rows opened to their full card; folded again on a second tap.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const { state } = journey;

  if (state.phase === 'loading') return <Screen title="Our ledger"><Body>Loading…</Body></Screen>;
  // Signed in, but the service could not be asked (#352): never the sign-in prompt below. A first
  // load the connection stopped is drawn the same, and no failure is ever a bare Try again.
  if (state.phase === 'offline') return <LedgerWhileOffline reason={state.reason} onRetry={session.refresh} />;
  if (state.phase === 'failed') {
    if (state.reason) return <LedgerWhileOffline reason={state.reason} onRetry={journey.retry} />;
    return (
      <Screen title="Our ledger">
        {/* Why is in the status region above, in the service's own words. */}
        <Body>{JOURNEYS_NOT_LOADED}</Body>
        <WaitingMoments activeJourneyId={null} />
        <Button kind="quiet" label="Try again" onPress={journey.retry} />
      </Screen>
    );
  }
  if (state.phase === 'signed-out' || state.phase === 'no-journeys') return <EmptyStart signedIn={state.phase === 'no-journeys'} />;

  const { snapshot, journeys, activeId, next } = state;
  const nextName = next ? journeys.find((item) => item.id === next.journeyId)?.name : null;
  const recent = recentMoments(snapshot);
  const filters = momentFilters(recent);
  const currentFilter = filters.some(([value]) => value === filter) ? filter : 'all';
  const compact = momentView.view === 'compact';
  const listing = momentListing(recent, { compact, expanded, filter: currentFilter });
  const shown = listing.shown;
  const threads = openThreads(snapshot);
  const colors = theme.colors;
  const toggle = (id: string) => setOpened((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.fill, { backgroundColor: colors.bg }]}>
      <FlatList
        data={shown}
        keyExtractor={(moment) => moment.id}
        extraData={{ compact, opened }}
        renderItem={({ item }) => {
          const cardColors = momentColors(item, colors);
          const cardActions = (
            <>
              {item.visibility === 'share-later' ? <CardAction label="Share now" colors={cardColors} onPress={() => actions.share(item as EditableMoment)} /> : null}
              <CardAction label="Edit" colors={cardColors} onPress={() => router.push({ pathname: '/moment', params: { id: item.id } })} />
            </>
          );
          return compact
            ? <MomentRow moment={item} open={opened.has(item.id)} onToggle={() => toggle(item.id)} actions={cardActions} />
            : <MomentCard moment={item} actions={cardActions} />;
        }}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={compact ? styles.rowGap : styles.gap} />}
        refreshControl={<RefreshControl refreshing={journey.refreshing} onRefresh={journey.refresh} tintColor={colors.accent} colors={[colors.accent]} />}
        ListHeaderComponent={
          <View style={styles.header}>
            <ScreenStatusRegion />
            <View>
              <Text style={[styles.small, { color: colors.muted }]}>Your shared space</Text>
              <Text accessibilityRole="header" style={[styles.journeyName, fonts.serif, { color: colors.fg }]}>{snapshot.journey.name}</Text>
              <Text style={[styles.body, { color: colors.muted }]}>{journeyPeriod(snapshot.journey)}</Text>
            </View>
            <GraceBanner journeyId={snapshot.journey.id} grace={snapshot.capacity?.grace} peopleHere={snapshot.capacity?.peopleHere ?? 0} />
            {journeys.length > 1 ? <JourneyPicker journeys={journeys} activeId={activeId} onSelect={(id) => { setExpanded(false); setFilter('all'); setOpened(new Set()); journey.select(id); }} /> : null}
            {/* The open journey stays while another is asked for; offline, it opens once the connection is back (#352). */}
            {next && nextName ? <Text accessibilityLiveRegion="polite" style={[styles.body, { color: colors.muted }]}>{nextJourneyWords(nextName, next.when)}</Text> : null}
            <Button kind="quiet" label="＋ New journey" onPress={() => router.push('/new-journey')} />
            <View style={styles.section}>
              <Text style={[styles.eyebrow, { color: colors.accent }]}>Our shared journey</Text>
              <Text accessibilityRole="header" style={[styles.sectionTitle, fonts.serif, { color: colors.fg }]}>{momentListHeading(compact)}</Text>
              <Text style={[styles.body, { color: colors.muted }]}>Hold what happened in words that feel true.</Text>
            </View>
            <Button label="＋ Hold a moment" onPress={() => router.push('/moment')} />
            <WaitingMoments activeJourneyId={activeId} />
            {/* Above "See all" and the filter, so it stays put under the thumb when Compact brings the filter in. */}
            {recent.length ? (
              <View style={styles.viewChoice}>
                <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.small, { color: colors.muted }]}>{MOMENT_VIEW_LABEL}</Text>
                <Choices label={MOMENT_VIEW_LABEL} options={MOMENT_VIEWS} selected={momentView.view} onSelect={(value) => momentView.setView(value as MomentView)} />
              </View>
            ) : null}
            {listing.seeAll ? <Button kind="quiet" label={expanded ? 'Show recent' : seeAllLabel(recent.length)} onPress={() => setExpanded(!expanded)} /> : null}
            {listing.filter ? <Choices label="Moment types" options={filters} selected={currentFilter} onSelect={setFilter} /> : null}
          </View>
        }
        ListEmptyComponent={<EmptyState title="No moments in this view" body="A small truth is enough to begin, or choose another filter to see more." />}
        ListFooterComponent={<Threads threads={threads} />}
      />
    </SafeAreaView>
  );
}

/**
 * Signed in, with no journey this phone can show (#352, #360): opened offline, or a first load the
 * connection stopped. What was held here and not sent yet is still in sight, with Try sending now.
 */
function LedgerWhileOffline({ reason, onRetry }: { reason: OfflineReason; onRetry: () => void }) {
  return (
    <Screen title="Our ledger">
      <Body>{LEDGER_WHILE_OFFLINE[reason]}</Body>
      {/* What this account held and the service doesn't have yet: kept, not lost (#352). */}
      <WaitingMoments activeJourneyId={null} />
      <Button kind="quiet" label="Try again" onPress={onRetry} />
    </Screen>
  );
}

/** The web's journey select, as a row of choices a thumb can reach. */
function JourneyPicker({ journeys, activeId, onSelect }: { journeys: Journey[]; activeId: string; onSelect: (id: string) => void }) {
  return <Choices label="Journey" options={journeys.map((item) => [item.id, item.name])} selected={activeId} onSelect={onSelect} />;
}

function Threads({ threads }: { threads: Concern[] }) {
  const { theme } = useTheme();
  const colors = theme.colors;
  return (
    <View style={[styles.threads, { borderColor: colors.border, borderRadius: theme.radius.l, backgroundColor: colors.surface }]}>
      <Text style={[styles.eyebrow, { color: colors.accent }]}>What wants care</Text>
      <Text accessibilityRole="header" style={[styles.sectionTitle, fonts.serif, { color: colors.fg }]}>Return-to conversations</Text>
      <Text style={[styles.body, { color: colors.muted }]}>A place to hold something you want to come back to together.</Text>
      {threads.length ? threads.map((thread) => (
        <View key={thread.id} style={[styles.thread, { borderTopColor: colors.border }]}>
          <Text style={[styles.openChip, { color: colors.caution, borderColor: colors.caution, borderRadius: theme.radius.pill }]}>open</Text>
          <Text style={[styles.threadTitle, { color: colors.fg }]}>{thread.title}</Text>
          {thread.detail ? <Text style={[styles.body, { color: colors.muted }]}>{thread.detail}</Text> : null}
        </View>
      )) : <EmptyState compact title="No open threads" body="That can be a good place to rest." />}
    </View>
  );
}

/** Before there is a journey: the web's empty start, which says what can live here. */
function EmptyStart({ signedIn }: { signedIn: boolean }) {
  const { theme } = useTheme();
  const colors = theme.colors;
  const kinds = (MOMENT_TYPES as [string, string][]).filter(([value]) => value !== 'other');
  return (
    <Screen title="Our ledger">
      <Text style={[styles.eyebrow, { color: colors.accent }]}>A place to begin</Text>
      <Text accessibilityRole="header" style={[styles.sectionTitle, fonts.serif, { color: colors.fg }]}>What can live here?</Text>
      <Body>A ledger can hold the things you want to remember, name, or return to. It begins empty.</Body>
      <View style={[styles.types, { backgroundColor: colors.metaBg, borderColor: colors.border, borderRadius: theme.radius.l }]}>
        <Text style={[styles.body, { color: colors.muted }]}>There are no examples here—only possibilities:</Text>
        <View style={styles.kinds}>
          {kinds.map(([value, label]) => (
            <Text key={value} style={[styles.type, { color: colors.fg, borderColor: colors.border, backgroundColor: colors.surface, borderRadius: theme.radius.pill }]}>{label}</Text>
          ))}
        </View>
      </View>
      {signedIn ? (
        <>
          <Body>Account ready. Create your first private journey.</Body>
          <Button label="＋ New journey" onPress={() => router.push('/new-journey')} />
        </>
      ) : (
        <>
          <Body>Your private journeys appear here once you sign in on this phone.</Body>
          <Button label="Sign in" onPress={() => router.push('/account')} />
        </>
      )}
      {/* Joining someone else's journey begins with their invitation (#266). */}
      <Button kind="quiet" label={INVITATION_WORDS.haveOne} onPress={() => router.push('/invite')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { padding: 24, gap: 0 },
  gap: { height: 14 },
  rowGap: { height: 8 },
  viewChoice: { gap: 8 },
  header: { gap: 16, marginBottom: 16 },
  small: { fontSize: 13, fontWeight: '700' },
  journeyName: { fontSize: 32, lineHeight: 38 },
  body: { fontSize: 16, lineHeight: 23 },
  section: { gap: 6, marginTop: 8 },
  eyebrow: { fontSize: 12, fontWeight: '900', letterSpacing: 1.9, textTransform: 'uppercase' },
  sectionTitle: { fontSize: 28, lineHeight: 34 },
  threads: { borderWidth: 1, padding: 20, gap: 6, marginTop: 24 },
  thread: { borderTopWidth: 1, paddingVertical: 17, gap: 6 },
  openChip: { alignSelf: 'flex-start', borderWidth: 1, fontSize: 12, fontWeight: '900', letterSpacing: 1, paddingHorizontal: 8, paddingVertical: 4, textTransform: 'uppercase', overflow: 'hidden' },
  threadTitle: { fontSize: 17, fontWeight: '700' },
  types: { borderWidth: 1, padding: 22, gap: 16 },
  kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  type: { borderWidth: 1, fontSize: 14, fontWeight: '800', paddingHorizontal: 12, paddingVertical: 9, overflow: 'hidden' },
});
