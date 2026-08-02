import { demoState, isValidState } from './model.js';

const STORAGE_KEY = 'together-ledger-v1';

export function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return isValidState(saved) ? saved : demoState();
  } catch {
    return demoState();
  }
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
  const state = parsed?.data ?? parsed;
  if (!isValidState(state)) throw new Error('This does not look like a valid Together Ledger export.');
  saveState(state);
  return state;
}
