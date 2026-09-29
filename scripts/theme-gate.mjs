const REQUIRED_TOKENS = ['--bg', '--fg', '--muted', '--accent', '--border', '--meta-bg', '--on-accent'];

// Roles the design system adds on top of the seven the product ships today. A role stays
// optional until one theme declares it; from that moment every theme must declare it, so a
// partial repaint cannot reach main.
const EMERGING_ROLES = [
  '--surface', '--surface-elevated', '--text-secondary', '--focus',
  '--positive', '--caution', '--destructive',
  '--private', '--shared-now', '--share-later',
];

const CONTRAST_CONTRACT = [
  { name: 'primary text', foreground: '--fg', background: '--bg', minimum: 4.5 },
  { name: 'muted text', foreground: '--muted', background: '--bg', minimum: 4.5 },
  { name: 'links and text actions', foreground: '--accent', background: '--bg', minimum: 4.5 },
  { name: 'primary action text', foreground: '--on-accent', background: '--accent', minimum: 4.5 },
  { name: 'destructive action text', foreground: '--on-accent', background: '--accent', minimum: 4.5 },
  { name: 'focus indicator', foreground: '--accent', background: '--bg', minimum: 3 },
  { name: 'status badge text', foreground: '--on-accent', background: '--accent', minimum: 4.5 },
];

const EMERGING_CONTRAST = [
  { name: 'secondary text', foreground: '--text-secondary', background: '--bg', minimum: 4.5 },
  { name: 'positive status text', foreground: '--positive', background: '--bg', minimum: 4.5 },
  { name: 'caution status text', foreground: '--caution', background: '--bg', minimum: 4.5 },
  { name: 'destructive status text', foreground: '--destructive', background: '--bg', minimum: 4.5 },
  { name: 'focus ring', foreground: '--focus', background: '--bg', minimum: 3 },
  { name: 'focus ring on raised surface', foreground: '--focus', background: '--surface', minimum: 3 },
  // A destructive button borrows the accent's text colour, so that pairing has to hold too.
  { name: 'text on a destructive action', foreground: '--on-accent', background: '--destructive', minimum: 4.5 },
  // The privacy states are printed as words on a card, not only drawn as borders, so each one
  // has to be readable where it is read — otherwise the cue that matters most is the faintest.
  { name: 'private label', foreground: '--private', background: '--surface', minimum: 4.5 },
  { name: 'shared now label', foreground: '--shared-now', background: '--surface', minimum: 4.5 },
  { name: 'share later label', foreground: '--share-later', background: '--surface', minimum: 4.5 },
];

// A destructive action must not read as the ordinary accent, and the three privacy states must
// not read as each other. Hue distance is the check that survives a theme swap.
const HUE_SEPARATION = [
  { name: 'accent and destructive', roles: ['--accent', '--destructive'], minimum: 30 },
  { name: 'private and shared now', roles: ['--private', '--shared-now'], minimum: 30 },
  { name: 'private and share later', roles: ['--private', '--share-later'], minimum: 30 },
  { name: 'shared now and share later', roles: ['--shared-now', '--share-later'], minimum: 30 },
];

const MOMENT_TOKEN_MAP = new Map([
  ['--bg', '--moment-bg'], ['--fg', '--moment-fg'], ['--muted', '--moment-muted'],
  ['--accent', '--moment-accent'], ['--border', '--moment-border'],
  ['--meta-bg', '--moment-meta'], ['--on-accent', '--moment-on-accent'],
  // A privacy cue keeps its own theme's colour inside a scoped card. Without these the label
  // would take the card's background from the moment theme and its colour from the page,
  // which is how a Shared now label ended up at 1.71:1 against the card behind it.
  ['--private', '--moment-private'], ['--shared-now', '--moment-shared-now'],
  ['--share-later', '--moment-share-later'],
]);

