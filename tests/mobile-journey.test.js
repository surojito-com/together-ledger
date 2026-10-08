import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import * as model from '../src/model.js';
import * as momentThemes from '../src/moment-themes.js';

const mobile = new URL('../apps/mobile/', import.meta.url);
const read = (path) => readFile(new URL(path, mobile), 'utf8');
const web = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const tokens = JSON.parse(await read('src/theme/tokens.json'));

// The phone's own TypeScript, compiled on the spot. Its relative imports of the web's modules
// are pointed at the real files, so the phone and these tests share one copy of each.
async function importMobile(path) {
  const url = new URL(path, mobile);
  const source = await readFile(url, 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const linked = outputText.replace(/from '(\.[^']+\.js)'/g, (_, specifier) => `from '${new URL(specifier, url).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(linked).toString('base64')}`);
}

const view = await importMobile('src/journey/journey-view.ts');

// The web's own function, lifted out of src/app.js, so the phone is compared with what the web
// actually runs rather than with a description of it.
function webFunction(name, ...scope) {
  const start = web.indexOf(`function ${name}(`);
  let depth = 0;
  let end = web.indexOf('{', start);
  for (; end < web.length; end += 1) {
    if (web[end] === '{') depth += 1;
    if (web[end] === '}' && --depth === 0) break;
  }
  return new Function(...scope.map(([key]) => key), `${web.slice(start, end + 1)}; return ${name};`)(...scope.map(([, value]) => value));
}

test('dates, money and moment types are the web\'s own functions, not copies', () => {
  assert.equal(view.dateLabel, model.dateLabel);
  assert.equal(view.money, model.money);
  assert.equal(view.MOMENT_TYPES, model.MOMENT_TYPES);
  assert.equal(view.normalizeMomentTheme, momentThemes.normalizeMomentTheme);
  assert.equal(view.moneyContext({ moneyCents: 1250, moneyCurrency: 'USD' }), `${model.money(1250, 'USD')} is held here as context, not a score.`);
  assert.ok(web.includes('is held here as context, not a score.</p>'));
  assert.equal(view.moneyContext({ moneyCents: null }), null);
});

test('a journey\'s period and a moment\'s label read exactly as the web writes them', () => {
  const journeyPeriod = webFunction('journeyPeriod', ['dateLabel', model.dateLabel]);
  const momentLabel = webFunction('momentLabel', ['MOMENT_TYPES', model.MOMENT_TYPES]);
  const journeys = [
    { location: 'Marlow', startDate: '2026-05-14', startDateStatus: 'exact', endDate: '2026-06-18', endDateStatus: 'date' },
    { location: '', startDateStatus: 'unknown', endDateStatus: 'forever' },
    { startDate: '2026-01-02', startDateStatus: 'exact', endDateStatus: 'unsure' },
  ];
  for (const journey of journeys) assert.equal(view.journeyPeriod(journey), journeyPeriod(journey));
  for (const [kind, kindLabel] of [['memory'], ['other', 'Our word'], ['other', ''], ['retired-kind']]) assert.equal(view.momentLabel(kind, kindLabel), momentLabel(kind, kindLabel));
});

test('every visibility is told by shape and word, and anything unknown reads as private', () => {
  const cue = webFunction('visibilityCue', ['VISIBILITY_CUES', view.VISIBILITY_CUES]);
  for (const [visibility, { glyph, label }] of Object.entries(view.VISIBILITY_CUES)) {
    assert.ok(web.includes(`'${visibility}': { glyph: '${glyph}', label: '${label}' }`) || web.includes(`${visibility}: { glyph: '${glyph}', label: '${label}' }`), `${visibility} matches the web`);
  }
  for (const visibility of ['private', 'share-later', 'shared-now', 'something-new', '']) assert.deepEqual(view.visibilityCue(visibility), cue(visibility));
  assert.equal(view.visibilityCue('something-new').glyph, '○', 'an unknown visibility takes the private ring');
  assert.equal(view.visibilityRole('something-new'), 'private', 'and the private colour, never a shared one');
  assert.equal(view.visibilityRole('shared-now'), 'sharedNow');
  assert.equal(view.visibilityRole('share-later'), 'shareLater');
});

test('moments are newest first, carry their photos, and the list opens on three', () => {
  const moment = (id, kind, occurredOn, updatedAt = '2026-08-01T00:00:00.000Z') => ({ id, journeyId: 'j', kind, occurredOn, updatedAt, title: id, visibility: 'shared-now' });
  const snapshot = {
    journey: { id: 'j', name: 'Ours' },
    moments: [moment('a', 'memory', '2026-05-01'), moment('b', 'promise', '2026-07-01'), moment('c', 'memory', '2026-07-01', '2026-08-02T00:00:00.000Z'), moment('d', 'feeling', '2026-06-01')],
    images: [{ id: 'i1', momentId: 'c', filename: 'Sea.jpg', deletedAt: null }, { id: 'i2', momentId: 'c', filename: 'Old.jpg', deletedAt: '2026-08-03T00:00:00.000Z' }],
    concerns: [{ id: 't1', title: 'Open', status: 'open' }, { id: 't2', title: 'Settled', status: 'resolved' }],
  };
  const recent = view.recentMoments(snapshot);
  assert.deepEqual(recent.map(({ id }) => id), ['c', 'b', 'd', 'a']);
  assert.deepEqual(recent[0].images.map(({ id }) => id), ['i1']);
  assert.deepEqual(recent[0].removedImages.map(({ id }) => id), ['i2']);
  assert.deepEqual(view.shownMoments(recent, { expanded: false, filter: 'all' }).map(({ id }) => id), ['c', 'b', 'd']);
  assert.deepEqual(view.shownMoments(recent, { expanded: true, filter: 'memory' }).map(({ id }) => id), ['c', 'a']);
  // "See all 1 moment", never "See all 1 moments", on the phone and the web alike (#337).
  assert.equal(view.seeAllLabel(1), 'See all 1 moment');
  assert.equal(view.seeAllLabel(4), 'See all 4 moments');
  assert.ok(web.includes("`See all ${countOf(recent.length, 'moment', 'moments')}`"), 'the web builds its label the same way');
  // Shown only when the ledger is not already showing every moment (the owner, on #337).
  assert.equal(view.seeAllShown, model.seeAllShown, 'the phone uses the web\'s own rule');
  assert.ok(web.includes("$('#toggle-moments-button').hidden = !seeAllShown(recent.length, momentsExpanded);"));
  assert.ok(web.includes('recent.slice(0, RECENT_MOMENTS_SHOWN)'), 'and the web shows as many as the rule counts');
  assert.deepEqual(view.momentFilters(recent).map(([value]) => value), ['all', 'promise', 'memory', 'feeling'], 'only types in use, in the web\'s order');
  assert.deepEqual(view.openThreads(snapshot).map(({ id }) => id), ['t1']);
  assert.equal(view.chooseJourney([{ id: 'x' }, { id: 'y' }], 'y'), 'y');
  assert.equal(view.chooseJourney([{ id: 'x' }, { id: 'y' }], 'gone'), 'x');
  assert.equal(view.chooseJourney([], null), null);
});

test('a moment\'s own atmosphere is painted in the same colours on the phone as on the web', () => {
  const roles = { bg: 'bg', fg: 'fg', muted: 'muted', accent: 'accent', border: 'border', meta: 'metaBg', 'on-accent': 'onAccent', private: 'private', 'shared-now': 'sharedNow', 'share-later': 'shareLater' };
  for (const { id } of momentThemes.MOMENT_THEMES) {
    const rule = css.match(new RegExp(`\\[data-moment-theme="${id}"\\] \\{([^}]*)\\}`))[1];
    const colors = tokens.themes.find((theme) => theme.id === id).colors;
    for (const [cssName, role] of Object.entries(roles)) {
      const value = rule.match(new RegExp(`--moment-${cssName}: ([^;]+);`))[1].trim();
      assert.equal(colors[role].replaceAll(' ', '').toLowerCase(), value.replaceAll(' ', '').toLowerCase(), `${id} ${role}`);
    }
  }
});

test('the visibility cue is drawn with the moment, never after it', async () => {
  const card = await read('src/components/moment-card.tsx');
  const body = card.slice(card.indexOf('export function MomentCard'), card.indexOf('function Chip'));
  assert.doesNotMatch(body, /useEffect|useState|await/, 'nothing about the card itself waits: its cue arrives with its title');
  assert.match(body, /const cue = visibilityCue\(moment\.visibility\)/);
  assert.match(body, /borderLeftColor: cueColor/, 'the border carries it');
  assert.match(body, /\{cue\.glyph\} <\/Text>\s*\{cue\.label\}/, 'the shape and the word carry it');
  assert.match(body, /accessibilityLabel=\{`Visibility: \$\{cue\.label\}`\}/, 'and a screen reader says it');
});

test('switching journey, or account, never shows one journey\'s moments under another', async () => {
  const hook = await read('src/journey/use-journey.ts');
  assert.match(hook, /select: \(journeyId: string\) => \{\s*if \(!userId \|\| journeyId === activeId\) return;\s*setHeld\(\{ forUser: userId, state: \{ phase: 'loading' \} \}\);/);
  assert.match(hook, /held\?\.forUser === userId \? held\.state : \{ phase: 'loading' \}/, 'what is held belongs to the account that loaded it');
  assert.match(hook, /if \(attempt !== latest\.current\) return;/, 'an answer that arrives late is dropped');
});

test('the phone asks for journeys, snapshots and photos as the signed-in app', async () => {
  const { createAccountClient } = await importMobile('src/api/client.ts');
  let held = { token: 'access-1', tokenExpiresAt: '2026-10-01T00:00:30.000Z', refreshToken: 'refresh-1', refreshTokenExpiresAt: '2026-10-30T00:00:00.000Z' };
  const calls = [];
  const client = createAccountClient({
    base: () => 'https://api.example.test/api/v1',
    tokens: { read: async () => held, write: async (value) => { held = value; }, clear: async () => { held = null; } },
    fetch: async (url, init) => {
      calls.push(`${init.method} ${url} ${init.headers.Authorization || ''}`.trim());
      const data = url.endsWith('/auth/refresh')
        ? { user: { id: 'u' }, token: 'access-2', tokenExpiresAt: '2026-10-01T01:00:00.000Z', refreshToken: 'refresh-2', refreshTokenExpiresAt: '2026-10-30T00:00:00.000Z' }
        : url.endsWith('/journeys') ? { journeys: [{ id: 'j 1' }] } : { journey: { id: 'j 1' }, moments: [] };
      return { ok: true, status: 200, json: async () => ({ data }) };
    },
  });
  assert.deepEqual(await client.journeys(), [{ id: 'j 1' }]);
  await client.snapshot('j 1');
  const photo = await client.imageSource('j 1', 'm', 'i', Date.parse('2026-10-01T00:00:00.000Z'));
  assert.deepEqual(calls, [
    'GET https://api.example.test/api/v1/journeys Bearer access-1',
    'GET https://api.example.test/api/v1/journeys/j%201/snapshot Bearer access-1',
    'POST https://api.example.test/api/v1/auth/refresh',
  ], 'a token with under a minute left is refreshed before a photo is asked for');
  assert.deepEqual(photo, { uri: 'https://api.example.test/api/v1/journeys/j%201/moments/m/images/i', headers: { Authorization: 'Bearer access-2', 'x-together-client': 'app' } });
});

test('pull to refresh re-reads the snapshot, and the list only draws what is on screen', async () => {
  const ledger = await read('app/ledger.tsx');
  assert.match(ledger, /<FlatList/, 'a virtualised list, so photos load as their moments scroll in');
  assert.match(ledger, /\{seeAllShown\(recent\.length, expanded\) \? <Button kind="quiet" label=\{expanded \? 'Show recent' : seeAllLabel\(recent\.length\)\}/, '"See all" only when there is more to see (#337)');
  assert.match(ledger, /<RefreshControl refreshing=\{journey\.refreshing\} onRefresh=\{journey\.refresh\}/);
  assert.match(ledger, /<EmptyState title="No moments in this view" body="A small truth is enough to begin, or choose another filter to see more\." \/>/);
  assert.ok(web.includes("emptyState('No moments in this view', 'A small truth is enough to begin, or choose another filter to see more.')"));
  assert.ok(web.includes("emptyState('No open threads', 'That can be a good place to rest.', { compact: true })"));
  assert.match(ledger, /<EmptyState compact title="No open threads" body="That can be a good place to rest\." \/>/);
});
