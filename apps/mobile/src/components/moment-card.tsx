import { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSession } from '../auth/session';
import { locationContext, momentLabel, momentThemeLabel, moneyContext, normalizeMomentTheme, visibilityCue, visibilityRole, dateLabel, type MomentImage, type ShownMoment } from '../journey/journey-view';
import { fonts, getTheme, targetSize, useTheme, type ThemeColors } from '../theme';

/**
 * One moment, as the web's .moment-card draws it (TL-M-07, #182). A moment with its own
 * atmosphere (moment.theme) is painted in that theme's colours whatever the app's theme is.
 *
 * The visibility cue is part of the card itself, drawn in the same pass as the title, so a
 * moment is never on screen without it: shape, word and border together, never colour alone.
 */
export function MomentCard({ moment, actions }: { moment: ShownMoment; actions?: React.ReactNode }) {
  const app = useTheme().theme;
  const ownTheme = normalizeMomentTheme(moment.theme);
  const colors = ownTheme ? getTheme(ownTheme).colors : app.colors;
  const radius = app.radius;
  const cue = visibilityCue(moment.visibility);
  const cueColor = colors[visibilityRole(moment.visibility)];
  const kind = momentLabel(moment.kind, moment.kindLabel);
  const places = locationContext(moment);
  const moneyNote = moneyContext(moment);
  return (
    <View style={[styles.card, { backgroundColor: ownTheme ? colors.bg : colors.surface, borderColor: colors.border, borderLeftColor: cueColor, borderRadius: radius.l }]}>
      <View style={styles.meta}>
        <Chip colors={colors} radius={radius.pill} text={kind} />
        <Text style={[styles.metaText, { color: colors.muted }]}>{dateLabel(moment.occurredOn)}</Text>
        <View accessible accessibilityLabel={`Visibility: ${cue.label}`} style={[styles.chip, { borderColor: colors.border, borderRadius: radius.pill, backgroundColor: ownTheme ? colors.bg : colors.surface }]}>
          <Text style={[styles.chipText, { color: cueColor }]}>
            <Text style={styles.glyph}>{cue.glyph} </Text>
            {cue.label}
          </Text>
        </View>
        {ownTheme ? <Chip colors={colors} radius={radius.pill} text={`${momentThemeLabel(ownTheme)} theme`} /> : null}
      </View>
      <Text style={[styles.title, fonts.serif, { color: colors.fg }]}>{moment.title}</Text>
      {moment.detail ? <Text style={[styles.detail, { color: colors.muted }]}>{moment.detail}</Text> : null}
      {places ? (
        <Text style={[styles.places, { color: colors.muted }]}>
          <Text accessibilityElementsHidden importantForAccessibility="no" style={{ color: colors.accent }}>⌖ </Text>
          {places}
        </Text>
      ) : null}
      {moment.images.length ? (
        <View style={styles.photos}>
          {moment.images.map((image) => <MomentPhoto key={image.id} image={image} moment={moment} colors={colors} radius={radius.s} />)}
        </View>
      ) : null}
      {moment.removedImages.length ? (
        <Disclosure label="Removed photo" colors={colors}>
          {moment.removedImages.map((image) => <Text key={image.id} style={[styles.detail, { color: colors.muted }]}>{image.filename || 'Image'}</Text>)}
        </Disclosure>
      ) : null}
      {moneyNote ? (
        <Disclosure label="Practical money context" colors={colors} divided>
          <Text style={[styles.detail, { color: colors.muted }]}>{moneyNote}</Text>
        </Disclosure>
      ) : null}
      <View style={styles.author}>
        <Text style={[styles.authorText, { color: colors.muted }]}>Held by {moment.createdBy || 'Journey member'}</Text>
        {moment.shapedByBoth ? (
          <View style={[styles.badge, { backgroundColor: colors.accent, borderRadius: radius.pill }]}>
            <Text style={[styles.badgeText, { color: colors.onAccent }]}>Shaped by more than one journeyer</Text>
          </View>
        ) : null}
      </View>
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  );
}

