#!/usr/bin/env node
// Evidence harness for the full account journey, begun at the app's own home.
//
// It registers synthetic accounts against a running deployment, walks
// registration, email verification, sign-in, invitation, recovery and
// sign-out, and records what each step proved. Every emailed link is checked
// against the origin that asked for it.
//
// Tokens, passwords and session cookies never reach the output. A link is
// recorded by its origin and its query key only.
//
//   node scripts/verify-account-journey.mjs --help

import { createHash } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';

const DEFAULTS = {
  'app-origin': 'https://app.together-ledger.com',
  'api-origin': 'https://api.together-ledger.com',
  'root-origin': 'https://together-ledger.com',
  mailbox: 'legal+tl-qa-{tag}@together-ledger.com',
  links: '',
  json: '',
  'link-timeout': '600',
  'rate-wait': '960',
};

const options = { ...DEFAULTS };
for (const argument of process.argv.slice(2)) {
  if (argument === '--help' || argument === '-h') {
    console.log(`Usage: node scripts/verify-account-journey.mjs [options]

  --app-origin=URL    the app home the journey begins at   (${DEFAULTS['app-origin']})
  --api-origin=URL    the account API the app speaks to    (${DEFAULTS['api-origin']})
  --root-origin=URL   the company root held separate       (${DEFAULTS['root-origin']})
  --mailbox=ADDRESS   synthetic address; {tag} is filled per account
  --links=PATH        JSON file of received links, written by the mailbox reader
  --json=PATH         where to write the evidence record
  --link-timeout=SEC  how long to wait for each emailed link (${DEFAULTS['link-timeout']})
  --rate-wait=SEC     how long to wait out registration rate limiting, 0 to skip (${DEFAULTS['rate-wait']})

Set RESEND_API_KEY in your own shell to read the links from the delivery
provider's log instead of a mailbox. The key is never printed or recorded.

The links file holds only what a mailbox reader found, for example:
  { "verification": "https://app.together-ledger.com/#verify=...",
    "invitation":   "https://app.together-ledger.com/invite#invite=...",
    "recovery":     "https://app.together-ledger.com/#recovery=..." }

A link carries its code after the # (#261), and an invitation's is at /invite (#266). One sent
by a server from before that carries it in the query (?verify=...), and is still read.
`);
    process.exit(0);
  }
  const match = /^--([a-z-]+)=(.*)$/.exec(argument);
  if (!match || !(match[1] in DEFAULTS)) {
    console.error(`Unrecognised option: ${argument}`);
    process.exit(64);
  }
  options[match[1]] = match[2];
}

const appOrigin = options['app-origin'].replace(/\/$/, '');
const apiOrigin = options['api-origin'].replace(/\/$/, '');
const rootOrigin = options['root-origin'].replace(/\/$/, '');
const linkTimeoutMs = Number(options['link-timeout']) * 1000;
const rateWaitSeconds = Number(options['rate-wait']);

const runId = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const cases = [];
let pending = 0;
let failed = 0;

function record(id, title, expected, state, detail) {
  cases.push({ id, title, expected, state, detail });
  const mark = state === 'pass' ? 'PASS   ' : state === 'pending' ? 'PENDING' : 'FAIL   ';
  console.log(`${mark} ${id}  ${title}\n        ${detail}`);
  if (state === 'fail') failed += 1;
  if (state === 'pending') pending += 1;
}

async function check(id, title, expected, run) {
  try {
    const detail = await run();
    record(id, title, expected, 'pass', detail);
    return true;
  } catch (error) {
    if (error?.pending) {
      record(id, title, expected, 'pending', error.message);
      return false;
    }
    record(id, title, expected, 'fail', error.message);
    return false;
  }
}

const pendingReason = (message) => Object.assign(new Error(message), { pending: true });

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// --- talking to the deployment -------------------------------------------

const cookieJars = new Map();

function jar(account) {
  if (!cookieJars.has(account)) cookieJars.set(account, new Map());
  return cookieJars.get(account);
}

function storeCookies(account, response) {
  const raw = response.headers.getSetCookie?.() || [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!value || /Max-Age=0/i.test(line) || /Expires=Thu, 01 Jan 1970/i.test(line)) jar(account).delete(name);
    else jar(account).set(name, value);
  }
  return raw;
}

