export const CATEGORIES = ['Flights', 'Hotel', 'Restaurants', 'Transportation', 'Activities', 'Shopping', 'Other'];
export const CURRENT_SCHEMA_VERSION = 2;

export const CATEGORY_ICONS = {
  Flights: '✦',
  Hotel: '▦',
  Restaurants: '◒',
  Transportation: '↗',
  Activities: '◇',
  Shopping: '◫',
  Other: '·',
};

export function demoState() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    activeTripId: 'demo-coast',
    preferences: { onboardingComplete: false, activeActorByTrip: { 'demo-coast': 'Alex' } },
    trips: [
      {
        id: 'demo-coast',
        name: 'Coastal Weekend',
        location: 'Oregon Coast',
        startDate: '2026-08-14',
        endDate: '2026-08-17',
        budgetCents: 120000,
        members: ['Alex', 'Jordan'],
        archivedAt: '',
        milestones: {
          reviewedPicture: false,
          chosePrompt: false,
          agreedNextAction: false,
        },
      },
    ],
    entries: [
      { id: 'demo-1', tripId: 'demo-coast', merchant: 'Train to Portland', category: 'Transportation', amountCents: 12800, occurredOn: '2026-08-14', paidBy: 'Alex', account: 'Travel card', status: 'paid', reference: '', notes: 'Refundable fare' },
      { id: 'demo-2', tripId: 'demo-coast', merchant: 'Harbor guesthouse', category: 'Hotel', amountCents: 46800, occurredOn: '2026-08-14', paidBy: 'Jordan', account: 'Credit card', status: 'paid', reference: 'DEMO-4821', notes: 'Two nights' },
      { id: 'demo-3', tripId: 'demo-coast', merchant: 'Tidepool dinner', category: 'Restaurants', amountCents: 9350, occurredOn: '2026-08-15', paidBy: 'Alex', account: 'Debit card', status: 'paid', reference: '', notes: 'Anniversary dinner' },
      { id: 'demo-4', tripId: 'demo-coast', merchant: 'Kayak reservation', category: 'Activities', amountCents: 16000, occurredOn: '2026-08-16', paidBy: 'Jordan', account: '', status: 'due', reference: '', notes: 'Pay at check-in' },
      { id: 'demo-5', tripId: 'demo-coast', merchant: 'Bakery breakfast', category: 'Restaurants', amountCents: 2875, occurredOn: '2026-08-16', paidBy: 'Alex', account: 'Cash', status: 'paid', reference: '', notes: '' },
    ],
    concerns: [],
    events: [
      {
        id: 'demo-event-1',
        tripId: 'demo-coast',
        sequence: 1,
        occurredAt: '2026-08-01T20:00:00.000Z',
        actorName: 'Alex',
        action: 'journey_created',
        entityType: 'journey',
        entityId: 'demo-coast',
        summary: 'Created the Coastal Weekend journey',
        before: null,
        after: { name: 'Coastal Weekend', budgetCents: 120000 },
        previousEventId: '',
        source: 'synthetic-demo',
      },
    ],
  };
}

export function normalizeMilestones(value = {}) {
  return {
    reviewedPicture: value.reviewedPicture === true,
    chosePrompt: value.chosePrompt === true,
    agreedNextAction: value.agreedNextAction === true,
  };
}

export function migrateState(value) {
  if (!value || ![1, CURRENT_SCHEMA_VERSION].includes(value.schemaVersion) || !Array.isArray(value.trips) || !Array.isArray(value.entries)) {
    throw new Error('This does not look like valid Together Ledger data.');
  }
  const trips = value.trips.map((trip) => ({
    ...trip,
    archivedAt: typeof trip.archivedAt === 'string' ? trip.archivedAt : '',
    milestones: normalizeMilestones(trip.milestones),
  }));
  const activeTripId = trips.some((trip) => trip.id === value.activeTripId) ? value.activeTripId : trips[0]?.id;
  const migrated = {
    ...value,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    activeTripId,
    preferences: {
      ...value.preferences,
      onboardingComplete: value.preferences?.onboardingComplete === true,
      activeActorByTrip: value.preferences?.activeActorByTrip && typeof value.preferences.activeActorByTrip === 'object' ? { ...value.preferences.activeActorByTrip } : {},
    },
    trips,
    entries: value.entries.map((entry) => ({ ...entry })),
    concerns: Array.isArray(value.concerns) ? value.concerns.map((concern) => ({ ...concern })) : [],
    events: Array.isArray(value.events) ? value.events.map((event) => ({ ...event })) : [],
  };
  if (!isValidState(migrated)) throw new Error('This does not look like valid Together Ledger data.');
  return migrated;
}

