import test from 'node:test';
import assert from 'node:assert/strict';

await import('../src/themes.js');

test('brand registry exposes the four curated themes', () => {
  const themes = globalThis.TOGETHER_THEMES;
  assert.equal(themes.length, 4);
  assert.equal(new Set(themes.map(({ id }) => id)).size, 4);
  assert.equal(themes.filter(({ base }) => base === 'light').length, 2);
  assert.equal(themes.filter(({ base }) => base === 'dark').length, 2);
  assert.deepEqual(themes.map(({ label }) => label), ['Light', 'Dark', 'Green', 'Flexoki']);
  assert.ok(themes.every((theme) => !Object.hasOwn(theme, 'icon')), 'decorative emoji are not part of accessible theme names');
});

test('theme application falls back safely without a browser document', () => {
  assert.equal(globalThis.applyTogetherTheme('green'), 'green');
  assert.equal(globalThis.applyTogetherTheme('unknown-theme'), 'light');
});

test('a retired theme keeps the surviving surface closest to what was chosen', () => {
  // A dark choice stays dark and a warm paper stays warm paper; nobody is dropped onto
  // Light from a surface that looked nothing like it.
  assert.equal(globalThis.applyTogetherTheme('rose-pine'), 'dark');
  assert.equal(globalThis.applyTogetherTheme('tokyo-night'), 'dark');
  assert.equal(globalThis.applyTogetherTheme('solar-red'), 'dark');
  assert.equal(globalThis.applyTogetherTheme('rose-pine-dawn'), 'flexoki');
  assert.equal(globalThis.applyTogetherTheme('kanagawa-lotus'), 'flexoki');
  assert.equal(globalThis.applyTogetherTheme('primer-light'), 'light');
  assert.equal(globalThis.applyTogetherTheme('tokyo-night-day'), 'light');
});

test('every retired theme resolves to a theme that still exists', () => {
  const live = new Set(globalThis.TOGETHER_THEMES.map(({ id }) => id));
  for (const [retired, survivor] of Object.entries(globalThis.TOGETHER_RETIRED_THEMES)) {
    assert.ok(live.has(survivor), `${retired} points at ${survivor}, which is not a live theme`);
    assert.ok(!live.has(retired), `${retired} is listed as retired but still registered`);
  }
});

test('resolving is idempotent, so a migrated choice stays put', () => {
  for (const id of Object.keys(globalThis.TOGETHER_RETIRED_THEMES)) {
    const once = globalThis.resolveTogetherTheme(id);
    assert.equal(globalThis.resolveTogetherTheme(once), once);
  }
});
