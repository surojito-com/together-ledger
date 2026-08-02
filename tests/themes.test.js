import test from 'node:test';
import assert from 'node:assert/strict';

await import('../src/themes.js');

test('brand registry exposes all 16 unique themes', () => {
  const themes = globalThis.TOGETHER_THEMES;
  assert.equal(themes.length, 16);
  assert.equal(new Set(themes.map(({ id }) => id)).size, 16);
  assert.equal(themes.filter(({ base }) => base === 'light').length, 8);
  assert.equal(themes.filter(({ base }) => base === 'dark').length, 8);
});

test('theme application falls back safely without a browser document', () => {
  assert.equal(globalThis.applyTogetherTheme('tokyo-night'), 'tokyo-night');
  assert.equal(globalThis.applyTogetherTheme('unknown-theme'), 'light');
});
