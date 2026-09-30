/**
 * The moment form's rules for TL-M-08 (#183), ported from the web's openMoment(), the
 * moment-form submit handler, addMomentLocation() and shareMoment() in src/app.js.
 *
 * Every limit here is also the server's (cleanMoment() in server/platform.js), and the server
 * stays the authority: these checks only save a round trip, in the server's own words.
 */
import { normalizeMomentTheme } from '../../../../src/moment-themes.js';
import type { Moment } from './journey-view';

export type Place = { label: string; latitude?: number | null; longitude?: number | null; accuracyMeters?: number | null };

export type Draft = {
  kind: string;
  kindLabel: string;
  occurredOn: string;
  title: string;
  detail: string;
  visibility: string;
  theme: string;
  /** As typed, so "12.5" stays "12.5" until it is saved. */
  money: string;
  moneyCurrency: string;
  locations: Place[];
};

export type EditableMoment = Moment & { version: number; locations?: Place[] };

/** The web's currency choices, in its order ('' is "Currency (optional)"). */
export const CURRENCIES: [string, string][] = [
  ['', 'Currency (optional)'],
  ['USD', 'USD — US dollar'],
  ['EUR', 'EUR — Euro'],
  ['GBP', 'GBP — British pound'],
  ['CAD', 'CAD — Canadian dollar'],
  ['AUD', 'AUD — Australian dollar'],
  ['JPY', 'JPY — Japanese yen'],
  ['INR', 'INR — Indian rupee'],
];

export const MAX_PLACES = 12;

/** Today, as the web's date field starts: the UTC calendar day, "YYYY-MM-DD". */
export function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** A new moment starts shared now, as on the web; an existing one starts as it is. */
export function draftFrom(moment: EditableMoment | null, { kind = '', now = new Date() }: { kind?: string; now?: Date } = {}): Draft {
  if (!moment) {
    return { kind: kind || 'promise', kindLabel: '', occurredOn: today(now), title: '', detail: '', visibility: 'shared-now', theme: '', money: '', moneyCurrency: '', locations: [] };
  }
  return {
    kind: moment.kind,
    kindLabel: moment.kindLabel || '',
    occurredOn: moment.occurredOn,
    title: moment.title,
    detail: moment.detail || '',
    visibility: moment.visibility,
    theme: normalizeMomentTheme(moment.theme),
    money: moment.moneyCents == null ? '' : (moment.moneyCents / 100).toFixed(2),
    moneyCurrency: moment.moneyCurrency || '',
    locations: Array.isArray(moment.locations) ? moment.locations.map((place) => ({ ...place })) : [],
  };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function realDate(value: string) {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** The first problem with a draft, in the server's own words, or null when it can be sent. */
export function draftProblem(draft: Draft): string | null {
  if (draft.kind === 'other' && (!draft.kindLabel.trim() || draft.kindLabel.trim().length > 60)) return 'A name for this kind of moment is required and must be 60 characters or fewer.';
  if (!realDate(draft.occurredOn)) return 'Choose a valid moment date.';
  if (!draft.title.trim() || draft.title.trim().length > 120) return 'Moment title is required and must be 120 characters or fewer.';
  if (draft.money.trim() !== '') {
    const amount = Number(draft.money);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000000) return 'Enter a valid optional money context.';
  }
  if (draft.locations.length > MAX_PLACES) return 'A moment can hold up to 12 places.';
  return null;
}

/** What is sent: the web's payload, field for field. An edit carries the version it began from. */
export function payloadFrom(draft: Draft, before: EditableMoment | null) {
  return {
    kind: draft.kind,
    kindLabel: draft.kind === 'other' ? draft.kindLabel.trim() : '',
    title: draft.title,
    detail: draft.detail,
    occurredOn: draft.occurredOn,
    visibility: draft.visibility,
    theme: normalizeMomentTheme(draft.theme),
    moneyCents: draft.money.trim() === '' ? null : Math.round(Number(draft.money) * 100),
    moneyCurrency: draft.moneyCurrency || '',
    locations: draft.locations,
    ...(before ? { version: before.version } : {}),
  };
}

/** Adding a place: trimmed, never empty, and never a thirteenth. */
export function addPlace(locations: Place[], label: string): { locations: Place[]; problem: string | null } {
  const trimmed = label.trim();
  if (!trimmed) return { locations, problem: null };
  if (locations.length >= MAX_PLACES) return { locations, problem: 'A moment can hold up to 12 places.' };
  return { locations: [...locations, { label: trimmed }], problem: null };
}

export function removePlace(locations: Place[], index: number) {
  return locations.filter((_, at) => at !== index);
}

/** The web's own note beside each place. The server decides what a person already has. */
export function placeNote(index: number) {
  return index === 0 ? 'Included' : '$1/month';
}

/**
 * A moment already shared stays shared: prior access cannot be undone. The server refuses the
 * change too; the form simply does not offer it.
 */
export function visibilityLocked(before: EditableMoment | null, visibility: string) {
  return Boolean(before?.visibility === 'shared-now' && visibility !== 'shared-now');
}

export function visibilityHelp(before: EditableMoment | null) {
  return before?.visibility === 'shared-now'
    ? 'Already shared: everyone in this journey can see this moment, including anyone who joins later. Prior access cannot be undone.'
    : 'Private stays with you. Shared now opens it to everyone in this journey, including anyone who joins later. Share later stays with you until you deliberately share it.';
}

/** The toast after saving, in the web's words. */
export function savedMessage(before: EditableMoment | null, visibility: string) {
  return before ? 'Moment updated.' : visibility === 'shared-now' ? 'Moment shared.' : 'Moment held with you.';
}

/** Sharing a share-later moment now: the same moment, shared, from the version it was read at. */
export function sharePayload(moment: EditableMoment) {
  return payloadFrom({ ...draftFrom(moment), visibility: 'shared-now' }, moment);
}

/**
 * What deleting says before it happens. A shared moment leaves a tombstone in the journey's
 * history, as a deleted conversation does on the web; a moment only this person could see
 * leaves nothing anyone else sees.
 */
export function deleteConsequence(moment: EditableMoment) {
  return moment.visibility === 'shared-now'
    ? `“${moment.title}” will be removed for everyone in this journey. The event history keeps a deletion tombstone, so the change stays attributable.`
    : `“${moment.title}” will be removed. Only you could see it, so it leaves nothing behind that anyone else can see.`;
}
