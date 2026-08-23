import { demoState, isRetiredSyntheticDemo, isValidState, migrateState } from './model.js';

export const STORAGE_KEY = 'together-ledger-v3';
export const PREVIOUS_STORAGE_KEY = 'together-ledger-v2';
export const LEGACY_STORAGE_KEY = 'together-ledger-v1';

export function loadState() {
  for (const key of [STORAGE_KEY, PREVIOUS_STORAGE_KEY, LEGACY_STORAGE_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const state = migrateState(JSON.parse(raw));
      if (isRetiredSyntheticDemo(state)) {
        const fresh = demoState();
        saveState(fresh);
        return fresh;
      }
      if (key !== STORAGE_KEY) saveState(state);
      return state;
    } catch {
      // Keep looking. A damaged current value must not hide a valid legacy backup.
    }
  }
  return demoState();
}

export function saveState(state) {
  if (!isValidState(state)) throw new Error('The ledger data is not valid.');
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function resetState() {
  const state = demoState();
  saveState(state);
  return state;
}

function stateWithExportAliases(state) {
  const aliases = new Map();
  const remember = (value) => {
    if (typeof value === 'string' && value && !aliases.has(value)) aliases.set(value, `journeyer-${aliases.size + 1}`);
  };
  const isAccountIdKey = (key) => key === 'userId' || key.endsWith('UserId');
  const visitAccountReferences = (value) => {
    if (Array.isArray(value)) return value.forEach(visitAccountReferences);
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([key, child]) => {
      if (isAccountIdKey(key)) remember(child);
      visitAccountReferences(child);
    });
  };

  state.trips.forEach((trip) => (trip.memberRecords || []).forEach((member) => remember(member.id)));
  visitAccountReferences(state);
  state.events.forEach((event) => { if (event.entityType === 'membership') remember(event.entityId); });

  const exported = structuredClone(state);
  const replaceAccountReferences = (value) => {
    if (Array.isArray(value)) return value.forEach(replaceAccountReferences);
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([key, child]) => {
      if (isAccountIdKey(key) && aliases.has(child)) value[key] = aliases.get(child);
      else replaceAccountReferences(child);
    });
  };
  replaceAccountReferences(exported);
  exported.trips.forEach((trip) => (trip.memberRecords || []).forEach((member) => {
    if (aliases.has(member.id)) member.id = aliases.get(member.id);
  }));
  exported.events.forEach((event) => {
    if (event.entityType === 'membership' && aliases.has(event.entityId)) event.entityId = aliases.get(event.entityId);
  });
  return exported;
}

export function exportState(state) {
  if (!isValidState(state)) throw new Error('The ledger data is not valid.');
  return JSON.stringify({
    product: 'Together Ledger',
    exportedAt: new Date().toISOString(),
    identityProtection: 'account-aliases-v1',
    data: stateWithExportAliases(state),
  }, null, 2);
}

export function importState(text) {
  const parsed = JSON.parse(text);
  let state;
  try {
    state = migrateState(parsed?.data ?? parsed);
  } catch {
    throw new Error('This does not look like a valid Together Ledger export.');
  }
  saveState(state);
  return state;
}
