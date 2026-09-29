export const MOMENT_THEMES = Object.freeze([
  { id: 'light', label: 'Light', base: 'light', color: '#F3EFE6' },
  { id: 'dark', label: 'Dark', base: 'dark', color: '#1A1815' },
  { id: 'green', label: 'Green', base: 'dark', color: '#071109' },
  { id: 'flexoki', label: 'Flexoki', base: 'light', color: '#FFFCF0' },
]);

// A moment already saved with a retired treatment keeps the nearest surviving one rather
// than losing the choice its journeyer made. The mapping is idempotent, so a moment that has
// already migrated normalizes to itself and still satisfies the stored-state validator.
const RETIRED_MOMENT_THEMES = Object.freeze({
  'rose-pine': 'dark',
  'tokyo-night-day': 'light',
});

const momentThemeIds = new Set(MOMENT_THEMES.map(({ id }) => id));

export function normalizeMomentTheme(value) {
  const id = String(value || '').trim();
  if (momentThemeIds.has(id)) return id;
  return momentThemeIds.has(RETIRED_MOMENT_THEMES[id]) ? RETIRED_MOMENT_THEMES[id] : '';
}

export function momentThemeLabel(value) {
  const id = normalizeMomentTheme(value);
  return MOMENT_THEMES.find((theme) => theme.id === id)?.label || 'Use my theme';
}