function Chip({ text, colors, radius }: { text: string; colors: ThemeColors; radius: number }) {
  return (
    <View style={[styles.chip, { borderColor: colors.border, borderRadius: radius }]}>
      <Text style={[styles.chipText, { color: colors.fg }]}>{text}</Text>
    </View>
  );
}

/** A card's own small action ("Edit", "Share now"), painted in the card's colours. */
export function CardAction({ label, onPress, colors }: { label: string; onPress: () => void; colors: ThemeColors }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.action, targetSize, { borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}>
      <Text style={[styles.actionText, { color: colors.fg }]}>{label}</Text>
    </Pressable>
  );
}

/** The colours a moment is drawn in: its own theme's, or the app's. */
export function momentColors(moment: { theme?: string | null }, appColors: ThemeColors) {
  const own = normalizeMomentTheme(moment.theme);
  return own ? getTheme(own).colors : appColors;
}

/** The web's <details>: closed until asked, with + and − as it has. */
function Disclosure({ label, colors, divided = false, children }: { label: string; colors: ThemeColors; divided?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.disclosure, divided ? { borderTopWidth: 1, borderTopColor: colors.border } : null]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={[styles.disclosureButton, targetSize]}>
        <Text style={[styles.disclosureText, { color: colors.muted }]}>{label} {open ? '−' : '+'}</Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

/**
 * A photo's preview. The list only draws the moments on screen, so a photo is fetched when its
 * moment scrolls in, not before. Opening it larger is TL-M-12 (#187).
 */
function MomentPhoto({ image, moment, colors, radius }: { image: MomentImage; moment: ShownMoment; colors: ThemeColors; radius: number }) {
  const { client } = useSession();
  const [source, setSource] = useState<{ uri: string; headers: Record<string, string> } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    client.imageSource(moment.journeyId, moment.id, image.id).then(
      (found) => { if (current) setSource(found); },
      () => { if (current) setFailed(true); },
    );
    return () => { current = false; };
  }, [client, moment.journeyId, moment.id, image.id]);
  return (
    <View style={[styles.photo, { borderColor: colors.border, borderRadius: radius }]}>
      <View style={[styles.thumb, { backgroundColor: colors.metaBg, borderRadius: 4 }]}>
        {source && !failed ? (
          <Image source={source} onError={() => setFailed(true)} accessibilityLabel={`Photo held with ${moment.title}`} style={styles.thumbImage} />
        ) : null}
      </View>
      <View style={styles.photoCopy}>
        <Text style={[styles.photoKind, { color: colors.accent }]}>Photo</Text>
        <Text numberOfLines={1} style={[styles.photoName, { color: colors.fg }]}>{image.filename || 'Image'}</Text>
        {failed ? <Text style={[styles.photoNote, { color: colors.muted }]}>Photo could not be loaded.</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderLeftWidth: 5, padding: 18 },
  meta: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 7, marginBottom: 9 },
  metaText: { fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  chip: { borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4 },
  chipText: { fontSize: 14, fontWeight: '800', letterSpacing: 0.8, textTransform: 'uppercase' },
  glyph: { fontSize: 12 },
  title: { fontSize: 25, lineHeight: 31 },
  detail: { fontSize: 16, lineHeight: 25, marginTop: 8 },
  places: { fontSize: 14, fontWeight: '800', marginTop: 13 },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  photo: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, padding: 8, maxWidth: '100%' },
  thumb: { width: 64, height: 64, overflow: 'hidden' },
  thumbImage: { width: 64, height: 64 },
  photoCopy: { flexShrink: 1, gap: 2 },
  photoKind: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase' },
  photoName: { fontSize: 15, fontWeight: '700' },
  photoNote: { fontSize: 13 },
  disclosure: { marginTop: 10 },
  disclosureButton: { justifyContent: 'center', alignItems: 'flex-start' },
  disclosureText: { fontSize: 14, fontWeight: '700' },
  author: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 14 },
  authorText: { fontSize: 14, fontWeight: '800' },
  badge: { paddingHorizontal: 9, paddingVertical: 5 },
  badgeText: { fontSize: 14, fontWeight: '800' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  action: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 14, justifyContent: 'center' },
  actionText: { fontSize: 14, fontWeight: '800' },
});
