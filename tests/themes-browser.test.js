import test from 'node:test';
import assert from 'node:assert/strict';

test('saved theme is restored before paint and updates browser chrome color', async () => {
  const root = { dataset: {} };
  const meta = { content: '', setAttribute(name, value) { if (name === 'content') this.content = value; } };
  globalThis.document = {
    documentElement: root,
    querySelector(selector) { return selector === 'meta[name="theme-color"]' ? meta : null; },
  };
  globalThis.localStorage = { getItem(key) { return key === 'theme' ? 'kanagawa' : null; } };
  globalThis.matchMedia = () => ({ matches: false });

  await import('../src/themes.js?browser-test');
  assert.equal(root.dataset.theme, 'kanagawa');
  assert.equal(root.dataset.themeBase, 'dark');
  assert.equal(meta.content, '#1F1F28');

  globalThis.applyTogetherTheme('rose-pine-dawn');
  assert.equal(root.dataset.theme, 'rose-pine-dawn');
  assert.equal(root.dataset.themeBase, 'light');
  assert.equal(meta.content, '#FAF4ED');

  delete globalThis.document;
  delete globalThis.localStorage;
  delete globalThis.matchMedia;
});