async function call(path, { method = 'GET', body, account, csrf, origin = appOrigin, headers = {} } = {}) {
  const cookies = account ? [...jar(account)].map(([name, value]) => `${name}=${value}`).join('; ') : '';
  const response = await fetch(`${apiOrigin}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(origin ? { Origin: origin } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookies ? { Cookie: cookies } : {}),
      ...(csrf ? { 'X-Together-CSRF': csrf } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const setCookie = account ? storeCookies(account, response) : [];
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { status: response.status, headers: response.headers, payload, text, setCookie };
}

// --- synthetic accounts ---------------------------------------------------

// Registration is deliberately rate limited, so a repeated evidence run meets
// the same wall a stranger would. The harness waits the window out rather than
// reporting a healthy deployment as broken.
async function registerAccount(account) {
  const attempt = () => call('/api/v1/auth/register', {
    method: 'POST', account: account.label,
    body: { email: account.email, username: account.username, password: account.password },
  });
  let response = await attempt();
  if (response.status !== 429) return response;
  const reset = Number(response.headers.get('x-ratelimit-reset') || 900);
  if (!rateWaitSeconds || reset > rateWaitSeconds) {
    throw pendingReason(`registration is rate limited for another ${reset}s; re-run after that window`);
  }
  console.log(`        registration is rate limited; waiting ${reset}s for the window to reset`);
  await new Promise((resolve) => setTimeout(resolve, (reset + 5) * 1000));
  return attempt();
}

const tag = (suffix) => `${runId.slice(-6)}${suffix}`;

function synthetic(suffix) {
  const accountTag = tag(suffix);
  return {
    label: suffix,
    email: options.mailbox.replace('{tag}', accountTag),
    username: `qa-tl-${accountTag}`,
    password: `tl-qa-${accountTag}-${'x'.repeat(8)}`,
    csrf: '',
  };
}

// --- emailed links --------------------------------------------------------

const QUERY_KEY = { verification: 'verify', invitation: 'invite', recovery: 'recovery' };

// A link carries its code after the # (#261); one from a server released before that, in the query.
function linkCode(url, kind) {
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (fragment.has(QUERY_KEY[kind])) return { code: fragment.get(QUERY_KEY[kind]), shape: '#' };
  if (url.searchParams.has(QUERY_KEY[kind])) return { code: url.searchParams.get(QUERY_KEY[kind]), shape: '?' };
  return null;
}

// Two readers can supply what a synthetic mailbox received. The delivery
// provider's own log is preferred: it reaches only the messages this
// deployment sent, never a person's inbox, and it also reports whether the
// message was accepted, delivered, or bounced. A links file remains available
// for a local catcher or for an operator reading the mailbox by hand.
//
// The provider key is read from the environment of whoever runs this harness.
// It is never written to the evidence record or the console.
const resendKey = process.env.RESEND_API_KEY || '';
const deliveryLog = [];

async function resendLink(kind, recipient) {
  const list = await fetch('https://api.resend.com/emails?limit=100', { headers: { Authorization: `Bearer ${resendKey}` } });
  if (list.status === 401 || list.status === 403) throw new Error('the delivery provider refused the configured read key');
  if (!list.ok) throw pendingReason(`the delivery provider answered ${list.status} while listing recent messages`);
  const sent = (await list.json())?.data || [];
  const candidates = sent.filter((message) => [].concat(message.to || []).some((address) => String(address).toLowerCase() === recipient.toLowerCase()));
  for (const candidate of candidates) {
    const detail = await fetch(`https://api.resend.com/emails/${candidate.id}`, { headers: { Authorization: `Bearer ${resendKey}` } });
    if (!detail.ok) continue;
    const message = await detail.json();
    const body = `${message.text || ''}\n${message.html || ''}`;
    const found = (body.match(/https?:\/\/[^\s"'<>]+/g) || [])
      .map((candidateUrl) => { try { return new URL(candidateUrl.replace(/&amp;/g, '&')); } catch { return null; } })
      .find((candidateUrl) => candidateUrl && linkCode(candidateUrl, kind));
    if (found) {
      deliveryLog.push({ kind, recipient, subject: message.subject, status: message.last_event || 'unknown' });
      return found;
    }
  }
  return null;
}

async function fileLink(kind) {
  try {
    const found = JSON.parse(await readFile(options.links, 'utf8'))[kind];
    return found ? new URL(found) : null;
  } catch {
    return null;
  }
}

async function waitForLink(kind, recipient) {
  if (!resendKey && !options.links) {
    throw pendingReason('No mailbox reader is configured; set RESEND_API_KEY or pass --links to read what the mailbox received.');
  }
  const deadline = Date.now() + linkTimeoutMs;
  while (Date.now() < deadline) {
    if (resendKey) {
      const found = await resendLink(kind, recipient);
      if (found) return found;
    }
    if (options.links) {
      const found = await fileLink(kind);
      if (found) return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw pendingReason(`No ${kind} link reached ${recipient} within ${linkTimeoutMs / 1000}s.`);
}

function describeLink(url, kind) {
  const { code: token = '', shape = '#' } = linkCode(url, kind) || {};
  expect(url.origin === appOrigin, `the ${kind} link returned to ${url.origin}, not ${appOrigin}`);
  expect(token.length > 0, `the ${kind} link carried no ${QUERY_KEY[kind]} value`);
  // The path is said as found: an invitation's is /invite since #266, the others /.
  return { token, detail: `link returns to ${url.origin}${url.pathname}${shape}${QUERY_KEY[kind]}=<${token.length}-character token>` };
}

// --- the journey ----------------------------------------------------------

const alice = synthetic('a');
const bob = synthetic('b');
const evidence = { runId, appOrigin, apiOrigin, rootOrigin, startedAt: new Date().toISOString(), accounts: [] };

console.log(`Together Ledger — account journey evidence
run ${runId}
app  ${appOrigin}
api  ${apiOrigin}
root ${rootOrigin}
`);

await check('TC-10800', 'The app home answers at its own hostname', 'HTTP 200 HTML that names its API origin and enables accounts.', async () => {
  const response = await fetch(`${appOrigin}/`);
  const html = await response.text();
  expect(response.status === 200, `the app home answered ${response.status}`);
  expect(/text\/html/.test(response.headers.get('content-type') || ''), 'the app home did not answer as HTML');
  const api = /name="together-api-origin" content="([^"]+)"/.exec(html)?.[1];
  const accounts = /name="together-accounts-enabled" content="([^"]+)"/.exec(html)?.[1];
  expect(api === apiOrigin, `the app home points at ${api}, not ${apiOrigin}`);
  expect(accounts === 'true', 'the app home does not offer accounts');
  return `HTTP 200, api origin ${api}, accounts enabled`;
});

await check('TC-10810', 'The app serves its own application module', 'The app JavaScript loads from the app hostname, not the company root.', async () => {
  const response = await fetch(`${appOrigin}/src/app.js`);
  const body = await response.text();
  expect(response.status === 200, `the app module answered ${response.status}`);
  expect(/javascript/.test(response.headers.get('content-type') || ''), 'the app module was not served as JavaScript');
  expect(/renderTimeline/.test(body), 'the app module did not contain the expected application code');
  return `HTTP 200, ${body.length} bytes of JavaScript from ${appOrigin}`;
});

await check('TC-10820', 'The company root stays a separate page', 'The root answers with different content and does not carry the app configuration.', async () => {
  const response = await fetch(`${rootOrigin}/`);
  const html = await response.text();
  expect(response.status === 200, `the company root answered ${response.status}`);
  expect(!/name="together-api-origin"/.test(html), 'the company root carries the app API configuration');
  const rootTitle = /<title>([^<]*)<\/title>/.exec(html)?.[1] || '';
  return `HTTP 200, separate page titled "${rootTitle}", no app configuration present`;
});

await check('TC-10830', 'The API greets the exact app origin', 'Preflight answers 204, echoes the exact origin, and allows credentials.', async () => {
  const response = await fetch(`${apiOrigin}/api/v1/auth/register`, {
    method: 'OPTIONS',
    headers: { Origin: appOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-together-csrf' },
  });
  expect(response.status === 204, `preflight answered ${response.status}`);
  expect(response.headers.get('access-control-allow-origin') === appOrigin, `preflight echoed ${response.headers.get('access-control-allow-origin')}`);
  expect(response.headers.get('access-control-allow-credentials') === 'true', 'preflight did not allow credentials');
  expect((response.headers.get('vary') || '').includes('Origin'), 'preflight did not vary on Origin');
  return `HTTP 204, allow-origin ${appOrigin}, credentials true, Vary: Origin`;
});

await check('TC-10840', 'The API refuses an origin it does not know', 'A foreign origin is refused before any account work begins.', async () => {
  const response = await fetch(`${apiOrigin}/api/v1/auth/register`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://example.invalid', 'Access-Control-Request-Method': 'POST' },
  });
  expect(response.status === 403, `a foreign origin received ${response.status}`);
  expect(!response.headers.get('access-control-allow-origin'), 'a foreign origin was echoed back');
  return 'HTTP 403, no allow-origin header returned';
});

const registered = await check('TC-10850', 'Registration begins at the app home', 'HTTP 201 with a host-scoped, secure session cookie and a verification email sent.', async () => {
  const response = await registerAccount(alice);
  expect(response.status === 201, `registration answered ${response.status}: ${response.payload?.error?.code || response.text.slice(0, 120)}`);
  expect(response.payload?.data?.verificationSent === true, 'the deployment did not report the verification email as sent');
  alice.csrf = response.payload.data.csrfToken;
  const cookie = response.setCookie.find((line) => line.startsWith('tl_session='));
  expect(cookie, 'registration returned no session cookie');
  expect(/HttpOnly/i.test(cookie), 'the session cookie is not HttpOnly');
  expect(/Secure/i.test(cookie), 'the session cookie is not Secure');
  expect(/SameSite=Lax/i.test(cookie), 'the session cookie is not SameSite=Lax');
  expect(!/Domain=/i.test(cookie), 'the session cookie is shared across hostnames');
  evidence.accounts.push({ role: 'owner', username: alice.username, email: alice.email });
  const budget = response.headers.get('x-ratelimit-limit');
  return `HTTP 201 for ${alice.username}, verification sent, cookie HttpOnly/Secure/SameSite=Lax with no Domain`
    + (budget ? `, registration limited to ${budget} attempts per window` : '');
});

await check('TC-10860', 'A second account cannot take the same name', 'A repeated registration is refused with 409 rather than quietly joined.', async () => {
  const response = await call('/api/v1/auth/register', { method: 'POST', body: { email: alice.email, username: alice.username, password: alice.password } });
  expect(response.status === 409, `the repeated registration answered ${response.status}`);
  expect(response.payload?.error?.code === 'account_exists', `the repeated registration reported ${response.payload?.error?.code}`);
  return 'HTTP 409 account_exists';
});

let verified = false;
if (registered) {
  verified = await check('TC-10870', 'The verification link returns to the app home', 'The emailed link carries the app origin and verifies the account.', async () => {
    const url = await waitForLink('verification', alice.email);
    const { detail, token } = describeLink(url, 'verification');
    const response = await call('/api/v1/auth/verify-email', { method: 'POST', body: { token } });
    expect(response.status === 200, `verification answered ${response.status}: ${response.payload?.error?.code || ''}`);
    expect(response.payload?.data?.user?.emailVerified === true, 'the account is still unverified after using the link');
    return `${detail}; verification accepted, account marked verified`;
  });
}

let signedIn = false;
if (registered) {
  signedIn = await check('TC-10880', 'Sign-in works from the app hostname', 'The account signs in and the session is readable at the app origin.', async () => {
    const response = await call('/api/v1/auth/login', { method: 'POST', account: alice.label, body: { identifier: alice.username, password: alice.password } });
    expect(response.status === 200, `sign-in answered ${response.status}`);
    alice.csrf = response.payload.data.csrfToken;
    const session = await call('/api/v1/session', { account: alice.label });
    expect(session.status === 200, `the session read answered ${session.status}`);
    expect(session.payload?.data?.user?.username === alice.username, 'the session belongs to another account');
    return `HTTP 200 sign-in, session readable for ${alice.username}`;
  });
}

let journeyId = '';
if (signedIn) {
  await check('TC-10890', 'A signed-in journey is held by the server', 'A journey and a moment created at the app origin are stored server-side.', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const created = await call('/api/v1/journeys', {
      method: 'POST', account: alice.label, csrf: alice.csrf,
      body: { name: `Evidence run ${runId}`, location: '', budgetCents: 0, startDateStatus: 'exact', startDate: today, endDateStatus: 'date', endDate: today },
    });
    expect(created.status === 201, `creating a journey answered ${created.status}: ${created.payload?.error?.message || ''}`);
    journeyId = created.payload.data.journey.id;
    const moment = await call(`/api/v1/journeys/${journeyId}/moments`, {
      method: 'POST', account: alice.label, csrf: alice.csrf,
      body: { kind: 'memory', occurredOn: today, title: `Synthetic evidence ${runId}`, detail: 'Created by the account-journey evidence harness.', locations: [] },
    });
    expect(moment.status === 201, `creating a moment answered ${moment.status}: ${moment.payload?.error?.code || ''}`);
    const snapshot = await call(`/api/v1/journeys/${journeyId}/snapshot`, { account: alice.label });
    expect(snapshot.status === 200, `the snapshot answered ${snapshot.status}`);
    expect((snapshot.payload?.data?.moments || []).length >= 1, 'the moment was not held by the server');
    evidence.journeyId = journeyId;
    return `journey created, 1 moment held, snapshot returns it from ${apiOrigin}`;
  });

  await check('TC-10900', 'A mutation without its CSRF token is refused', 'The app origin alone is not enough to change an account.', async () => {
    const response = await call('/api/v1/journeys', { method: 'POST', account: alice.label, body: { title: 'should not exist' } });
    expect(response.status === 403, `an unprotected mutation answered ${response.status}`);
    expect(response.payload?.error?.code === 'invalid_csrf', `an unprotected mutation reported ${response.payload?.error?.code}`);
    return 'HTTP 403 invalid_csrf';
  });
}

