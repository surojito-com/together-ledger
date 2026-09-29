(function (global) {
  const themes = Object.freeze([
    { id: 'light', label: 'Light', base: 'light', color: '#F3EFE6' },
    { id: 'dark', label: 'Dark', base: 'dark', color: '#1A1815' },
    { id: 'green', label: 'Green', base: 'dark', color: '#071109' },
    { id: 'flexoki', label: 'Flexoki', base: 'light', color: '#FFFCF0' },
  ]);

  // Themes the product no longer carries, each pointing at the survivor closest to what the
  // person chose. Someone who picked a warm paper keeps a warm paper; someone who picked a
  // dark surface keeps a dark one. Without this a saved choice would silently become Light.
  const retired = Object.freeze({
    'solar-red': 'dark',
    catppuccin: 'dark',
    'tokyo-night': 'dark',
    kanagawa: 'dark',
    amber: 'dark',
    'rose-pine': 'dark',
    'catppuccin-latte': 'light',
    'primer-light': 'light',
    'ayu-light': 'light',
    'tokyo-night-day': 'light',
    'rose-pine-dawn': 'flexoki',
    'kanagawa-lotus': 'flexoki',
  });

  const themeMap = Object.fromEntries(themes.map((theme) => [theme.id, theme]));

  function resolveTheme(requestedId) {
    if (themeMap[requestedId]) return requestedId;
    return themeMap[retired[requestedId]] ? retired[requestedId] : 'light';
  }

  global.TOGETHER_THEMES = themes;
  global.TOGETHER_RETIRED_THEMES = retired;
  global.resolveTogetherTheme = resolveTheme;
  global.applyTogetherTheme = function (requestedId) {
    const id = resolveTheme(requestedId);
    const theme = themeMap[id];
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = id;
      document.documentElement.dataset.themeBase = theme.base;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.color);
    }
    return id;
  };

  if (typeof document === 'undefined' || typeof localStorage === 'undefined') return;
  const saved = localStorage.getItem('theme');
  const preferred = global.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const applied = global.applyTogetherTheme(saved || preferred);
  // Settle the migration once, so a retired name is not carried forward forever.
  if (saved && saved !== applied) {
    try { localStorage.setItem('theme', applied); } catch { /* a blocked store still renders */ }
  }
})(globalThis);
