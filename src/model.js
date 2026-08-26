export const CATEGORIES = ['Flights', 'Hotel', 'Restaurants', 'Transportation', 'Activities', 'Shopping', 'Other'];
export const CURRENT_SCHEMA_VERSION = 4;

export const MOMENT_TYPES = [
  ['promise', 'Promise'],
  ['acknowledgment', 'Acknowledgment'],
  ['trigger', 'Trigger'],
  ['missed-chance', 'Missed chance'],
  ['heart-to-heart', 'Heart-to-heart'],
  ['memory', 'Memory'],
  ['feeling', 'Feeling'],
  ['boundary', 'Boundary'],
  ['repair-request', 'Repair request'],
  ['learned-something', 'Learned something'],
  ['call-me', 'Call me'],
  ['called-you', 'Called you'],
  ['practical-matter', 'Practical matter'],
  ['other', '+ Add your own moment'],
];
export const MOMENT_VISIBILITIES = ['private', 'shared-now', 'share-later'];

export const CATEGORY_ICONS = {
  Flights: '✦', Hotel: '▦', Restaurants: '◒', Transportation: '↗', Activities: '◇', Shopping: '◫', Other: '·',
};

const momentLabel = Object.fromEntries(MOMENT_TYPES);

function practicalMoments(entries) {
  return entries.map((entry) => ({
    id: `practical-${entry.id}`,
    tripId: entry.tripId,
    kind: 'practical-matter',
    title: entry.merchant,
    detail: entry.notes || `${entry.category}${entry.paidBy ? ` · noted by ${entry.paidBy}` : ''}`,
    occurredOn: entry.occurredOn,
    visibility: 'shared-now',
    moneyCents: entry.amountCents,
    moneyCurrency: 'USD',
    sourceEntryId: entry.id,
    createdAt: `${entry.occurredOn || '2026-01-01'}T12:00:00.000Z`,
    updatedAt: `${entry.occurredOn || '2026-01-01'}T12:00:00.000Z`,
  }));
}

export function demoState() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    activeTripId: 'first-shared-space',
    preferences: { onboardingComplete: false, guidanceDismissedOn: '', activeActorByTrip: { 'first-shared-space': 'You' } },
    trips: [{
      id: 'first-shared-space', name: 'A shared space', location: 'Nothing recorded yet', startDate: '2026-01-01', startDateStatus: 'exact', endDate: '2026-01-01', endDateStatus: 'date', budgetCents: 0, members: ['You', 'Your journeyer'], archivedAt: '',
      milestones: { reviewedPicture: false, chosePrompt: false, agreedNextAction: false },
    }],
    entries: [],
    moments: [],
    concerns: [],
    events: [],
  };
}

export function isRetiredSyntheticDemo(state) {
  return state?.activeTripId === 'demo-coast'
    && state.trips?.length === 1
    && state.trips[0]?.id === 'demo-coast'
    && state.trips[0]?.name === 'Coastal Weekend'
    && state.entries?.length === 3
    && state.entries.every((entry) => /^demo-[1-3]$/.test(entry.id))
    && state.moments?.length === 6
    && state.moments.every((moment) => /^(moment-[1-3]|practical-demo-[1-3])$/.test(moment.id))
    && state.concerns?.length === 1
    && state.concerns[0]?.id === 'thread-1'
    && state.events?.length === 1
    && state.events[0]?.id === 'demo-event-1'
    && state.events[0]?.source === 'synthetic-demo';
}

export function normalizeMilestones(value = {}) {
  return { reviewedPicture: value.reviewedPicture === true, chosePrompt: value.chosePrompt === true, agreedNextAction: value.agreedNextAction === true };
}

