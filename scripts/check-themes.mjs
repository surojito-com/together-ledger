import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditThemes } from './theme-gate.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await import(join(root, 'src', 'themes.js'));
const { MOMENT_THEMES } = await import(join(root, 'src', 'moment-themes.js'));

const { problems, stats, activeRoles } = auditThemes({
  css: await readFile(join(root, 'src', 'styles.css'), 'utf8'),
  themes: globalThis.TOGETHER_THEMES || [],
  momentThemes: MOMENT_THEMES,
});

if (problems.length) {
  console.error(`Theme check failed:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  process.exit(1);
}

const roles = activeRoles.length
  ? `${activeRoles.length} semantic roles beyond the base seven`
  : 'base seven tokens only';
console.log(`✓ theme check passed — ${stats.themes} page themes (${stats.light} light, ${stats.dark} dark), ${stats.momentThemes} approved moment themes, ${stats.pairings} scoped pairings, ${roles}, ${stats.contrastPairs} WCAG AA text pairs, minimum ${stats.minimumContrast.toFixed(2)}:1.`);