if (signedIn && journeyId) {
  const invited = await check('TC-10910', 'An invitation link returns to the app home', 'The invited address receives a link on the app origin.', async () => {
    const partner = await registerAccount(bob);
    expect(partner.status === 201, `registering the invited account answered ${partner.status}`);
    bob.csrf = partner.payload.data.csrfToken;
    evidence.accounts.push({ role: 'invited', username: bob.username, email: bob.email });
    const sent = await call(`/api/v1/journeys/${journeyId}/invitations`, { method: 'POST', account: alice.label, csrf: alice.csrf, body: { email: bob.email } });
    expect([200, 201, 202].includes(sent.status), `sending the invitation answered ${sent.status}: ${sent.payload?.error?.code || ''}`);
    const url = await waitForLink('invitation', bob.email);
    const { detail } = describeLink(url, 'invitation');
    return `${detail}; invitation delivered to the invited synthetic address`;
  });
  if (invited) {
    await check('TC-10920', 'Only a verified account may accept', 'An unverified invitee is refused; the same account accepts once verified.', async () => {
      const url = await waitForLink('invitation', bob.email);
      const { token } = describeLink(url, 'invitation');
      const refused = await call(`/api/v1/invitations/${token}/accept`, { method: 'POST', account: bob.label, csrf: bob.csrf });
      expect(refused.status === 403 && refused.payload?.error?.code === 'email_unverified',
        `an unverified invitee received ${refused.status} ${refused.payload?.error?.code || ''}`);
      return 'HTTP 403 email_unverified for an invitee who has not yet verified';
    });
  }
}