export function migrateState(value) {
  if (!value || ![1, 2, 3, CURRENT_SCHEMA_VERSION].includes(value.schemaVersion) || !Array.isArray(value.trips) || !Array.isArray(value.entries)) throw new Error('This does not look like valid Together Ledger data.');
  const trips = value.trips.map((trip) => ({
    ...trip,
    location: typeof trip.location === 'string' ? trip.location : '',
    startDateStatus: trip.startDateStatus === 'unknown' ? 'unknown' : 'exact',
    endDateStatus: ['date', 'unsure', 'forever'].includes(trip.endDateStatus) ? trip.endDateStatus : 'date',
    startDate: trip.startDateStatus === 'unknown' ? '' : trip.startDate || '',
    endDate: ['unsure', 'forever'].includes(trip.endDateStatus) ? '' : trip.endDate || '',
    archivedAt: typeof trip.archivedAt === 'string' ? trip.archivedAt : '',
    milestones: normalizeMilestones(trip.milestones),
  }));
  const activeTripId = trips.some((trip) => trip.id === value.activeTripId) ? value.activeTripId : trips[0]?.id;
  const entries = value.entries.map((entry) => ({ ...entry }));
  const migrated = {
    ...value,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    activeTripId,
    preferences: { ...value.preferences, onboardingComplete: value.preferences?.onboardingComplete === true, guidanceDismissedOn: typeof value.preferences?.guidanceDismissedOn === 'string' ? value.preferences.guidanceDismissedOn : '', activeActorByTrip: value.preferences?.activeActorByTrip && typeof value.preferences.activeActorByTrip === 'object' ? { ...value.preferences.activeActorByTrip } : {} },
    trips,
    entries,
    moments: Array.isArray(value.moments) ? value.moments.map((moment) => ({ ...moment, moneyCents: moment.moneyCents == null ? null : Number(moment.moneyCents), moneyCurrency: typeof moment.moneyCurrency === 'string' ? moment.moneyCurrency : '' })) : practicalMoments(entries),
    concerns: Array.isArray(value.concerns) ? value.concerns.map((concern) => ({ ...concern })) : [],
    events: Array.isArray(value.events) ? value.events.map((event) => ({ ...event })) : [],
  };
  if (!isValidState(migrated)) throw new Error('This does not look like valid Together Ledger data.');
  return migrated;
}

export function activeTrip(state) { return state.trips.find((trip) => trip.id === state.activeTripId) ?? state.trips[0]; }
export function activeEntries(state) { const trip = activeTrip(state); return trip ? state.entries.filter((entry) => entry.tripId === trip.id) : []; }
export function activeMoments(state) { const trip = activeTrip(state); return trip ? state.moments.filter((moment) => moment.tripId === trip.id) : []; }

export function summarize(entries, budgetCents = 0) {
  const result = { totalCents: 0, dueCents: 0, budgetCents, budgetLeftCents: budgetCents, byCategory: {}, byPayer: {}, byDay: {} };
  for (const entry of entries) {
    const amount = Number(entry.amountCents) || 0;
    result.totalCents += amount;
    if (entry.status === 'due') result.dueCents += amount;
    result.byCategory[entry.category] = (result.byCategory[entry.category] || 0) + amount;
    result.byPayer[entry.paidBy] = (result.byPayer[entry.paidBy] || 0) + amount;
    result.byDay[entry.occurredOn] = (result.byDay[entry.occurredOn] || 0) + amount;
  }
  result.budgetLeftCents = budgetCents - result.totalCents;
  return result;
}

