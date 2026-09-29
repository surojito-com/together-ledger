import test from 'node:test';
import assert from 'node:assert/strict';

test('a retired saved theme is migrated before paint and settled in storage', async () => {
  const root = { dataset: {} };
  const meta = { content: '', setAttribute(name, value) { if (name === 'content') this.content = value; } };
  const written = [];
  globalThis.document = {
    documentElement: root,
    querySelector(selector) { return selector === 'meta[name="theme-color"]' ? meta : null; },
  };
  globalThis.localStorage = {
    getItem(key) { return key === 'theme' ? 'kanagawa' : null; },
    setItem(key, value) { written.push([key, value]); },
  };
  globalThis.matchMedia = () => ({ matches: false });

  await import('../src/themes.js?browser-test');
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.dataset.themeBase, 'dark');
  assert.equal(meta.content, '#1A1815');
  // Settled once, so the retired name is not carried forward on every future load.
  assert.deepEqual(written, [['theme', 'dark']]);

  globalThis.applyTogetherTheme('rose-pine-dawn');
  assert.equal(root.dataset.theme, 'flexoki');
  assert.equal(root.dataset.themeBase, 'light');
  assert.equal(meta.content, '#FFFCF0');

  delete globalThis.document;
  delete globalThis.localStorage;
  delete globalThis.matchMedia;
});