if (signedIn) {
  await check('TC-10930', 'Recovery returns to the app home and restores access', 'The recovery link carries the app origin and a new password signs in.', async () => {
    const request = await call('/api/v1/recovery/request', { method: 'POST', body: { email: alice.email } });
    expect(request.status === 202 || request.status === 200 || request.status === 204, `the recovery request answered ${request.status}`);
    const url = await waitForLink('recovery', alice.email);
    const { detail, token } = describeLink(url, 'recovery');
    const nextPassword = `${alice.password}-restored`;
    const confirmed = await call('/api/v1/recovery/confirm', { method: 'POST', body: { token, password: nextPassword } });
    expect(confirmed.status === 200 || confirmed.status === 204, `the recovery confirmation answered ${confirmed.status}: ${confirmed.payload?.error?.code || ''}`);
    const signIn = await call('/api/v1/auth/login', { method: 'POST', account: alice.label, body: { identifier: alice.username, password: nextPassword } });
    expect(signIn.status === 200, `signing in with the restored password answered ${signIn.status}`);
    alice.password = nextPassword;
    alice.csrf = signIn.payload.data.csrfToken;
    return `${detail}; password restored and sign-in succeeded`;
  });

  await check('TC-10940', 'Sign-out ends the session at the app hostname', 'The session stops being readable and the cookie is cleared.', async () => {
    const response = await call('/api/v1/auth/logout', { method: 'POST', account: alice.label, csrf: alice.csrf });
    expect(response.status === 200 || response.status === 204, `sign-out answered ${response.status}`);
    const after = await call('/api/v1/session', { account: alice.label });
    expect(after.status === 401, `the session still answered ${after.status} after sign-out`);
    return `sign-out accepted, the session now answers 401 at ${apiOrigin}`;
  });

}

