/**
 * Beginning a journey from the phone (#333), ported from the web's openJourney(),
 * syncJourneyDateFields() and the journey-form submit handler in src/app.js, for a signed-in
 * account: a name, an optional place or season, when it began and how long it lasts.
 *
 * Every rule here is also the server's (createJourney() and cleanJourneyDetails() in
 * server/platform.js), and the server stays the authority: these checks only save a round
 * trip, in the server's own words.
 */

import { localDay } from '../../../../src/model.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A day that exists on the calendar, written year-month-day. */
function realDate(value: string) {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export type JourneyDraft = {
  name: string;
  location: string;
  startDateStatus: string;
  startDate: string;
  endDateStatus: string;
  endDate: string;
};

/**
 * The web's #journey-form choices, in its order and its words. "I know the date" shows the date
 * box, filled in with today, and any day can go in it, a day still to come included, so a trip
 * can be planned ahead (#358). It is still stored as 'exact'.
 */
export const START_DATE_CHOICES: [string, string][] = [['exact', 'I know the date'], ['unknown', 'I don’t remember exactly']];
export const END_DATE_CHOICES: [string, string][] = [['forever', 'Forever — no end date planned'], ['unsure', 'Not sure yet'], ['date', 'Choose an end date']];

export const NAME_LIMIT = 80;
export const LOCATION_LIMIT = 80;

/**
 * A new journey starts as the web's does: begun today, with no end planned. Today is the
 * person's own local day, as the web's openJourney() counts it too (#336).
 */
export function newJourneyDraft(now = new Date()): JourneyDraft {
  const day = localDay(now);
  return { name: '', location: '', startDateStatus: 'exact', startDate: day, endDateStatus: 'forever', endDate: day };
}

/** Which date fields the form shows, as the web's syncJourneyDateFields() decides. */
export function dateFieldsShown(draft: JourneyDraft) {
  return { startDate: draft.startDateStatus === 'exact', endDate: draft.endDateStatus === 'date' };
}

/** The first problem with a draft, in the server's own words, or null when it can be sent. */
export function journeyProblem(draft: JourneyDraft): string | null {
  const name = draft.name.trim();
  if (!name || name.length > NAME_LIMIT) return `Journey name is required and must be ${NAME_LIMIT} characters or fewer.`;
  // A place longer than the limit is not refused: the server keeps its first 80 characters, and
  // the field never takes more.
  const shown = dateFieldsShown(draft);
  if (shown.startDate && !realDate(draft.startDate)) return 'Choose a start date or select “I don’t remember exactly.”';
  if (shown.endDate && !realDate(draft.endDate)) return 'Choose an end date or select another ending.';
  if (shown.startDate && shown.endDate && draft.endDate < draft.startDate) return 'The end date must be on or after the start date.';
  return null;
}

/**
 * What is sent: the web's payload for a new journey, field for field. The web keeps budget as a
 * hidden field set to 0, so a new journey carries no budget from either client.
 */
export function journeyPayload(draft: JourneyDraft) {
  const shown = dateFieldsShown(draft);
  return {
    name: draft.name.trim(),
    location: draft.location.trim(),
    startDateStatus: draft.startDateStatus,
    endDateStatus: draft.endDateStatus,
    startDate: shown.startDate ? draft.startDate : null,
    endDate: shown.endDate ? draft.endDate : null,
    budgetCents: 0,
  };
}

/** The web's toast once a private journey exists. */
export const CREATED_MESSAGE = 'Private journey created. Invite your journeyer in Settings.';
