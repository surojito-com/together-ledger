import test from 'node:test';
import assert from 'node:assert/strict';
import { auditThemes, hueDistance, hsl, undefinedVariables } from '../scripts/theme-gate.mjs';

const BASE = {
  '--bg': '#FFFFFF', '--fg': '#1A1A1A', '--muted': '#595959', '--accent': '#0B5AA8',
  '--border': '#DDDDDD', '--meta-bg': '#F2F2F2', '--on-accent': '#FFFFFF',
};
const THEME_IDS = ['light', 'dark', 'green', 'flexoki'];
const MOMENT_IDS = ['light', 'dark', 'green', 'flexoki'];

function declaration(values) {
  return Object.entries(values).map(([name, value]) => `${name}: ${value};`).join(' ');
}

// Builds a registry and stylesheet that satisfy every existing rule, so a test only has to
// introduce the one defect it is about.
function fixture({ extra = {}, extraFor = THEME_IDS } = {}) {
  const themes = THEME_IDS.map((id) => ({ id, label: id, base: id === 'light' ? 'light' : 'dark', color: BASE['--bg'] }));
  const momentThemes = MOMENT_IDS.map((id) => ({ id, label: id, base: 'light', color: BASE['--bg'] }));
  const valuesFor = (id) => ({ ...BASE, ...(extraFor.includes(id) ? extra : {}) });

  const blocks = THEME_IDS.map((id) => (id === 'light'
    ? `:root { ${declaration(valuesFor(id))} }`
    : `:root[data-theme="${id}"] { ${declaration(valuesFor(id))} }`));

  const momentBlocks = MOMENT_IDS.map((id) => `[data-moment-theme="${id}"] { --moment-bg: ${BASE['--bg']}; --moment-fg: ${BASE['--fg']}; --moment-muted: ${BASE['--muted']}; --moment-accent: ${BASE['--accent']}; --moment-border: ${BASE['--border']}; --moment-meta: ${BASE['--meta-bg']}; --moment-on-accent: ${BASE['--on-accent']}; }`);

  return { css: [...blocks, ...momentBlocks].join('\n'), themes, momentThemes };
}

const audit = (options) => auditThemes(fixture(options));
const complains = (problems, fragment) => problems.some((problem) => problem.includes(fragment));

test('a conforming stylesheet passes with the base seven tokens only', () => {
  const { problems, activeRoles, stats } = audit();
  assert.deepEqual(problems, []);
  assert.deepEqual(activeRoles, []);
  assert.equal(stats.themes, 4);
  assert.equal(stats.momentThemes, 4);
  assert.equal(stats.pairings, 16);
});

test('a semantic role declared by one theme becomes required in every theme', () => {
  const { problems, activeRoles } = audit({ extra: { '--destructive': '#B3261E' }, extraFor: ['light'] });
  assert.deepEqual(activeRoles, ['--destructive']);
  assert.ok(complains(problems, 'dark does not define --destructive'));
  assert.ok(complains(problems, 'a semantic role must exist in every theme once any theme declares it'));
});

test('a role declared consistently across every theme is accepted', () => {
  const { problems, activeRoles } = audit({ extra: { '--destructive': '#B3261E' } });
  assert.deepEqual(problems, []);
  assert.deepEqual(activeRoles, ['--destructive']);
});

test('a destructive role too close in hue to the accent is rejected', () => {
  // #0B5AA8 and #0B72A8 are both blues; a delete button must not read as an ordinary action.
  const { problems } = audit({ extra: { '--destructive': '#0B72A8' } });
  assert.ok(complains(problems, 'accent and destructive'));
  assert.ok(complains(problems, 'requires 30°'));
});

test('privacy roles that read as each other are rejected', () => {
  const { problems } = audit({
    extra: { '--private': '#1F7A3D', '--shared-now': '#1F7A55', '--share-later': '#1F7A66' },
  });
  assert.ok(complains(problems, 'shared now and share later'));
});

test('a near-neutral private colour is exempt from hue separation', () => {
  // Restraint, not hue, carries the meaning of private — a grey must stay legal.
  const { problems } = audit({
    extra: { '--private': '#6B6B6B', '--shared-now': '#1F7A3D', '--share-later': '#7A5A1F' },
  });
  assert.ok(!complains(problems, 'private and shared now'));
  assert.ok(!complains(problems, 'private and share later'));
});