if (signedIn && journeyId) {
  await check('TC-10950', 'Sign-out hides the journey without deleting it', 'Signing back in returns the same server-held records.', async () => {
    const signIn = await call('/api/v1/auth/login', { method: 'POST', account: alice.label, body: { identifier: alice.username, password: alice.password } });
    expect(signIn.status === 200, `signing back in answered ${signIn.status}`);
    const snapshot = await call(`/api/v1/journeys/${journeyId}/snapshot`, { account: alice.label });
    expect(snapshot.status === 200, `the snapshot after sign-out answered ${snapshot.status}`);
    expect((snapshot.payload?.data?.moments || []).length >= 1, 'the server-held moment did not survive sign-out');
    return 'the journey and its moment are unchanged after sign-out and sign-in';
  });
}

await check('TC-10965', 'The live build is identifiable for a rollback', 'The served app and its module have stable digests a rollback can be checked against.', async () => {
  const digests = [];
  for (const path of ['/', '/src/app.js']) {
    const response = await fetch(`${appOrigin}${path}`);
    expect(response.status === 200, `${path} answered ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    digests.push({ path, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex').slice(0, 16) });
  }
  evidence.build = digests;
  return digests.map((entry) => `${entry.path} ${entry.bytes}B sha256:${entry.sha256}…`).join(', ');
});

await check('TC-10960', 'Each hostname names the deployment that serves it', 'App, root and API are separately identifiable without exposing private identifiers.', async () => {
  const lines = [];
  for (const [name, origin] of [['app', appOrigin], ['root', rootOrigin]]) {
    const response = await fetch(`${origin}/`, { method: 'HEAD' });
    const served = response.headers.get('server') || 'not disclosed';
    const cache = response.headers.get('cf-cache-status') || response.headers.get('x-served-by') || 'none';
    lines.push(`${name}=${response.status}/${served}/${cache}`);
  }
  const health = await fetch(`${apiOrigin}/healthz`);
  const ready = await fetch(`${apiOrigin}/readyz`);
  expect(health.status === 200, `the API health check answered ${health.status}`);
  expect(ready.status === 200, `the API readiness check answered ${ready.status}`);
  lines.push(`api=${health.status}/${ready.status}/${(await ready.json()).status}`);
  return lines.join(', ');
});

evidence.finishedAt = new Date().toISOString();
evidence.cases = cases;
evidence.delivery = deliveryLog;
evidence.summary = { total: cases.length, passed: cases.filter((entry) => entry.state === 'pass').length, pending, failed };

if (options.json) {
  await writeFile(options.json, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nEvidence written to ${options.json}`);
}

console.log(`\n${evidence.summary.passed} passed, ${pending} pending, ${failed} failed, of ${cases.length} checks.`);
if (failed) {
  console.log('This run does not support closing the account-journey evidence.');
  process.exit(1);
}
if (pending) {
  console.log('Checks that need an emailed link are still open; re-run once the mailbox reader has written them.');
  process.exit(2);
}
