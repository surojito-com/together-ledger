import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const mobile = new URL('../apps/mobile/', import.meta.url);

// The phone's own TypeScript, compiled on the spot, so these tests exercise the code the app runs.
async function importMobile(path) {
  const source = await readFile(new URL(path, mobile), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}
const read = (path) => readFile(new URL(path, mobile), 'utf8');
const web = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');

const { STATUS_TONES, CONNECTION_MESSAGES, showStatus, clearStatus, closeDialog } = await importMobile('src/shell/status.ts');
const { OFFLINE_NOTICE, CONNECTION_SOURCE, connectionChange } = await importMobile('src/shell/connection.ts');
const { OFFLINE_MESSAGE, UNREACHABLE_MESSAGE, UNAVAILABLE_MESSAGE } = await importMobile('src/api/client.ts');
const { openingSurface } = await importMobile('src/shell/surface.ts');
const { TOAST_MS, PENDING_LABEL, KEEP_LABEL } = await importMobile('src/shell/defaults.ts');

test('the status region carries the web\'s two tones, each with its own shape', () => {
  assert.deepEqual(Object.keys(STATUS_TONES), ['caution', 'problem']);
  assert.match(web, new RegExp(`caution: \\{ glyph: '${STATUS_TONES.caution.glyph}'`));
  assert.match(web, new RegExp(`problem: \\{ glyph: '${STATUS_TONES.problem.glyph}'`));
  assert.deepEqual(showStatus('Could not save.'), { message: 'Could not save.', tone: 'problem', source: 'action', inDialog: false }, 'a message is a problem from an action unless told otherwise');
  assert.equal(showStatus('Odd tone', { tone: 'celebration' }).tone, 'problem');
});

test('messages clear per source, so a returning connection never wipes a problem nobody has read', () => {
  const offline = showStatus('You are offline.', { tone: 'caution', source: 'connection' });
  const problem = showStatus('Password confirmation failed.');
  assert.equal(clearStatus(problem, 'connection'), problem, 'reconnecting leaves the unread problem');
  assert.equal(clearStatus(offline, 'connection'), null, 'reconnecting clears its own notice');
  assert.equal(clearStatus(problem), null, 'Dismiss clears whatever is showing');
  assert.equal(clearStatus(null, 'connection'), null);
});

// #300, #352: offline, or the service out of reach, loses nothing, so it is never the
// destructive colour. Every other message keeps its tone until #244 decides otherwise.
test('being offline or out of reach is a caution, never a problem', () => {
  assert.deepEqual([...CONNECTION_MESSAGES], [OFFLINE_MESSAGE, UNREACHABLE_MESSAGE, UNAVAILABLE_MESSAGE], 'the account client\'s own words, held the same in both files');
  assert.equal(OFFLINE_MESSAGE, OFFLINE_NOTICE, 'offline is one message on the phone: the connection notice\'s (#352)');
  assert.equal(showStatus(OFFLINE_MESSAGE, { source: 'moment' }).tone, 'caution');
  assert.equal(showStatus(UNAVAILABLE_MESSAGE).tone, 'caution');
  assert.equal(showStatus('The service could not complete that request.').tone, 'problem', 'other problems are left as they are');
  assert.equal(showStatus(OFFLINE_MESSAGE, { tone: 'problem' }).tone, 'problem', 'a caller that names a tone still gets it');
});

test('the phone watches its connection, shows a standing caution, and clears it when the connection returns', async () => {
  assert.equal(connectionChange(null, false), 'went-offline', 'opening the app offline says so');
  assert.equal(connectionChange(null, true), null, 'opening it online changes nothing');
  assert.equal(connectionChange(true, false), 'went-offline');
  assert.equal(connectionChange(false, true), 'came-back');
  assert.equal(connectionChange(false, false), null);
  assert.equal(connectionChange(false, null), null, 'not knowing yet is not coming back');

  // The web promises that anything "will wait". On the phone only a moment held now waits (#352),
  // so the notice says that, and that nothing else can be changed. The owner's Oct 8 wording
  // (#361) said nothing could be held; that stopped being true when held moments began to wait.
  assert.equal(OFFLINE_NOTICE, 'You’re offline. A moment you hold now waits on this phone and is sent when you reconnect. Your journeys will be back then; until then, nothing else can be changed.');
  assert.match(OFFLINE_NOTICE, /nothing else can be changed/);

  const layout = await read('app/_layout.tsx');
  assert.match(layout, /onOffline: \(\) => showStatus\(OFFLINE_NOTICE, \{ tone: 'caution', source: CONNECTION_SOURCE \}\)/);
  assert.match(layout, /onOnline: \(\) => \{\s*clearStatus\(CONNECTION_SOURCE\);\s*recheck\(\);/, 'back online clears only its own notice, then checks again');
  assert.match(layout, /onForeground: recheck/);
  assert.match(layout, /const recheck = useCallback\(\(\) => \{\s*refresh\(\)\.then\(sendNow\);\s*reload\(\);/, 'checking again means the session, what waits to be sent, and the journeys, with no restart or password');
  assert.equal(CONNECTION_SOURCE, 'connection');

  const watch = await read('src/shell/use-connection.ts');
  assert.match(watch, /from '@react-native-community\/netinfo'/);
  assert.match(watch, /NetInfo\.configure\(\{ reachabilityShouldRun: \(\) => false \}\)/, 'the library never asks Google whether the internet can be reached');
  assert.match(watch, /AppState\.addEventListener\('change'/);
});

test('a problem raised inside a dialog leaves with it; one raised on the screen stays', () => {
  const inside = showStatus('Password confirmation failed.', { inDialog: true });
  const outside = showStatus('Could not save.');
  assert.equal(closeDialog(inside), null);
  assert.equal(closeDialog(outside), outside);
  assert.equal(closeDialog(null), null);
});

test('someone who has begun their ledger opens on it; everyone else meets the welcome', async () => {
  assert.equal(openingSurface({ onboardingComplete: true }), 'ledger');
  assert.equal(openingSurface({ onboardingComplete: false }), 'welcome');
  assert.equal(openingSurface(null), 'welcome');
  const index = await read('app/index.tsx');
  assert.match(index, /openingSurface\(\{ onboardingComplete: shell\.onboardingComplete \}\) === 'ledger'\) return <Redirect href="\/ledger" \/>/);
  assert.match(index, /shell\.completeOnboarding\(\);\s*router\.replace\('\/ledger'\)/, 'beginning is remembered, and the welcome is not left behind to go back to');
});

test('toast timing, pending wording and the way out are the web\'s own', async () => {
  assert.equal(TOAST_MS, 2600);
  assert.match(web, /setTimeout\(\(\) => toast\.classList\.remove\('show'\), 2600\)/);
  assert.ok(web.includes(`pendingLabel = '${PENDING_LABEL}'`));
  assert.ok(web.includes(`keepLabel = '${KEEP_LABEL}'`));
  const ui = await read('src/components/ui.tsx');
  assert.match(ui, /pendingLabel = PENDING_LABEL/);
  assert.match(ui, /accessibilityState=\{\{ disabled: disabled \|\| pending, busy: pending \}\}/, 'a pending button is disabled and says it is busy');
});

test('the consequence dialog names the act, opens on the way out, and is destructive only when asked', async () => {
  const provider = await read('src/shell/shell-provider.tsx');
  const dialog = await read('src/components/dialogs.tsx');
  assert.match(provider, /confirmConsequence: \(\{ title, consequence, confirmLabel, keepLabel = KEEP_LABEL, destructive = false \}\)/);
  assert.match(dialog, /Before this happens/);
  const keep = dialog.indexOf('ref={keep}');
  const accept = dialog.indexOf("kind={request.destructive ? 'destructive' : 'primary'}");
  assert.ok(keep > 0 && accept > keep, 'keep comes first, accept second, destructive only on request');
  assert.match(dialog, /onShow=\{focusKeep\}/, 'focus opens on the way out');
  assert.match(dialog, /onRequestClose=\{\(\) => onClose\(false\)\}/, 'the back gesture keeps things as they are');
  assert.match(dialog, /<StatusRegion place="dialog" \/>/, 'a problem raised in a dialog is shown in the dialog');
  assert.doesNotMatch(provider, /from '\.\.\/components\//, 'the shell\'s rules import no screen pieces, so nothing imports in a circle');
  assert.match(provider, /confirm: \(\{ title, message, confirmLabel, keepLabel = 'Cancel', destructive = false \}\)/, 'the plain dialog is the same frame without the consequence framing');
});

test('every screen carries the one status region, and only the screen in front shows it', async () => {
  const ui = await read('src/components/ui.tsx');
  const region = await read('src/components/status-region.tsx');
  assert.match(ui, /<ScreenStatusRegion \/>/);
  assert.match(region, /const focused = useIsFocused\(\)/);
  assert.match(region, /const here = place === 'dialog' \|\| !dialogOpen/, 'while a dialog is open the region moves into it');
  assert.match(region, /accessibilityLiveRegion="polite"/);
});

test('settings offers every theme, and following the phone', async () => {
  const settings = await read('app/settings.tsx');
  const picker = await read('src/components/theme-picker.tsx');
  assert.match(settings, /<ThemePicker \/>/);
  assert.match(picker, /\.\.\.themes\.map\(/, 'the picker lists the theme catalogue itself, not a hand-kept subset');
  assert.match(picker, /accessibilityRole="radio"/);
  assert.match(picker, /\{selected \? '●' : '○'\}/, 'the choice is a shape as well as a border colour');
});

test('nothing tappable in the shell is under 44 points, and nothing sits under a notch', async () => {
  for (const file of ['src/components/ui.tsx', 'src/components/status-region.tsx', 'src/components/theme-picker.tsx', 'app/_layout.tsx']) {
    const source = await read(file);
    const pressables = source.split('<Pressable').length - 1;
    const sized = (source.match(/<Pressable[\s\S]*?targetSize[\s\S]*?>/g) || []).length;
    assert.equal(sized, pressables, `${file} has a Pressable without targetSize`);
  }
  const index = await read('app/index.tsx');
  assert.match(index, /edges=\{\['top', 'bottom', 'left', 'right'\]\}/, 'the headerless welcome keeps clear of the notch');
  const dialog = await read('src/components/dialogs.tsx');
  assert.match(dialog, /paddingTop: insets\.top/);
  const toast = await read('src/components/toast.tsx');
  assert.match(toast, /bottom: insets\.bottom \+ 20/);
});