export function activeTrip(state) {
  return state.trips.find((trip) => trip.id === state.activeTripId) ?? state.trips[0];
}

export function activeEntries(state) {
  const trip = activeTrip(state);
  return trip ? state.entries.filter((entry) => entry.tripId === trip.id) : [];
}

export function summarize(entries, budgetCents = 0) {
  const result = {
    totalCents: 0,
    dueCents: 0,
    budgetCents,
    budgetLeftCents: budgetCents,
    byCategory: {},
    byPayer: {},
    byDay: {},
  };

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
  const cursor = new Date(`${start}T12:00:00Z`);
  const last = new Date(`${end}T12:00:00Z`);
  const days = [];
  while (cursor <= last && days.length < 370) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export function groupDayByCategory(entries, date) {
  return entries
    .filter((entry) => entry.occurredOn === date)
    .reduce((groups, entry) => {
      groups[entry.category] ??= [];
      groups[entry.category].push(entry);
      return groups;
    }, {});
}

export function conversationPrompts(summary) {
  const prompts = [];
  if (summary.dueCents > 0) {
    prompts.push(`We still have ${money(summary.dueCents)} due. What would make handling it feel clear and fair?`);
  }
  if (summary.budgetCents > 0 && summary.budgetLeftCents < 0) {
    prompts.push(`We are ${money(Math.abs(summary.budgetLeftCents))} over our plan. What changed, and what choice feels right now?`);
  } else if (summary.budgetCents > 0) {
    prompts.push(`We have ${money(summary.budgetLeftCents)} left. What experience matters most to protect?`);
  }
  const largest = Object.entries(summary.byCategory).sort((a, b) => b[1] - a[1])[0];
  if (largest) prompts.push(`${largest[0]} is our largest category at ${money(largest[1])}. Was that expected?`);
  prompts.push('Which expense added the most joy or ease to this trip?');
  prompts.push('Is there any cost you have been hesitant to bring up? What would make it easier?');
  prompts.push('What is one money decision we can make before the next travel day?');
  return prompts.slice(0, 5);
}

export function money(cents) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((Number(cents) || 0) / 100);
}

export function dateLabel(date, options = { month: 'short', day: 'numeric' }) {
  if (!date) return 'Date not set';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(new Date(`${date}T12:00:00Z`));
}

export function makeId(prefix = 'entry') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function appendJourneyEvent(state, input) {
  const events = state.events.filter((event) => event.tripId === input.tripId).sort((a, b) => a.sequence - b.sequence);
  const previous = events.at(-1);
  const event = {
    id: makeId('event'),
    tripId: input.tripId,
    sequence: (previous?.sequence || 0) + 1,
    occurredAt: input.occurredAt || new Date().toISOString(),
    actorName: input.actorName?.trim() || 'Local user',
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    summary: input.summary.trim(),
    before: input.before == null ? null : structuredClone(input.before),
    after: input.after == null ? null : structuredClone(input.after),
    previousEventId: previous?.id || '',
    source: 'browser-local',
  };
  state.events.push(event);
  return event;
}

export function normalizeConcern(input, tripId, actorName, existing = null) {
  if (!input.title?.trim()) throw new Error('Concern title is required.');
  if ((input.title?.length || 0) > 100 || (input.detail?.length || 0) > 500) throw new Error('Keep the concern within the displayed limits.');
  const now = new Date().toISOString();
  return {
    id: existing?.id || makeId('concern'),
    tripId,
    title: input.title.trim(),
    detail: input.detail?.trim() || '',
    status: input.status === 'resolved' ? 'resolved' : 'open',
    createdAt: existing?.createdAt || now,
    createdBy: existing?.createdBy || actorName,
    updatedAt: now,
    updatedBy: actorName,
  };
}

