import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSession } from '../src/auth/session';
import { extrasFor } from '../src/billing/store-products';
import { Choices } from '../src/components/choices';
import { DateField } from '../src/components/date-field';
import { DropDown } from '../src/components/drop-down';
import { MomentCard } from '../src/components/moment-card';
import { MomentExtras } from '../src/components/store-offers';
import { Body, Button, Field, Screen } from '../src/components/ui';
import { MOMENT_THEMES, MOMENT_TYPES, momentThemeLabel, normalizeMomentTheme, VISIBILITY_CUES, visibilityRole, type ShownMoment } from '../src/journey/journey-view';
import { useMomentActions } from '../src/journey/moment-actions';
import { addPlace, CURRENCIES, CURRENCY_LABEL, DELETE_ZONE_NOTE, DELETE_ZONE_TITLE, draftFrom, draftProblem, MOMENT_NAME_MISSING, removePlace, visibilityHelp, visibilityLocked, type Draft, type EditableMoment } from '../src/journey/moment-draft';
import { useJourney } from '../src/journey/use-journey';
import { useShell } from '../src/shell/shell-provider';
import { fonts, getTheme, targetSize, useTheme } from '../src/theme';

/**
 * Hold a moment, or change one (TL-M-08, #183): the web's moment dialog (index.html,
 * openMoment() in src/app.js), with its words. The preview at the foot of the form is the card
 * itself, so a theme and a visibility are chosen by seeing exactly how the moment will look.
 */
