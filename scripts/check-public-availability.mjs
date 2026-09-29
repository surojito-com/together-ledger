// Asks the one question the release gate deliberately does not: can a visitor load this?
//
// The gate proves the right bundle shipped, without touching the network, because bot
// protection correctly refuses automated traffic and a gate that needs that protection
// weakened would eventually get it turned off. This runs on a schedule instead, where being
// refused costs nothing and can be reported as itself.
//
// It separates three answers that a single red light would flatten into one:
//
//   down      nothing answered, or the site answered with a server error
//   drift     the site answered, and it is serving a revision we did not expect
//   refused   the site answered by turning us away, which tells us nothing about its health
//
// Only down and drift are worth waking someone for. Refused is recorded and passed over,
// because an alert that fires when protection is working is an alert people learn to ignore.

const defaults = { attempts: 3, delayMs: 5000 };

const DOWN = 'down';
const DRIFT = 'drift';
const REFUSED = 'refused';
const HEALTHY = 'healthy';

function parseArguments(argv) {
  const options = { ...defaults };
  const flags = ['--base-url', '--revision', '--required-text', '--attempts', '--delay-ms'];
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !flags.includes(flag)) {
      throw new Error('Usage: check-public-availability.mjs --base-url <https-url> --revision <full-sha> --required-text <text> [--attempts <count>] [--delay-ms <milliseconds>]');
    }
    if (flag === '--base-url') options.baseUrl = value;
    if (flag === '--revision') options.revision = value;
    if (flag === '--required-text') options.requiredText = value;
    if (flag === '--attempts') options.attempts = Number(value);
    if (flag === '--delay-ms') options.delayMs = Number(value);
  }
  return options;
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// 401, 403 and 429 are a working site declining to serve an automated client. A challenge page
// answers 200 with HTML where JSON was asked for, which reads the same way.
function refusal(status) {
  return [401, 403, 429].includes(status);
}

async function look({ baseUrl, revision, requiredText, fetchImpl }) {
  const origin = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  let marker;
  try {
    marker = await fetchImpl(new URL('release.json', origin), { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
  } catch (error) {
    return { state: DOWN, detail: `the marker could not be reached: ${error.message}` };
  }
  if (refusal(marker.status)) return { state: REFUSED, detail: `the marker answered HTTP ${marker.status}` };
  if (!marker.ok) return { state: DOWN, detail: `the marker answered HTTP ${marker.status}` };

  let payload;
  try {
    payload = await marker.json();
  } catch {
    // A challenge page is served where JSON was expected. The site is up and declining us.
    return { state: REFUSED, detail: 'the marker answered with something other than JSON' };
  }
  if (payload.revision !== revision) {
    return { state: DRIFT, detail: `the site is serving ${payload.revision || 'no revision'} where ${revision} was expected` };
  }

  let home;
  try {
    home = await fetchImpl(origin, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
  } catch (error) {
    return { state: DOWN, detail: `the page could not be reached: ${error.message}` };
  }
  if (refusal(home.status)) return { state: REFUSED, detail: `the page answered HTTP ${home.status}` };
  if (!home.ok) return { state: DOWN, detail: `the page answered HTTP ${home.status}` };

  const body = await home.text();
  if (!body.includes(requiredText)) {
    return { state: DRIFT, detail: 'the page is missing the control a visitor needs to begin' };
  }
  return { state: HEALTHY, detail: `serving ${revision}` };
}

export async function checkPublicAvailability(options) {
  const { attempts, delayMs } = { ...defaults, ...options };
  const fetchImpl = options.fetchImpl || fetch;
  if (!/^[0-9a-f]{40}$/i.test(options.revision || '')) throw new Error('The expected revision must be a full Git commit SHA.');

  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await look({ ...options, fetchImpl });
    // A single refusal or blip is not news. Agreement across attempts is.
    if (last.state === HEALTHY) return { ...last, attempt };
    if (attempt < attempts) await wait(delayMs);
  }
  return { ...last, attempt: attempts };
}

async function main() {
  const result = await checkPublicAvailability(parseArguments(process.argv.slice(2)));
  if (result.state === HEALTHY) {
    console.log(`✓ a visitor can load the site — ${result.detail}.`);
    return;
  }
  if (result.state === REFUSED) {
    // Not a failure. The site is up and declining an automated client, which is the protection
    // doing its job, and saying otherwise would train people to ignore this check.
    console.log(`• the site declined to answer an automated check — ${result.detail}. This says nothing about whether a person can load it.`);
    return;
  }
  const headline = result.state === DOWN ? 'A visitor cannot load the site' : 'The site is not serving what main says it should';
  console.error(`${headline}: ${result.detail}.`);
  process.exit(1);
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error(`Public availability check failed to run: ${error.message}`);
    process.exit(1);
  });
}
