(function (global) {
  const themes = Object.freeze([
    { id: 'light', label: 'Light', icon: '☀️', base: 'light', color: '#F3EFE6' },
    { id: 'dark', label: 'Dark', icon: '🌙', base: 'dark', color: '#1A1815' },
    { id: 'solar-red', label: 'Solar Red', icon: '🔴', base: 'dark', color: '#150A09' },
    { id: 'green', label: 'Green', icon: '🟢', base: 'dark', color: '#071109' },
    { id: 'catppuccin', label: 'Catppuccin Mocha', icon: '🟣', base: 'dark', color: '#1E1E2E' },
    { id: 'tokyo-night', label: 'Tokyo Night', icon: '🔵', base: 'dark', color: '#1A1B26' },
    { id: 'kanagawa', label: 'Kanagawa Wave', icon: '🟤', base: 'dark', color: '#1F1F28' },
    { id: 'amber', label: 'Amber', icon: '🟡', base: 'dark', color: '#16161D' },
    { id: 'rose-pine', label: 'Rosé Pine', icon: '🌸', base: 'dark', color: '#191724' },
    { id: 'catppuccin-latte', label: 'Catppuccin Latte', icon: '☕', base: 'light', color: '#EFF1F5' },
    { id: 'flexoki', label: 'Flexoki', icon: '📜', base: 'light', color: '#FFFCF0' },
    { id: 'rose-pine-dawn', label: 'Rosé Pine Dawn', icon: '🌅', base: 'light', color: '#FAF4ED' },
    { id: 'kanagawa-lotus', label: 'Kanagawa Lotus', icon: '🪷', base: 'light', color: '#F2ECBC' },
    { id: 'primer-light', label: 'Primer Light (GitHub)', icon: '🐙', base: 'light', color: '#FFFFFF' },
    { id: 'ayu-light', label: 'Ayu Light', icon: '🌤️', base: 'light', color: '#FCFCFC' },
    { id: 'tokyo-night-day', label: 'Tokyo Night Day', icon: '🏙️', base: 'light', color: '#E1E2E7' },
  ]);

  const themeMap = Object.fromEntries(themes.map((theme) => [theme.id, theme]));
  global.TOGETHER_THEMES = themes;
  global.applyTogetherTheme = function (requestedId) {
    const id = themeMap[requestedId] ? requestedId : 'light';
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
  global.applyTogetherTheme(themeMap[saved] ? saved : preferred);
})(globalThis);