export function tokens(block = '') {
  return new Map([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

function rgb(hex) {
  const match = String(hex).trim().match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  return match ? match.slice(1).map((value) => Number.parseInt(value, 16) / 255) : null;
}

export function luminance(hex) {
  const values = rgb(hex);
  if (!values) return null;
  const linear = values.map((channel) => (channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4));
  return .2126 * linear[0] + .7152 * linear[1] + .0722 * linear[2];
}

export function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return a === null || b === null ? null : (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

export function hsl(hex) {
  const values = rgb(hex);
  if (!values) return null;
  const [r, g, b] = values;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (delta === 0) return { hue: 0, saturation: 0, lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  return { hue: (hue + 360) % 360, saturation, lightness };
}

export function hueDistance(first, second) {
  const a = hsl(first);
  const b = hsl(second);
  if (!a || !b) return null;
  const raw = Math.abs(a.hue - b.hue);
  return Math.min(raw, 360 - raw);
}

// A var() that names a custom property nothing ever defines renders as nothing. That is how
// `--soft-red` went unnoticed: the declaration parses, the paint silently does not happen.
export function undefinedVariables(css) {
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name));
  const referenced = new Map();
  for (const match of css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
    const [, name, next] = match;
    if (defined.has(name) || next === ',') continue;
    const line = css.slice(0, match.index).split('\n').length;
    if (!referenced.has(name)) referenced.set(name, line);
  }
  return [...referenced].map(([name, line]) => ({ name, line }));
}

export function auditThemes({ css, themes, momentThemes }) {
  const problems = [];
  const contrastResults = [];

  const painted = new Map();
  for (const match of css.matchAll(/:root\[data-theme=["']([^"']+)["']\]\s*\{([^}]*)\}/g)) {
    painted.set(match[1], match[2]);
  }
  const momentPainted = new Map();
  for (const match of css.matchAll(/\[data-moment-theme=["']([^"']+)["']\]\s*\{([^}]*)\}/g)) {
    momentPainted.set(match[1], match[2]);
  }
  const rootBlock = css.match(/:root\s*\{([^}]*)\}/)?.[1];

  if (themes.length !== 4) problems.push(`expected 4 registered themes, found ${themes.length}`);
  if (new Set(themes.map(({ id }) => id)).size !== themes.length) problems.push('theme ids must be unique');
  if (!rootBlock) problems.push('default :root token block is missing');

  const blockFor = (id) => (id === 'light' ? rootBlock : painted.get(id));
  const declared = new Map(themes.map((theme) => [theme.id, tokens(blockFor(theme.id) || '')]));

  // A role is in force as soon as any theme declares it.
  const activeRoles = EMERGING_ROLES.filter((role) => [...declared.values()].some((values) => values.has(role)));

  for (const theme of themes) {
    const block = blockFor(theme.id);
    if (!block) {
      problems.push(`${theme.id} is registered but has no CSS token block`);
      continue;
    }
    const values = declared.get(theme.id);
    const missing = REQUIRED_TOKENS.filter((token) => !values.has(token));
    if (missing.length) problems.push(`${theme.id} is missing ${missing.join(', ')}`);

    const missingRoles = activeRoles.filter((role) => !values.has(role));
    if (missingRoles.length) {
      problems.push(`${theme.id} does not define ${missingRoles.join(', ')}; a semantic role must exist in every theme once any theme declares it`);
    }

    if (values.get('--bg')?.toUpperCase() !== theme.color.toUpperCase()) {
      problems.push(`${theme.id} browser color ${theme.color} does not match CSS background ${values.get('--bg')}`);
    }

    for (const { name, foreground, background, minimum } of CONTRAST_CONTRACT) {
      const ratio = contrast(values.get(foreground) || '', values.get(background) || '');
      if (ratio === null) problems.push(`${theme.id} cannot contrast-check ${name}: ${foreground} on ${background}`);
      else {
        contrastResults.push(ratio);
        if (ratio < minimum) problems.push(`${theme.id} ${name} is ${ratio.toFixed(2)}:1; requires ${minimum}:1`);
      }
    }

    // A pair is checked once both its ends exist: an emerging role must be in force, and a
    // base token is always in force. Guarding only the foreground would skip a rule whose
    // emerging half is the background.
    const inForce = (token) => (EMERGING_ROLES.includes(token) ? activeRoles.includes(token) : true);
    for (const { name, foreground, background, minimum } of EMERGING_CONTRAST) {
      if (!inForce(foreground) || !inForce(background)) continue;
      if (!values.has(foreground) || !values.has(background)) continue;
      const ratio = contrast(values.get(foreground) || '', values.get(background) || '');
      if (ratio === null) problems.push(`${theme.id} cannot contrast-check ${name}: ${foreground} on ${background}`);
      else {
        contrastResults.push(ratio);
        if (ratio < minimum) problems.push(`${theme.id} ${name} is ${ratio.toFixed(2)}:1; requires ${minimum}:1`);
      }
    }

    for (const { name, roles, minimum } of HUE_SEPARATION) {
      if (!roles.every((role) => role === '--accent' || activeRoles.includes(role))) continue;
      if (!roles.every((role) => values.has(role))) continue;
      // A near-neutral privacy colour carries its meaning by restraint, not by hue.
      const neutral = roles.some((role) => role === '--private' && (hsl(values.get(role))?.saturation ?? 1) < .2);
      if (neutral) continue;
      const distance = hueDistance(values.get(roles[0]), values.get(roles[1]));
      if (distance === null) problems.push(`${theme.id} cannot compare ${name}`);
      else if (distance < minimum) {
        problems.push(`${theme.id} ${name} are ${distance.toFixed(0)}° apart; requires ${minimum}° so they never read as the same meaning`);
      }
    }
  }

  for (const id of painted.keys()) {
    if (!themes.some((theme) => theme.id === id)) problems.push(`${id} has CSS but is not registered`);
  }

  for (const momentTheme of momentThemes) {
    const pageBlock = blockFor(momentTheme.id);
    const momentBlock = momentPainted.get(momentTheme.id);
    if (!pageBlock || !momentBlock) {
      problems.push(`${momentTheme.id} approved moment theme is missing its named page or card treatment`);
      continue;
    }
    const pageValues = tokens(pageBlock);
    const momentValues = tokens(momentBlock);
    for (const [pageToken, momentToken] of MOMENT_TOKEN_MAP) {
      if (pageValues.get(pageToken)?.replaceAll(' ', '') !== momentValues.get(momentToken)?.replaceAll(' ', '')) {
        problems.push(`${momentTheme.id} moment ${momentToken} must match its named ${pageToken}`);
      }
    }
  }
  if (momentThemes.length !== 4) problems.push(`expected 4 approved moment themes, found ${momentThemes.length}`);

  for (const { name, line } of undefinedVariables(css)) {
    problems.push(`${name} is used at styles.css:${line} but never defined; it paints nothing`);
  }

  return {
    problems,
    activeRoles,
    contrastResults,
    stats: {
      themes: themes.length,
      light: themes.filter(({ base }) => base === 'light').length,
      dark: themes.filter(({ base }) => base === 'dark').length,
      momentThemes: momentThemes.length,
      pairings: themes.length * momentThemes.length,
      contrastPairs: contrastResults.length,
      minimumContrast: contrastResults.length ? Math.min(...contrastResults) : null,
    },
  };
}

export { REQUIRED_TOKENS, EMERGING_ROLES };