export function dateRange(startDate, endDate, entries = []) {
  const savedDates = entries.map((entry) => entry.occurredOn).filter(Boolean).sort();
  const start = [startDate, savedDates[0]].filter(Boolean).sort()[0];
  const end = [endDate, savedDates.at(-1)].filter(Boolean).sort().at(-1);
  if (!start || !end) return [];
  const cursor = new Date(`${start}T12:00:00Z`); const last = new Date(`${end}T12:00:00Z`); const days = [];
  while (cursor <= last && days.length < 370) { days.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  return days;
}

export function groupDayByCategory(entries, date) { return entries.filter((entry) => entry.occurredOn === date).reduce((groups, entry) => { groups[entry.category] ??= []; groups[entry.category].push(entry); return groups; }, {}); }

export function conversationPrompts() {
  return ['What feels important to name with care today?', 'What is one thing you noticed and appreciated?', 'Is there an open thread that would feel lighter with a small next step?', 'What boundary would help this journey feel more spacious?', 'What do we want to remember about this season together?'];
}

export function money(cents, currency = 'USD') {
  const value = (Number(cents) || 0) / 100;
  if (!currency) return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value); } catch { return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value); }
}
export function dateLabel(date, options = { month: 'short', day: 'numeric' }) { if (!date) return 'Date not set'; return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(new Date(`${date}T12:00:00Z`)); }
export function makeId(prefix = 'entry') { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

export function appendJourneyEvent(state, input) {
  const events = state.events.filter((event) => event.tripId === input.tripId).sort((a, b) => a.sequence - b.sequence); const previous = events.at(-1);
  const event = { id: makeId('event'), tripId: input.tripId, sequence: (previous?.sequence || 0) + 1, occurredAt: input.occurredAt || new Date().toISOString(), actorName: input.actorName?.trim() || 'Local user', action: input.action, entityType: input.entityType, entityId: input.entityId, summary: input.summary.trim(), before: input.before == null ? null : structuredClone(input.before), after: input.after == null ? null : structuredClone(input.after), previousEventId: previous?.id || '', source: 'browser-local' };
  state.events.push(event); return event;
}

export function normalizeConcern(input, tripId, actorName, existing = null) {
  if (!input.title?.trim()) throw new Error('Open thread title is required.');
  if ((input.title?.length || 0) > 100 || (input.detail?.length || 0) > 500) throw new Error('Keep the open thread within the displayed limits.');
  const now = new Date().toISOString();
  return { id: existing?.id || makeId('thread'), tripId, title: input.title.trim(), detail: input.detail?.trim() || '', status: input.status === 'resolved' ? 'resolved' : 'open', createdAt: existing?.createdAt || now, createdBy: existing?.createdBy || actorName, updatedAt: now, updatedBy: actorName };
}

export function normalizeMoment(input, tripId, existing = null) {
  if (!input.title?.trim()) throw new Error('A moment needs a short title.');
  if (!MOMENT_TYPES.some(([value]) => value === input.kind)) throw new Error('Choose a valid kind of moment.');
  const kindLabel = input.kind === 'other' ? String(input.kindLabel || '').trim() : '';
  if (input.kind === 'other' && (!kindLabel || kindLabel.length > 60)) throw new Error('Give this kind of moment a short name of 60 characters or fewer.');
  if (!MOMENT_VISIBILITIES.includes(input.visibility)) throw new Error('Choose who can see this moment.');
  if ((input.title?.length || 0) > 120 || (input.detail?.length || 0) > 1200) throw new Error('Keep the moment within the displayed limits.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn || '')) throw new Error('Choose a valid date.');
  const moneyCents = input.money === '' || input.money == null ? null : Math.round(Number(input.money) * 100);
  if (moneyCents != null && (!Number.isSafeInteger(moneyCents) || moneyCents < 0 || moneyCents > 100000000)) throw new Error('Enter a valid optional money context.');
  const moneyCurrency = String(input.moneyCurrency ?? existing?.moneyCurrency ?? '').trim().toUpperCase();
  if (moneyCurrency && !['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'INR'].includes(moneyCurrency)) throw new Error('Choose a supported optional currency.');
  const now = new Date().toISOString();
  const createdBy = existing?.createdBy || input.createdBy || 'Journey member';
  const updatedBy = input.updatedBy || existing?.updatedBy || createdBy;
  return { id: existing?.id || makeId('moment'), tripId, kind: input.kind, kindLabel, title: input.title.trim(), detail: input.detail?.trim() || '', occurredOn: input.occurredOn, visibility: input.visibility, moneyCents, moneyCurrency, sourceEntryId: existing?.sourceEntryId || '', createdAt: existing?.createdAt || now, updatedAt: now, createdBy, updatedBy, shapedByBoth: Boolean(existing?.shapedByBoth || (existing?.createdBy && existing.createdBy !== updatedBy)), label: input.kind === 'other' ? kindLabel : momentLabel[input.kind] };
}

export function normalizeTrip(input) {
  const budgetCents = input.budget === '' || input.budget == null ? 0 : Math.round(Number(input.budget) * 100);
  const members = [input.memberOne, input.memberTwo].map((value) => value?.trim()).filter(Boolean);
  const startDateStatus = input.startDateStatus === 'unknown' ? 'unknown' : 'exact';
  const endDateStatus = ['date', 'unsure', 'forever'].includes(input.endDateStatus) ? input.endDateStatus : 'forever';
  const startDate = startDateStatus === 'exact' ? input.startDate : '';
  const endDate = endDateStatus === 'date' ? input.endDate : '';
  if (!input.name?.trim()) throw new Error('Journey name is required.');
  if (startDateStatus === 'exact' && !/^\d{4}-\d{2}-\d{2}$/.test(startDate || '')) throw new Error('Choose a valid start date or select “I don’t remember exactly.”');
  if (endDateStatus === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) throw new Error('Choose a valid end date or select another ending.');
  if (startDate && endDate && endDate < startDate) throw new Error('The end date must be on or after the start date.'); if (!Number.isSafeInteger(budgetCents) || budgetCents < 0 || budgetCents > 100000000) throw new Error('Enter a valid planning amount.');
  if (members.length !== 2) throw new Error('Add both people sharing this journey.'); if (new Set(members.map((member) => member.toLocaleLowerCase())).size !== 2) throw new Error('Use a distinct name for each journeyer.');
  return { id: input.id || makeId('trip'), name: input.name.trim(), location: input.location?.trim() || '', startDate, startDateStatus, endDate, endDateStatus, budgetCents, members, archivedAt: '', milestones: normalizeMilestones() };
}

export function normalizeEntry(input, tripId) {
  const amountCents = Math.round(Number(input.amount) * 100);
  if (!input.merchant?.trim()) throw new Error('Expense name is required.'); if (!CATEGORIES.includes(input.category)) throw new Error('Choose a valid category.'); if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 100000000) throw new Error('Enter a valid amount.'); if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn || '')) throw new Error('Choose a valid date.');
  return { id: input.id || makeId(), tripId, merchant: input.merchant.trim(), category: input.category, amountCents, occurredOn: input.occurredOn, paidBy: input.paidBy, account: input.account?.trim() || '', status: input.status === 'due' ? 'due' : 'paid', reference: input.reference?.trim() || '', notes: input.notes?.trim() || '' };
}

export function isValidState(value) {
  if (!value || value.schemaVersion !== CURRENT_SCHEMA_VERSION || !Array.isArray(value.trips) || !Array.isArray(value.entries) || !Array.isArray(value.moments)) return false;
  if (!value.trips.length || !value.preferences || typeof value.preferences.onboardingComplete !== 'boolean' || typeof value.preferences.guidanceDismissedOn !== 'string' || !value.preferences.activeActorByTrip || typeof value.preferences.activeActorByTrip !== 'object') return false;
  if (!value.trips.every((trip) => trip.id && trip.name && typeof trip.location === 'string' && ['exact', 'unknown'].includes(trip.startDateStatus) && ['date', 'unsure', 'forever'].includes(trip.endDateStatus) && (trip.startDateStatus !== 'exact' || /^\d{4}-\d{2}-\d{2}$/.test(trip.startDate)) && (trip.startDateStatus !== 'unknown' || !trip.startDate) && (trip.endDateStatus !== 'date' || /^\d{4}-\d{2}-\d{2}$/.test(trip.endDate)) && (trip.endDateStatus === 'date' || !trip.endDate) && (!trip.startDate || !trip.endDate || trip.endDate >= trip.startDate) && Array.isArray(trip.members) && trip.members.length >= 1 && trip.members.length <= 2 && Number.isSafeInteger(trip.budgetCents) && trip.milestones && ['reviewedPicture', 'chosePrompt', 'agreedNextAction'].every((key) => typeof trip.milestones[key] === 'boolean'))) return false;
  const tripIds = new Set(value.trips.map((trip) => trip.id)); if (!tripIds.has(value.activeTripId)) return false;
  if (!value.entries.every((entry) => entry.id && tripIds.has(entry.tripId) && entry.merchant && CATEGORIES.includes(entry.category) && Number.isSafeInteger(entry.amountCents))) return false;
  if (!value.moments.every((moment) => moment.id && tripIds.has(moment.tripId) && moment.title && MOMENT_TYPES.some(([kind]) => kind === moment.kind) && (moment.kind !== 'other' || (typeof moment.kindLabel === 'string' && moment.kindLabel.length > 0 && moment.kindLabel.length <= 60)) && MOMENT_VISIBILITIES.includes(moment.visibility) && /^\d{4}-\d{2}-\d{2}$/.test(moment.occurredOn) && (moment.moneyCents === null || Number.isSafeInteger(moment.moneyCents)) && typeof moment.moneyCurrency === 'string' && (!moment.moneyCurrency || ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'INR'].includes(moment.moneyCurrency)))) return false;
  if (!Array.isArray(value.concerns) || !value.concerns.every((concern) => concern.id && tripIds.has(concern.tripId) && concern.title && ['open', 'resolved'].includes(concern.status))) return false;
  if (!Array.isArray(value.events) || !value.events.every((event) => event.id && tripIds.has(event.tripId) && Number.isInteger(event.sequence) && event.sequence > 0 && event.occurredAt && event.actorName && event.action && event.entityType && event.entityId && event.summary)) return false;
  for (const tripId of tripIds) { const events = value.events.filter((event) => event.tripId === tripId).sort((a, b) => a.sequence - b.sequence); if (events.some((event, index) => event.sequence !== index + 1 || event.previousEventId !== (events[index - 1]?.id || ''))) return false; }
  return true;
}