export default function MomentScreen() {
  const { id, kind } = useLocalSearchParams<{ id?: string; kind?: string }>();
  const journey = useJourney();
  const session = useSession();
  const shell = useShell();
  const actions = useMomentActions();
  const navigation = useNavigation();
  const { theme } = useTheme();
  const colors = theme.colors;
  // The moment as it was when the form opened, version and all, held for as long as the form
  // is open: an edit is always sent from the version it began from, so a newer change made
  // elsewhere comes back as a conflict instead of being written over.
  const [before] = useState<EditableMoment | null>(() => (journey.state.phase === 'ready' && id
    ? (journey.state.snapshot.moments.find((moment) => moment.id === id) as EditableMoment | undefined) ?? null
    : null));
  const [draft, setDraft] = useState<Draft>(() => draftFrom(before, { kind }));
  const [place, setPlace] = useState('');
  const [pending, setPending] = useState<'save' | 'delete' | null>(null);
  // An empty name is told at the field itself, and the form takes the person there (#354).
  const [titleProblem, setTitleProblem] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  const titleInput = useRef<TextInput>(null);
  const titleTop = useRef(0);
  const set = (change: Partial<Draft>) => setDraft((current) => ({ ...current, ...change }));

  useLayoutEffect(() => {
    navigation.setOptions({ title: before ? 'Edit this moment' : 'Hold a moment' });
  }, [navigation, before]);

  // A problem with this form leaves with it, as a problem raised in a web dialog does.
  const { clearStatus } = shell;
  useEffect(() => () => clearStatus('moment'), [clearStatus]);

  if (journey.state.phase !== 'ready' || (id && !before)) {
    return (
      <Screen title="Hold a moment">
        <Body>{id ? 'This moment is no longer here. It may have been deleted on another device.' : 'Open a journey first, then hold a moment in it.'}</Body>
        <Button kind="quiet" label="Back to the ledger" onPress={() => router.back()} />
      </Screen>
    );
  }

  async function save() {
    const problem = draftProblem(draft);
    if (problem === MOMENT_NAME_MISSING) {
      // Not the status region, which brings the top of the form into view: the field may be far
      // below it, so the words go on the field and the form scrolls to it instead.
      shell.clearStatus('moment');
      setTitleProblem(problem);
      scroll.current?.scrollTo({ y: Math.max(0, titleTop.current - 16), animated: true });
      titleInput.current?.focus();
      return;
    }
    if (problem) {
      shell.showStatus(problem, { source: 'moment' });
      return;
    }
    setPending('save');
    try {
      await actions.save(draft, before);
    } finally {
      setPending(null);
    }
  }

  async function remove() {
    if (!before) return;
    setPending('delete');
    try {
      await actions.remove(before);
    } finally {
      setPending(null);
    }
  }

  const preview: ShownMoment = {
    id: 'preview',
    journeyId: journey.state.activeId,
    kind: draft.kind,
    kindLabel: draft.kindLabel,
    occurredOn: draft.occurredOn,
    title: draft.title.trim() || 'A moment worth holding',
    detail: draft.detail.trim() || 'The theme stays with this card. The page around it stays yours.',
    visibility: draft.visibility,
    theme: draft.theme,
    moneyCents: draft.money.trim() === '' || !Number.isFinite(Number(draft.money)) ? null : Math.round(Number(draft.money) * 100),
    moneyCurrency: draft.moneyCurrency,
    locations: draft.locations,
    createdBy: before?.createdBy || (session.status === 'signed-in' ? session.user.displayName || session.user.username : 'Journey member'),
    shapedByBoth: before?.shapedByBoth,
    updatedAt: '',
    images: [],
    removedImages: [],
  };

  return (
    <Screen scrollRef={scroll} title={before ? 'Edit this moment' : 'Hold a moment'} lead="Choose whether this stays with you, is shared now, or waits until you are ready.">
      <Section title="Kind of moment" help="Choose a suggestion, or make one your own.">
        <Choices label="Kind of moment" options={MOMENT_TYPES as [string, string][]} selected={draft.kind} onSelect={(value) => set({ kind: value })} />
      </Section>
      {draft.kind === 'other' ? <Field label="Name this kind of moment" value={draft.kindLabel} onChangeText={(value) => set({ kindLabel: value })} limit={60} placeholder="e.g. A small win" /> : null}
      <DateField label="When" hint="Year, month and day, such as 2026-09-30." value={draft.occurredOn} onChange={(value) => set({ occurredOn: value })} />
      <View onLayout={(event) => { titleTop.current = event.nativeEvent.layout.y; }}>
        <Field
          ref={titleInput}
          label="A short name"
          value={draft.title}
          onChangeText={(value) => {
            set({ title: value });
            if (value.trim()) setTitleProblem(null);
          }}
          limit={120}
          placeholder="e.g. A quiet apology after dinner"
          problem={titleProblem}
        />
      </View>
      <Field label="What would you like to hold? (Optional)" value={draft.detail} onChangeText={(value) => set({ detail: value })} maxLength={1200} multiline placeholder="Use your own words. Keep it simple and kind." style={styles.detail} />

      <Section title="Moment theme (Optional)" help="Use your theme, or choose one calm card treatment that every journeyer will see.">
        <View accessibilityRole="radiogroup" accessibilityLabel="Moment theme" style={styles.options}>
          {[{ id: '', label: 'Use my theme' }, ...MOMENT_THEMES].map((option) => {
            const active = normalizeMomentTheme(draft.theme) === option.id;
            const swatch = option.id ? getTheme(option.id).colors : colors;
            return (
              <Pressable
                key={option.id || 'mine'}
                accessibilityRole="radio"
                accessibilityState={{ checked: active }}
                onPress={() => set({ theme: option.id })}
                style={({ pressed }) => [styles.option, targetSize, { borderColor: active ? colors.accent : colors.border, borderRadius: theme.radius.m, backgroundColor: colors.surface, opacity: pressed ? 0.7 : 1 }]}
              >
                <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.swatch, { backgroundColor: swatch.bg, borderColor: swatch.border }]}>
                  <View style={[styles.swatchInner, { backgroundColor: swatch.metaBg }]} />
                </View>
                <Text style={[styles.optionText, { color: colors.fg }]}>{active ? '● ' : ''}{option.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </Section>

      {/* No web price and no web add-on here, unlike the web's form (#268). If a moment has no
          room for another place, the save says so in the phone's own words. */}
      <Section title="Places (Optional)" help="Add only what helps tell the story.">
        <Field label="Enter a place" value={place} onChangeText={setPlace} limit={120} placeholder="Enter a place in your own words" onSubmitEditing={() => addTyped()} returnKeyType="done" />
        <Button kind="quiet" label="Add place" onPress={addTyped} />
        {draft.locations.map((location, index) => (
          <View key={`${index}-${location.label}`} style={[styles.place, { borderColor: colors.border, borderRadius: theme.radius.s }]}>
            <View style={styles.placeCopy}>
              <Text style={[styles.placeLabel, { color: colors.fg }]}>{location.label}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${location.label}`} onPress={() => set({ locations: removePlace(draft.locations, index) })} style={[styles.remove, targetSize, { borderColor: colors.border, borderRadius: theme.radius.pill }]}>
              <Text style={[styles.removeText, { color: colors.fg }]}>Remove</Text>
            </Pressable>
          </View>
        ))}
      </Section>

      <Section title="Visibility" help={visibilityHelp(before)}>
        <View accessibilityRole="radiogroup" accessibilityLabel="Visibility" style={styles.options}>
          {(['private', 'shared-now', 'share-later'] as const).map((value) => {
            const cue = VISIBILITY_CUES[value];
            const active = draft.visibility === value;
            const locked = visibilityLocked(before, value);
            const cueColor = colors[visibilityRole(value)];
            return (
              <Pressable
                key={value}
                accessibilityRole="radio"
                accessibilityState={{ checked: active, disabled: locked }}
                disabled={locked}
                onPress={() => set({ visibility: value })}
                style={({ pressed }) => [styles.visibility, targetSize, { borderColor: active ? cueColor : colors.border, borderLeftColor: cueColor, borderRadius: theme.radius.m, backgroundColor: colors.surface, opacity: locked ? 0.45 : pressed ? 0.7 : 1 }]}
              >
                <Text style={[styles.optionText, { color: cueColor }]}>
                  <Text style={styles.glyph}>{cue.glyph} </Text>
                  {cue.label}
                </Text>
                {active ? <Text style={[styles.chosen, { color: colors.muted }]}>Chosen</Text> : null}
              </Pressable>
            );
          })}
        </View>
      </Section>

      <Section title="Practical money context (Optional; never counted as a score)">
        <Field label="Amount (optional)" value={draft.money} onChangeText={(value) => set({ money: value })} keyboardType="decimal-pad" />
        <DropDown label={CURRENCY_LABEL} options={CURRENCIES} selected={draft.moneyCurrency} onSelect={(value) => set({ moneyCurrency: value })} />
      </Section>

      <Section title="Live preview" help={`${momentThemeLabel(draft.theme)} · exactly as this moment will appear in the ledger.`}>
        <MomentCard moment={preview} />
      </Section>

      {/* An extra place is bought for a moment that has been held, so the purchase can name it,
          once the moment holds its free first place and the server counts a paid one. */}
      {before ? (
        <MomentExtras
          journeyId={journey.state.activeId}
          momentId={before.id}
          offered={extrasFor({ locations: before.locations }, journey.state.snapshot.extras)}
        />
      ) : null}

      <Button label={before ? 'Save moment' : 'Hold this moment'} pending={pending === 'save'} disabled={pending !== null} onPress={save} />
      <Button kind="quiet" label="Cancel" disabled={pending !== null} onPress={() => router.back()} />

      {/* Deleting sits apart from Save and Cancel, in its own marked box at the foot of the form,
          and says what it does before it is tapped (#338). The button opens the consequence
          dialog, so it takes two deliberate taps. The destructive colour stays: it can't be undone. */}
      {before ? (
        <View style={[styles.dangerZone, { borderColor: colors.destructive, borderRadius: theme.radius.l, backgroundColor: colors.surface }]}>
          <Text accessibilityRole="header" style={[styles.sectionTitle, fonts.serif, { color: colors.fg }]}>{DELETE_ZONE_TITLE}</Text>
          <Text style={[styles.help, { color: colors.muted }]}>{DELETE_ZONE_NOTE}</Text>
          <Button kind="destructive" label="Delete moment" pending={pending === 'delete'} disabled={pending !== null} onPress={remove} />
        </View>
      ) : null}
    </Screen>
  );

  function addTyped() {
    const next = addPlace(draft.locations, place);
    if (next.problem) {
      shell.showToast(next.problem);
      return;
    }
    set({ locations: next.locations });
    setPlace('');
  }
}

function Section({ title, help, children }: { title: string; help?: string; children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[styles.sectionTitle, fonts.serif, { color: theme.colors.fg }]}>{title}</Text>
      {help ? <Text style={[styles.help, { color: theme.colors.muted }]}>{help}</Text> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 10, marginTop: 8 },
  sectionTitle: { fontSize: 20, lineHeight: 26 },
  help: { fontSize: 14, lineHeight: 20 },
  detail: { minHeight: 120, textAlignVertical: 'top' },
  options: { gap: 8 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8 },
  optionText: { fontSize: 16, fontWeight: '700', flex: 1 },
  swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  swatchInner: { width: 14, height: 14, borderRadius: 7 },
  visibility: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderLeftWidth: 5, paddingHorizontal: 14, paddingVertical: 10 },
  glyph: { fontSize: 14 },
  chosen: { fontSize: 13, fontWeight: '700' },
  place: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, padding: 10 },
  placeCopy: { flex: 1, gap: 2 },
  placeLabel: { fontSize: 16, fontWeight: '700' },
  remove: { borderWidth: 1, paddingHorizontal: 14, justifyContent: 'center' },
  removeText: { fontSize: 14, fontWeight: '800' },
  dangerZone: { gap: 10, marginTop: 40, borderWidth: 1, padding: 16 },
});