export function normalizeTrip(input) {
  const budgetCents = Math.round(Number(input.budget) * 100);
  const members = [input.memberOne, input.memberTwo].map((value) => value?.trim()).filter(Boolean);
  if (!input.name?.trim()) throw new Error('Journey name is required.');
  if (!input.location?.trim()) throw new Error('Location is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate || '')) throw new Error('Choose valid journey dates.');
  if (input.endDate < input.startDate) throw new Error('The end date must be on or after the start date.');
  if (!Number.isSafeInteger(budgetCents) || budgetCents < 0 || budgetCents > 100000000) throw new Error('Enter a valid budget.');
  if (members.length !== 2) throw new Error('Add both people sharing this journey.');
  if (new Set(members.map((member) => member.toLocaleLowerCase())).size !== 2) throw new Error('Use a distinct name for each journeyer.');
  return {
    id: input.id || makeId('trip'),
    name: input.name.trim(),
    location: input.location.trim(),
    startDate: input.startDate,
    endDate: input.endDate,
    budgetCents,
    members,
    archivedAt: '',
    milestones: normalizeMilestones(),
  };
}

export function normalizeEntry(input, tripId) {
  const amountCents = Math.round(Number(input.amount) * 100);
  if (!input.merchant?.trim()) throw new Error('Expense name is required.');
  if (!CATEGORIES.includes(input.category)) throw new Error('Choose a valid category.');
  if (!Number.isSafeInteger(amountCents) || amountCents < 1 || amountCents > 100000000) throw new Error('Enter a valid amount.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn || '')) throw new Error('Choose a valid date.');
  return {
    id: input.id || makeId(),
    tripId,
    merchant: input.merchant.trim(),
    category: input.category,
    amountCents,
    occurredOn: input.occurredOn,
    paidBy: input.paidBy,
    account: input.account?.trim() || '',
    status: input.status === 'due' ? 'due' : 'paid',
    reference: input.reference?.trim() || '',
    notes: input.notes?.trim() || '',
  };
}

export function isValidState(value) {
  if (!value || value.schemaVersion !== CURRENT_SCHEMA_VERSION || !Array.isArray(value.trips) || !Array.isArray(value.entries)) return false;
  if (!value.trips.length || !value.preferences || typeof value.preferences.onboardingComplete !== 'boolean' || !value.preferences.activeActorByTrip || typeof value.preferences.activeActorByTrip !== 'object') return false;
  if (!value.trips.every((trip) => trip.id && trip.name && trip.location && Array.isArray(trip.members) && trip.members.length === 2 && Number.isSafeInteger(trip.budgetCents) && trip.milestones && ['reviewedPicture', 'chosePrompt', 'agreedNextAction'].every((key) => typeof trip.milestones[key] === 'boolean'))) return false;
  const tripIds = new Set(value.trips.map((trip) => trip.id));
  if (!tripIds.has(value.activeTripId)) return false;
  if (!value.entries.every((entry) => entry.id && tripIds.has(entry.tripId) && entry.merchant && CATEGORIES.includes(entry.category) && Number.isSafeInteger(entry.amountCents))) return false;
  if (!Array.isArray(value.concerns) || !value.concerns.every((concern) => concern.id && tripIds.has(concern.tripId) && concern.title && ['open', 'resolved'].includes(concern.status))) return false;
  if (!Array.isArray(value.events) || !value.events.every((event) => event.id && tripIds.has(event.tripId) && Number.isInteger(event.sequence) && event.sequence > 0 && event.occurredAt && event.actorName && event.action && event.entityType && event.entityId && event.summary)) return false;
  for (const tripId of tripIds) {
    const events = value.events.filter((event) => event.tripId === tripId).sort((a, b) => a.sequence - b.sequence);
    if (events.some((event, index) => event.sequence !== index + 1 || event.previousEventId !== (events[index - 1]?.id || ''))) return false;
  }
  return true;
}
