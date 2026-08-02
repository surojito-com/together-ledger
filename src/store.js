import { demoState, isValidState, migrateState } from './model.js';

export const STORAGE_KEY = 'together-ledger-v2';
export const LEGACY_STORAGE_KEY = 'together-ledger-v1';

export function loadState() {
  for (const key of [STORAGE_KEY, LEGACY_STORAGE_KEY]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const state = migrateState(JSON.parse(raw));
      if (key === LEGACY_STORAGE_KEY) saveState(state);
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

export function exportState(state) {
  if (!isValidState(state)) throw new Error('The ledger data is not valid.');
  return JSON.stringify({
    product: 'Together Ledger',
    exportedAt: new Date().toISOString(),
    data: state,
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
