// The phone app's theme values, generated from the same token blocks the web paints with
// (src/styles.css) and the same theme registry (src/themes.js). The phone never carries a
// second, hand-kept copy: apps/mobile/src/theme/tokens.json is written by this script and
// tests/mobile-theme-gate.test.js fails when it no longer matches the CSS (issue #178).
//
//   node scripts/mobile-theme-tokens.mjs          check that tokens.json is current
//   node scripts/mobile-theme-tokens.mjs --write  regenerate it after changing styles.css
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTRAST_CONTRACT, EMERGING_CONTRAST, EMERGING_ROLES, HUE_SEPARATION, REQUIRED_TOKENS, contrast, hsl, hueDistance, tokens } from './theme-gate.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MOBILE_TOKENS_PATH = join(root, 'apps', 'mobile', 'src', 'theme', 'tokens.json');

// Semantic roles only. The web's older names (--paper, --ink, --spruce, --teal, --gold, --line,
// --soft, --card) are aliases for these roles and are deliberately not carried: an alias is how
// --red came to mean destruction in one place and the accent in another.
export const ROLES = [...REQUIRED_TOKENS, ...EMERGING_ROLES];
export const RADII = ['--radius-xs', '--radius-s', '--radius-m', '--radius-l', '--radius-xl', '--radius-pill'];

export const camel = (cssName) => cssName.replace(/^--/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

export function buildMobileTokens({ css, themes, retired }) {
  const rootBlock = tokens(css.match(/:root\s*\{([^}]*)\}/)?.[1] || '');
  const painted = new Map([...css.matchAll(/:root\[data-theme=["']([^"']+)["']\]\s*\{([^}]*)\}/g)].map(([, id, block]) => [id, tokens(block)]));
  const radius = Object.fromEntries(RADII.map((name) => {
    const value = rootBlock.get(name);
    if (!value?.endsWith('px')) throw new Error(`${name} is not a px value in styles.css`);
    return [camel(name).replace(/^radius/, '').replace(/^./, (letter) => letter.toLowerCase()), Number.parseFloat(value)];
  }));
  return {
    source: 'Generated from src/styles.css and src/themes.js by scripts/mobile-theme-tokens.mjs. Do not edit by hand.',
    themes: themes.map(({ id, label, base, color }) => {
      const block = id === 'light' ? rootBlock : painted.get(id);
      if (!block) throw new Error(`${id} has no token block in styles.css`);
      const colors = Object.fromEntries(ROLES.map((role) => {
        if (!block.has(role)) throw new Error(`${id} does not define ${role}`);
        return [camel(role), block.get(role)];
      }));
      return { id, label, base, color, colors };
    }),
    retired: { ...retired },
    radius,
  };
}

export async function generate() {
  await import(pathToFileURL(join(root, 'src', 'themes.js')).href);
  return buildMobileTokens({
    css: await readFile(join(root, 'src', 'styles.css'), 'utf8'),
    themes: globalThis.TOGETHER_THEMES,
    retired: globalThis.TOGETHER_RETIRED_THEMES,
  });
}

// The same three rules the web gate holds, applied to what the phone actually reads: every
// theme carries every role and nothing else (no alias to borrow), every text pairing clears
// WCAG AA, and a destructive colour never sits so close in hue to the accent that it reads as
// the same meaning. The three privacy states are held apart the same way.
export function auditMobileTokens(mobile) {
  const problems = [];
  const expectedKeys = ROLES.map(camel).sort().join(',');
  if (mobile.themes?.length !== 4) problems.push(`expected 4 themes, found ${mobile.themes?.length ?? 0}`);
  for (const theme of mobile.themes || []) {
    const colors = theme.colors || {};
    const keys = Object.keys(colors).sort().join(',');
    if (keys !== expectedKeys) problems.push(`${theme.id} must carry exactly the semantic roles ${expectedKeys}; found ${keys}`);
    if (String(theme.color).toUpperCase() !== String(colors.bg).toUpperCase()) problems.push(`${theme.id} color ${theme.color} does not match its bg ${colors.bg}`);
    const value = (role) => colors[camel(role)];
    for (const { name, foreground, background, minimum } of [...CONTRAST_CONTRACT, ...EMERGING_CONTRAST]) {
      const ratio = contrast(value(foreground) || '', value(background) || '');
      if (ratio === null) problems.push(`${theme.id} cannot contrast-check ${name}: ${foreground} on ${background}`);
      else if (ratio < minimum) problems.push(`${theme.id} ${name} is ${ratio.toFixed(2)}:1; requires ${minimum}:1`);
    }
    for (const { name, roles, minimum } of HUE_SEPARATION) {
      // As on the web: a near-neutral private colour carries its meaning by restraint, not hue.
      if (roles.some((role) => role === '--private' && (hsl(value(role))?.saturation ?? 1) < .2)) continue;
      const distance = hueDistance(value(roles[0]), value(roles[1]));
      if (distance === null) problems.push(`${theme.id} cannot compare ${name}`);
      else if (distance < minimum) problems.push(`${theme.id} ${name} are ${distance.toFixed(0)}° apart; requires ${minimum}°`);
    }
  }
  const radiusKeys = Object.keys(mobile.radius || {}).sort().join(',');
  if (radiusKeys !== 'l,m,pill,s,xl,xs') problems.push(`radius scale must be xs, s, m, l, xl, pill; found ${radiusKeys}`);
  return problems;
}

export const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const expected = serialize(await generate());
  if (process.argv.includes('--write')) {
    await writeFile(MOBILE_TOKENS_PATH, expected);
    console.log(`Wrote ${MOBILE_TOKENS_PATH}`);
  } else {
    const current = await readFile(MOBILE_TOKENS_PATH, 'utf8').catch(() => '');
    if (current !== expected) {
      console.error('apps/mobile/src/theme/tokens.json is out of date with src/styles.css. Run: node scripts/mobile-theme-tokens.mjs --write');
      process.exit(1);
    }
    const problems = auditMobileTokens(JSON.parse(current));
    if (problems.length) {
      console.error(`Mobile theme check failed:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
      process.exit(1);
    }
    console.log('✓ mobile theme tokens match src/styles.css and pass the theme gate');
  }
}
