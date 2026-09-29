const defaults = {
  // Three minutes. This was briefly 90 attempts, widened on the belief that the app propagated
  // slowly. It does not: Bot fight mode was refusing the checkers, and the probe reported being
  // blocked as verified:false. Waiting longer never helped, and a longer window only delays the
  // report when a release really is stuck.
  attempts: 36,
  delayMs: 5000,
  // The workflow deploys the probe immediately before asking it anything, and a freshly
  // rolled-out Worker answers 5xx while it propagates. Becoming reachable gets its own budget
  // so that waiting for the probe never spends the budget meant for the release itself.
  readinessAttempts: 24,
};

const UNAVAILABLE = 'probe-unavailable';
const UNCONFIRMED = 'release-unconfirmed';

function parseArguments(argv) {
  const options = { ...defaults };
  const flags = ['--probe-url', '--revision', '--attempts', '--delay-ms', '--readiness-attempts'];
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !flags.includes(flag)) {
      throw new Error('Usage: verify-release-probe.mjs --probe-url <https-url> --revision <full-sha> [--attempts <count>] [--delay-ms <milliseconds>] [--readiness-attempts <count>]');
    }
    if (flag === '--probe-url') options.probeUrl = value;
    if (flag === '--revision') options.revision = value;
    if (flag === '--attempts') options.attempts = Number(value);
    if (flag === '--delay-ms') options.delayMs = Number(value);
    if (flag === '--readiness-attempts') options.readinessAttempts = Number(value);
  }
  return options;
}

function requireOptions({ probeUrl, revision, attempts, delayMs, readinessAttempts }) {
  const origin = new URL(probeUrl);
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.workers.dev')) {
    throw new Error('The release probe must use its HTTPS workers.dev URL.');
  }
  if (!/^[0-9a-f]{40}$/i.test(revision || '')) throw new Error('The expected revision must be a full Git commit SHA.');
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('Attempts must be a positive integer.');
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new Error('Delay must be a non-negative integer.');
  if (!Number.isInteger(readinessAttempts) || readinessAttempts < 1) throw new Error('Readiness attempts must be a positive integer.');
  return origin;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function gateError(reason, message) {
  const error = new Error(message);
  error.reason = reason;
  return error;
}

// One request, classified into the only three things it can mean. The probe answers in JSON
// either way — 200 {verified:true} when the release is live, 503 {verified:false} when it is
// not — so an answer it did not produce is what unreachable actually looks like: a bodyless
// 5xx while the Worker rolls out, or a 404 if it is not mounted where we think it is.
async function ask(fetchImpl, probeUrl, revision) {
  let response;
  try {
    response = await fetchImpl(probeUrl, {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    return { kind: UNAVAILABLE, detail: error.message };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  // A well-formed answer is what tells us the gate ran at all.
  const answered = payload && typeof payload.verified === 'boolean';
  if (!answered) return { kind: UNAVAILABLE, detail: `HTTP ${response.status} without a probe answer` };

  const sameRevision = typeof payload.revision === 'string'
    && payload.revision.toLowerCase() === revision.toLowerCase();
  if (payload.verified === true && response.ok && sameRevision) return { kind: 'confirmed', payload };

  // The probe answered and the answer is not a confirmation of this revision — either it says
  // so outright, or it confirmed some other commit, which must never be accepted as ours.
  return {
    kind: UNCONFIRMED,
    detail: sameRevision
      ? `the probe reported verified:false (HTTP ${response.status})`
      : `the probe answered about revision ${JSON.stringify(payload.revision ?? null)}`,
  };
}

export async function verifyReleaseProbe(callerOptions) {
  // Defaults belong to the function, not only to argument parsing, so a caller that sets one
  // knob does not have to know about the others.
  const options = { ...defaults, ...callerOptions };
  const origin = requireOptions(options);
  const probeUrl = new URL(`/verify/${options.revision}`, origin);
  const fetchImpl = options.fetchImpl || fetch;

  let reachable = false;
  let readinessSpent = 0;
  let confirmSpent = 0;
  let attempt = 0;
  let lastDetail = 'no attempt was made';

  for (;;) {
    attempt += 1;
    const outcome = await ask(fetchImpl, probeUrl, options.revision);
    if (outcome.kind === 'confirmed') return { attempt, revision: outcome.payload.revision };

    lastDetail = outcome.detail;
    if (outcome.kind === UNCONFIRMED) {
      reachable = true;
      confirmSpent += 1;
    } else if (reachable) {
      // The probe answered once and has now stopped. That is still the release's budget:
      // we know the gate can run, so the outstanding question is the revision.
      confirmSpent += 1;
    } else {
      readinessSpent += 1;
    }

    if (!reachable && readinessSpent >= options.readinessAttempts) {
      throw gateError(UNAVAILABLE, `the external probe never became reachable after ${readinessSpent} attempt(s) (last: ${lastDetail}). The release was not checked, which is not the same as the release being wrong.`);
    }
    if (confirmSpent >= options.attempts) {
      throw gateError(UNCONFIRMED, `the probe answered but never confirmed revision ${options.revision} after ${confirmSpent} attempt(s) (last: ${lastDetail}).`);
    }
    await wait(options.delayMs);
  }
}

async function main() {
  const result = await verifyReleaseProbe(parseArguments(process.argv.slice(2)));
  console.log(`✓ external release probe confirms app revision ${result.revision} (attempt ${result.attempt}).`);
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    // Both outcomes fail the delivery, because a release that could not be checked is not a
    // verified release. They are named differently so the red tells you which one happened.
    const headline = error.reason === UNAVAILABLE
      ? 'Release gate could not run'
      : 'Release not confirmed';
    console.error(`${headline}: ${error.message}`);
    process.exit(error.reason === UNAVAILABLE ? 2 : 1);
  });
}
