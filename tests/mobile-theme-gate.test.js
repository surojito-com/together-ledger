import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { auditMobileTokens, generate, MOBILE_TOKENS_PATH, serialize } from '../scripts/mobile-theme-tokens.mjs';

const themeDir = new URL('../apps/mobile/src/theme/', import.meta.url);
const mobileTokens = JSON.parse(await readFile(MOBILE_TOKENS_PATH, 'utf8'));

// The phone's own TypeScript, compiled on the spot, so the gate tests the code the app runs
// rather than a copy of its logic.
async function importTypeScript(name) {
  const source = await readFile(new URL(name, themeDir), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

test('the phone reads the same theme values the web paints with, not a hand-kept copy', async () => {
  assert.equal(await readFile(MOBILE_TOKENS_PATH, 'utf8'), serialize(await generate()), 'tokens.json is stale: run node scripts/mobile-theme-tokens.mjs --write');
});

test('every phone theme passes the gate: all roles, WCAG AA text, and meanings held apart by hue', () => {
  assert.deepEqual(auditMobileTokens(mobileTokens), []);
  assert.deepEqual(mobileTokens.themes.map(({ id }) => id), ['light', 'dark', 'green', 'flexoki']);
  assert.deepEqual(mobileTokens.radius, { xs: 4, s: 8, m: 12, l: 18, xl: 24, pill: 999 });
});

test('the gate refuses a palette that breaks any of its rules', () => {
  const broken = structuredClone(mobileTokens);
  const light = broken.themes[0].colors;
  light.muted = '#BBBBBB';
  light.destructive = light.accent;
  light.red = light.destructive;
  const problems = auditMobileTokens(broken).join('\n');
  assert.match(problems, /light muted text is .*requires 4\.5:1/);
  assert.match(problems, /light accent and destructive are 0° apart/);
  assert.match(problems, /light must carry exactly the semantic roles/);
});

test('no palette alias reaches the phone', () => {
  for (const theme of mobileTokens.themes) {
    for (const alias of ['paper', 'card', 'ink', 'spruce', 'teal', 'gold', 'line', 'soft', 'red']) {
      assert.equal(Object.hasOwn(theme.colors, alias), false, `${theme.id} carries the alias ${alias}`);
    }
  }
});

test('a saved retired theme lands on its survivor, and no choice follows the phone', async () => {
  const { resolveTheme, themeFor } = await importTypeScript('resolve-theme.ts');
  assert.equal(resolveTheme('tokyo-night', mobileTokens), 'dark');
  assert.equal(resolveTheme('rose-pine-dawn', mobileTokens), 'flexoki');
  assert.equal(resolveTheme('catppuccin-latte', mobileTokens), 'light');
  assert.equal(resolveTheme('green', mobileTokens), 'green');
  assert.equal(resolveTheme('something-unknown', mobileTokens), 'light');
  assert.equal(themeFor(null, 'dark', mobileTokens), 'dark');
  assert.equal(themeFor(null, 'light', mobileTokens), 'light');
  assert.equal(themeFor(undefined, null, mobileTokens), 'light');
  assert.equal(themeFor('flexoki', 'dark', mobileTokens), 'flexoki', 'a saved choice wins over the phone');
});

test('nothing tappable on the phone is smaller than 44 points', async () => {
  const { MIN_TARGET, targetSize } = await importTypeScript('metrics.ts');
  assert.equal(MIN_TARGET, 44);
  assert.deepEqual(targetSize, { minHeight: 44, minWidth: 44 });
});

test('the phone loads only the three Gelasio files the typeface decision names', async () => {
  const fonts = await readFile(new URL('fonts.ts', themeDir), 'utf8');
  const loaded = fonts.match(/export const fontSources = \{([^}]*)\}/)[1].match(/Gelasio_\w+/g);
  assert.deepEqual(loaded, ['Gelasio_400Regular', 'Gelasio_400Regular_Italic', 'Gelasio_700Bold']);
  assert.doesNotMatch(fonts, /Gelasio_500/, 'the serif renders at 400, never 500 (#177)');
  // The package's main entry requires all eight files, and each one required ships in the app.
  assert.doesNotMatch(fonts, /from '@expo-google-fonts\/gelasio'/, 'import each weight from its own folder');
});