test('an unreadable status role is rejected on contrast', () => {
  const { problems } = audit({ extra: { '--positive': '#BFE3C8' } });
  assert.ok(complains(problems, 'positive status text'));
  assert.ok(complains(problems, 'requires 4.5:1'));
});

test('a focus ring too faint against the background is rejected', () => {
  const { problems } = audit({ extra: { '--focus': '#E8E8E8' } });
  assert.ok(complains(problems, 'focus ring'));
});

test('unreadable text on a destructive action is rejected', () => {
  // The rule's emerging half is the background, so it also guards against a pair being
  // skipped because only the foreground was checked for being in force.
  const { problems } = audit({ extra: { '--destructive': '#F2C4C4' } });
  assert.ok(complains(problems, 'text on a destructive action'));
});

test('a legible destructive action is accepted', () => {
  const { problems } = audit({ extra: { '--destructive': '#B3261E' } });
  assert.ok(!complains(problems, 'text on a destructive action'));
});

test('a privacy label too faint to read on a card is rejected', () => {
  // These are printed as words, not only drawn as borders, so a value tuned for a 5px rule
  // can still be unreadable as text — which is how the cue that matters most goes faint.
  const { problems } = audit({
    extra: { '--surface': '#FFFFFF', '--private': '#B9B9B9', '--shared-now': '#1F7A3D', '--share-later': '#8A5A12' },
  });
  assert.ok(complains(problems, 'private label'));
  assert.ok(!complains(problems, 'shared now label'));
});

test('legible privacy labels are accepted', () => {
  const { problems } = audit({
    extra: { '--surface': '#FFFFFF', '--private': '#5E5D58', '--shared-now': '#1F7A3D', '--share-later': '#8A5A12' },
  });
  assert.ok(!complains(problems, 'private label'));
  assert.ok(!complains(problems, 'shared now label'));
  assert.ok(!complains(problems, 'share later label'));
});

test('existing contrast and registry rules still hold', () => {
  const broken = fixture();
  broken.css = broken.css.replace('--muted: #595959;', '--muted: #BBBBBB;');
  assert.ok(complains(auditThemes(broken).problems, 'muted text'));

  const mismatched = fixture();
  mismatched.themes[1].color = '#000000';
  assert.ok(complains(auditThemes(mismatched).problems, 'does not match CSS background'));

  const orphaned = fixture();
  orphaned.css += '\n:root[data-theme="unregistered"] { --bg: #FFFFFF; }';
  assert.ok(complains(auditThemes(orphaned).problems, 'unregistered has CSS but is not registered'));
});

test('a moment theme that drifts from its named page theme is rejected', () => {
  const drifted = fixture();
  drifted.css = drifted.css.replace('--moment-accent: #0B5AA8;', '--moment-accent: #AA0000;');
  assert.ok(complains(auditThemes(drifted).problems, 'moment --moment-accent must match its named --accent'));
});

test('a custom property that nothing defines is reported with its line', () => {
  const found = undefinedVariables(':root { --real: #FFF; }\n.a { color: var(--ghost); }');
  assert.deepEqual(found, [{ name: '--ghost', line: 2 }]);
});

test('a defined property, and a fallback, are both left alone', () => {
  assert.deepEqual(undefinedVariables(':root { --real: #FFF; }\n.a { color: var(--real); }'), []);
  assert.deepEqual(undefinedVariables('.a { color: var(--ghost, #FFF); }'), []);
});

test('the dead custom properties that shipped to production would now fail the gate', () => {
  const regression = fixture();
  regression.css += '\n.status-chip.open { background: var(--soft-red); color: var(--red); }';
  assert.ok(complains(auditThemes(regression).problems, '--soft-red is used at styles.css:'));
  assert.ok(complains(auditThemes(regression).problems, 'it paints nothing'));
});

test('hue and saturation are measured as colour, not as bytes', () => {
  assert.equal(Math.round(hueDistance('#FF0000', '#00FF00')), 120);
  assert.equal(Math.round(hueDistance('#FF0000', '#FF0000')), 0);
  // The short way round the wheel, not the long one.
  assert.equal(Math.round(hueDistance('#FF0010', '#FF1000')), 8);
  assert.ok(hsl('#6B6B6B').saturation < .2);
  assert.ok(hsl('#0B5AA8').saturation > .2);
});
