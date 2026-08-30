import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await import(join(root, 'src', 'themes.js'));
const themes = globalThis.TOGETHER_THEMES || [];
const css = await readFile(join(root, 'src', 'styles.css'), 'utf8');
const requiredTokens = ['--bg', '--fg', '--muted', '--accent', '--border', '--meta-bg', '--on-accent'];
const problems = [];
const contrastResults = [];
const contrastContract = [
  { name: 'primary text', foreground: '--fg', background: '--bg', minimum: 4.5 },
  { name: 'muted text', foreground: '--muted', background: '--bg', minimum: 4.5 },
  { name: 'links and text actions', foreground: '--accent', background: '--bg', minimum: 4.5 },
  { name: 'primary action text', foreground: '--on-accent', background: '--accent', minimum: 4.5 },
  { name: 'destructive action text', foreground: '--on-accent', background: '--accent', minimum: 4.5 },
  { name: 'focus indicator', foreground: '--accent', background: '--bg', minimum: 3 },
  { name: 'status badge text', foreground: '--on-accent', background: '--accent', minimum: 4.5 },
];

const painted = new Map();
for (const match of css.matchAll(/:root\[data-theme=["']([^"']+)["']\]\s*\{([^}]*)\}/g)) {
  painted.set(match[1], match[2]);
}
const rootBlock = css.match(/:root\s*\{([^}]*)\}/)?.[1];

function tokens(block = '') {
  return new Map([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

function luminance(hex) {
  const match = hex.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (!match) return null;
  const values = match.slice(1).map((value) => {
    const channel = Number.parseInt(value, 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
}

function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return a === null || b === null ? null : (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

if (themes.length !== 16) problems.push(`expected 16 registered themes, found ${themes.length}`);
if (new Set(themes.map(({ id }) => id)).size !== themes.length) problems.push('theme ids must be unique');
if (!rootBlock) problems.push('default :root token block is missing');

for (const theme of themes) {
  const block = theme.id === 'light' ? rootBlock : painted.get(theme.id);
  if (!block) {
    problems.push(`${theme.id} is registered but has no CSS token block`);
    continue;
  }
  const values = tokens(block);
  const missing = requiredTokens.filter((token) => !values.has(token));
  if (missing.length) problems.push(`${theme.id} is missing ${missing.join(', ')}`);
  if (values.get('--bg')?.toUpperCase() !== theme.color.toUpperCase()) {
    problems.push(`${theme.id} browser color ${theme.color} does not match CSS background ${values.get('--bg')}`);
  }
  for (const { name, foreground, background, minimum } of contrastContract) {
    const ratio = contrast(values.get(foreground) || '', values.get(background) || '');
    if (ratio === null) problems.push(`${theme.id} cannot contrast-check ${name}: ${foreground} on ${background}`);
    else {
      contrastResults.push(ratio);
      if (ratio < minimum) problems.push(`${theme.id} ${name} is ${ratio.toFixed(2)}:1; requires ${minimum}:1`);
    }
  }
}

for (const id of painted.keys()) {
  if (!themes.some((theme) => theme.id === id)) problems.push(`${id} has CSS but is not registered`);
}

if (problems.length) {
  console.error(`Theme check failed:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  process.exit(1);
}

const light = themes.filter(({ base }) => base === 'light').length;
const dark = themes.filter(({ base }) => base === 'dark').length;
console.log(`✓ theme check passed — ${themes.length} themes (${light} light, ${dark} dark), ${contrastResults.length} WCAG AA text pairs, minimum ${Math.min(...contrastResults).toFixed(2)}:1.`);
