/**
 * What the phone's ledger shows, and how, for TL-M-07 (#182). Ported from the web's
 * renderSharedJourney(), journeyPeriod(), momentLabel() and visibilityCue() in src/app.js.
 *
 * Dates, money and the moment types come from the web's own src/model.js, imported rather than
 * copied, so a date or an amount can never read differently on the phone.
 */
import { countOf, dateLabel, money, MOMENT_TYPES, RECENT_MOMENTS_SHOWN, seeAllShown } from '../../../../src/model.js';
import { MOMENT_THEMES, momentThemeLabel, normalizeMomentTheme } from '../../../../src/moment-themes.js';
import type { MomentView } from '../storage/ledger-store';
import type { Grace } from './sharing-view';

export { dateLabel, money, MOMENT_THEMES, MOMENT_TYPES, momentThemeLabel, normalizeMomentTheme, seeAllShown };

export type Visibility = 'private' | 'share-later' | 'shared-now';

export type Journey = {
  id: string;
  name: string;
  location?: string | null;
  startDate?: string | null;
  startDateStatus?: string;
  endDate?: string | null;
  endDateStatus?: string;
};

export type MomentImage = { id: string; momentId: string; filename: string; deletedAt: string | null };

export type Moment = {
  id: string;
  journeyId: string;
  kind: string;
  kindLabel?: string | null;
  occurredOn: string;
  title: string;
  detail?: string | null;
  visibility: string;
  theme?: string | null;
  moneyCents?: number | null;
  moneyCurrency?: string;
  locations?: { label: string }[];
  createdBy?: string;
  shapedByBoth?: boolean;
  version?: number;
  updatedAt: string;
};

export type Concern = { id: string; title: string; detail?: string | null; status: string };

// inviteProposals is what the service already sends and the sharing screen already reads; naming
// it here lets the ledger's chrome count what is waiting without casting the whole snapshot.
/** What the ledger needs of the capacity answer: the grace banner's facts (see sharing-view.ts). */
export type SnapshotCapacity = { peopleHere: number; grace?: Grace | null };

export type Snapshot = { journey: Journey; moments: Moment[]; images?: MomentImage[]; concerns: Concern[]; inviteProposals?: { viewerMayDecide?: boolean }[]; capacity?: SnapshotCapacity; extras?: { place?: boolean } };

/** A moment as the list draws it: its photos, and its removed photos, already attached. */
export type ShownMoment = Moment & { images: MomentImage[]; removedImages: MomentImage[] };

// Visibility is carried by shape as well as colour and word: an empty ring holds nothing
// out, a half ring is meant for later, a full ring is out. The web's exact cues.
export const VISIBILITY_CUES: Readonly<Record<Visibility, { glyph: string; label: string }>> = Object.freeze({
  private: { glyph: '○', label: 'Private' },
  'share-later': { glyph: '◐', label: 'Share later' },
  'shared-now': { glyph: '●', label: 'Shared now' },
});

/**
 * An unknown visibility takes the private ring, the web's own fallback. Reading as private is
 * the safe mistake; reading as shared is the one this screen must never make.
 */
export function visibilityCue(visibility: string) {
  return VISIBILITY_CUES[visibility as Visibility] || { glyph: '○', label: String(visibility || '').replaceAll('-', ' ') };
}

/** Which colour role a visibility wears. Anything unknown wears private's. */
export function visibilityRole(visibility: string): 'private' | 'sharedNow' | 'shareLater' {
  if (visibility === 'shared-now') return 'sharedNow';
  if (visibility === 'share-later') return 'shareLater';
  return 'private';
}

const momentTypes = MOMENT_TYPES as [string, string][];

export function momentLabel(kind: string, kindLabel?: string | null) {
  if (kind === 'other') return kindLabel || 'A shared note';
  return momentTypes.find(([value]) => value === kind)?.[1] || 'Moment';
}

/** The choice above the moment list (Oct 9), in the words the owner approves. */
export const MOMENT_VIEW_LABEL = 'Show moments';
export const MOMENT_VIEWS: [MomentView, string][] = [['full', 'In full'], ['compact', 'Compact']];

/** What a screen reader hears for a compact row: its title, its date and its visibility. */
export function compactRowLabel(moment: Moment) {
  return `${moment.title}, ${dateLabel(moment.occurredOn)}, Visibility: ${visibilityCue(moment.visibility).label}`;
}

export function journeyPeriod(journey: Journey) {
  const pieces: string[] = [];
  if (journey.location) pieces.push(journey.location);
  pieces.push(journey.startDateStatus === 'unknown' ? 'Began at an unknown time' : `Began ${dateLabel(journey.startDate)}`);
  pieces.push(journey.endDateStatus === 'forever' ? 'No end date planned' : journey.endDateStatus === 'unsure' ? 'Ending not decided yet' : `Ends ${dateLabel(journey.endDate)}`);
  return pieces.join(' · ');
}

/** Newest first, by the day it happened and then by its last change, as the web sorts. */
export function recentMoments(snapshot: Snapshot): ShownMoment[] {
  const images = snapshot.images || [];
  return snapshot.moments
    .map((moment) => ({
      ...moment,
      images: images.filter((image) => image.momentId === moment.id && !image.deletedAt),
      removedImages: images.filter((image) => image.momentId === moment.id && image.deletedAt),
    }))
    .sort((a, b) => `${b.occurredOn}-${b.updatedAt}`.localeCompare(`${a.occurredOn}-${a.updatedAt}`));
}

/** "All moments", then only the types this journey actually holds, in the web's order. */
export function momentFilters(recent: Moment[]): [string, string][] {
  const inUse = new Set(recent.map((moment) => moment.kind));
  return [['all', 'All moments'], ...momentTypes.filter(([value]) => inUse.has(value))];
}

/** The web's "See all" button, with a singular for one moment (#337). */
export function seeAllLabel(count: number) {
  return `See all ${countOf(count, 'moment', 'moments')}`;
}

/** Three recent moments until the person asks for all, then every moment the filter allows. */
export function shownMoments(recent: ShownMoment[], { expanded, filter }: { expanded: boolean; filter: string }) {
  if (!expanded) return recent.slice(0, RECENT_MOMENTS_SHOWN);
  return recent.filter((moment) => filter === 'all' || moment.kind === filter);
}

export function openThreads(snapshot: Snapshot) {
  return snapshot.concerns.filter((concern) => concern.status === 'open');
}

export function moneyContext(moment: Moment) {
  return moment.moneyCents == null ? null : `${money(moment.moneyCents, moment.moneyCurrency)} is held here as context, not a score.`;
}

export function locationContext(moment: Moment) {
  const locations = Array.isArray(moment.locations) ? moment.locations : [];
  return locations.length ? locations.map((location) => location.label).join(' · ') : null;
}

/** The journey that stays open across a refresh, or the most recently changed one. */
export function chooseJourney(journeys: Journey[], previousId: string | null) {
  return journeys.find((journey) => journey.id === previousId)?.id ?? journeys[0]?.id ?? null;
}
