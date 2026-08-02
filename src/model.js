export const CATEGORIES = ['Flights', 'Hotel', 'Restaurants', 'Transportation', 'Activities', 'Shopping', 'Other'];

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
    schemaVersion: 1,
    activeTripId: 'demo-coast',
    trips: [
      {
        id: 'demo-coast',
        name: 'Coastal Weekend',
        location: 'Oregon Coast',
        startDate: '2026-08-14',
        endDate: '2026-08-17',
        budgetCents: 120000,
        members: ['Alex', 'Jordan'],
      },
    ],
    entries: [
      { id: 'demo-1', tripId: 'demo-coast', merchant: 'Train to Portland', category: 'Transportation', amountCents: 12800, occurredOn: '2026-08-14', paidBy: 'Alex', account: 'Travel card', status: 'paid', reference: '', notes: 'Refundable fare' },
      { id: 'demo-2', tripId: 'demo-coast', merchant: 'Harbor guesthouse', category: 'Hotel', amountCents: 46800, occurredOn: '2026-08-14', paidBy: 'Jordan', account: 'Credit card', status: 'paid', reference: 'DEMO-4821', notes: 'Two nights' },
      { id: 'demo-3', tripId: 'demo-coast', merchant: 'Tidepool dinner', category: 'Restaurants', amountCents: 9350, occurredOn: '2026-08-15', paidBy: 'Alex', account: 'Debit card', status: 'paid', reference: '', notes: 'Anniversary dinner' },
      { id: 'demo-4', tripId: 'demo-coast', merchant: 'Kayak reservation', category: 'Activities', amountCents: 16000, occurredOn: '2026-08-16', paidBy: 'Jordan', account: '', status: 'due', reference: '', notes: 'Pay at check-in' },
      { id: 'demo-5', tripId: 'demo-coast', merchant: 'Bakery breakfast', category: 'Restaurants', amountCents: 2875, occurredOn: '2026-08-16', paidBy: 'Alex', account: 'Cash', status: 'paid', reference: '', notes: '' },
    ],
  };
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
  return prompts.slice(0, 3);
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
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.trips) || !Array.isArray(value.entries)) return false;
  if (!value.trips.length || !value.trips.every((trip) => trip.id && trip.name && Array.isArray(trip.members))) return false;
  return value.entries.every((entry) => entry.id && entry.tripId && entry.merchant && CATEGORIES.includes(entry.category) && Number.isSafeInteger(entry.amountCents));
}
