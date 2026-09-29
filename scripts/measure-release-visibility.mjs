// Times how long a freshly deployed revision takes to become visible, from three vantage
// points at once, so the next conversation about the release gate starts from numbers.
//
//   node scripts/measure-release-visibility.mjs --revision <sha> [--minutes 20]
//
// Prints a timeline and, at the end, the first moment each vantage point agreed.

const probeOrigin = 'https://together-ledger-app-public-release-probe.glass-untying-atom.workers.dev';
const appOrigin = 'https://app.together-ledger.com';

const options = { minutes: 20 };
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 2) {
  if (argv[index] === '--revision') options.revision = argv[index + 1];
  if (argv[index] === '--minutes') options.minutes = Number(argv[index + 1]);
}
if (!/^[0-9a-f]{40}$/i.test(options.revision || '')) throw new Error('Pass --revision <full sha>.');

const started = Date.now();
const since = () => `${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s`;

async function askProbe() {
  try {
    const response = await fetch(`${probeOrigin}/verify/${options.revision}`, { headers: { 'cache-control': 'no-cache' } });
    const payload = await response.json().catch(() => null);
    return { ok: payload?.verified === true, detail: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

// Read the marker the way the probe does, and the way a browser would, because a difference
// between those two is itself the answer.
async function askMarker(bust) {
  const url = bust ? `${appOrigin}/release.json?revision=${options.revision}` : `${appOrigin}/release.json`;
  try {
    const response = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
    const payload = await response.json().catch(() => null);
    return { ok: payload?.revision === options.revision, detail: response.headers.get('cf-cache-status') || 'no cf header' };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

const firstAgreement = {};
const note = (name, result) => {
  if (result.ok && !firstAgreement[name]) firstAgreement[name] = Math.round((Date.now() - started) / 1000);
};

console.log(`Watching ${options.revision.slice(0, 12)} for up to ${options.minutes} minutes.\n`);
const deadline = Date.now() + options.minutes * 60_000;
let previous = '';

while (Date.now() < deadline) {
  const [probe, busted, plain] = await Promise.all([askProbe(), askMarker(true), askMarker(false)]);
  note('probe', probe);
  note('marker with query string', busted);
  note('marker plain', plain);

  const line = `probe=${probe.ok} (${probe.detail})  marker?revision=${busted.ok} (${busted.detail})  marker=${plain.ok} (${plain.detail})`;
  if (line !== previous) {
    console.log(`${since()}  ${line}`);
    previous = line;
  }
  if (probe.ok && busted.ok && plain.ok) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

console.log('\nFirst agreement, seconds after this script started:');
for (const name of ['marker plain', 'marker with query string', 'probe']) {
  console.log(`  ${name.padEnd(26)} ${firstAgreement[name] ?? 'never within the window'}`);
}
