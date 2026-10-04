import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAppReleaseProbe } from '../probes/app-release-probe/app-release-probe.mjs';
import { findWorkersDevUrl } from '../scripts/deploy-release-probe.mjs';
import { verifyReleaseProbe } from '../scripts/verify-release-probe.mjs';
import { verifyReleaseBundle } from '../scripts/verify-release-bundle.mjs';
import { checkPublicAvailability } from '../scripts/check-public-availability.mjs';
import { verifyWorkerRelease } from '../scripts/verify-worker-release.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const revision = 'a'.repeat(40);

test('Worker release verifier proves both revision parity and a visible control', async () => {
  const fetchImpl = async (url) => {
    if (new URL(url).pathname === '/release.json') {
      return new Response(JSON.stringify({ revision }), { status: 200 });
    }
    return new Response('<button>Keep what matters, together.</button>', { status: 200 });
  };
  const result = await verifyWorkerRelease({
    baseUrl: 'https://app.example.test',
    revision,
    requiredText: 'Keep what matters,',
    attempts: 1,
    delayMs: 0,
    fetchImpl,
  });
  assert.equal(result.revision, revision);
});

test('Worker release verifier fails closed when the marker is stale', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ revision: 'b'.repeat(40) }), { status: 200 });
  await assert.rejects(
    verifyWorkerRelease({
      baseUrl: 'https://app.example.test',
      revision,
      requiredText: 'Keep what matters,',
      attempts: 1,
      delayMs: 0,
      fetchImpl,
    }),
    /instead of the expected revision/,
  );
});

test('Worker release verifier allows a transient public marker denial to settle', async () => {
  let markerRequests = 0;
  const fetchImpl = async (url) => {
    if (new URL(url).pathname === '/release.json') {
      markerRequests += 1;
      if (markerRequests === 1) return new Response('Still propagating', { status: 403 });
      return new Response(JSON.stringify({ revision }), { status: 200 });
    }
    return new Response('<button>Keep what matters, together.</button>', { status: 200 });
  };
  const result = await verifyWorkerRelease({
    baseUrl: 'https://app.example.test',
    revision,
    requiredText: 'Keep what matters,',
    attempts: 2,
    delayMs: 0,
    fetchImpl,
  });
  assert.equal(result.attempt, 2);
});

test('external release probe permits only a matching public revision', async () => {
  const probe = createAppReleaseProbe(async (url) => {
    if (new URL(url).pathname === '/release.json') {
      return new Response(JSON.stringify({ revision }), { status: 200 });
    }
    return new Response('<button>Keep what matters, together.</button>', { status: 200 });
  });
  const response = await probe.fetch(new Request(`https://probe.example.test/verify/${revision}`));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { verified: true, revision });
});

test('external release probe fails closed for stale or non-probe requests', async () => {
  const probe = createAppReleaseProbe(async () => new Response(JSON.stringify({ revision: 'b'.repeat(40) }), { status: 200 }));
  const stale = await probe.fetch(new Request(`https://probe.example.test/verify/${revision}`));
  assert.equal(stale.status, 503);
  assert.deepEqual(await stale.json(), { verified: false, revision });
  assert.equal((await probe.fetch(new Request('https://probe.example.test/anything'))).status, 404);
  assert.equal((await probe.fetch(new Request(`https://probe.example.test/verify/${revision}`, { method: 'POST' }))).status, 405);
});

test('release probe verifier retries its public workers.dev endpoint and requires parity', async () => {
  let attempts = 0;
  const result = await verifyReleaseProbe({
    probeUrl: 'https://together-ledger-app-public-release-probe.example.workers.dev',
    revision,
    attempts: 2,
    delayMs: 0,
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('Waiting', { status: 503 })
        : Response.json({ verified: true, revision });
    },
  });
  assert.equal(result.attempt, 2);
  await assert.rejects(
    verifyReleaseProbe({
      probeUrl: 'https://together-ledger-app-public-release-probe.example.workers.dev',
      revision,
      attempts: 1,
      delayMs: 0,
      fetchImpl: async () => Response.json({ verified: true, revision: 'b'.repeat(40) }),
    }),
    /never confirmed revision/,
  );
});

test('the release gate says which question it could not answer', async () => {
  const probeUrl = 'https://together-ledger-app-public-release-probe.example.workers.dev';

  // A probe that never comes up means the release was not checked. That is a different fact
  // from the release being wrong, and every delivery on 18 September reported it as the same.
  await assert.rejects(
    verifyReleaseProbe({
      probeUrl,
      revision,
      attempts: 4,
      readinessAttempts: 2,
      delayMs: 0,
      fetchImpl: async () => new Response('Waiting', { status: 503 }),
    }),
    (error) => {
      assert.equal(error.reason, 'probe-unavailable');
      assert.match(error.message, /never became reachable/);
      assert.match(error.message, /not the same as the release being wrong/);
      return true;
    },
  );

  await assert.rejects(
    verifyReleaseProbe({
      probeUrl,
      revision,
      attempts: 1,
      readinessAttempts: 4,
      delayMs: 0,
      fetchImpl: async () => Response.json({ verified: true, revision: 'b'.repeat(40) }),
    }),
    (error) => {
      assert.equal(error.reason, 'release-unconfirmed');
      return true;
    },
  );
});

test('waiting for the probe does not spend the budget meant for the release', async () => {
  // The workflow deploys the probe and immediately asks it, so the first answers are 5xx from
  // a Worker still rolling out. Those attempts belong to readiness; previously they consumed
  // the revision budget, which is how a healthy release failed its own gate.
  let calls = 0;
  const result = await verifyReleaseProbe({
    probeUrl: 'https://together-ledger-app-public-release-probe.example.workers.dev',
    revision,
    attempts: 1,
    readinessAttempts: 5,
    delayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return calls <= 3 ? new Response('Waiting', { status: 503 }) : Response.json({ verified: true, revision });
    },
  });
  assert.equal(result.attempt, 4);
});

test('release-probe deployer finds only the fixed public probe URL', () => {
  const output = 'Published together-ledger-app-public-release-probe\nhttps://together-ledger-app-public-release-probe.example.workers.dev\n';
  assert.equal(findWorkersDevUrl(output), 'https://together-ledger-app-public-release-probe.example.workers.dev');
  assert.equal(findWorkersDevUrl('Published without an endpoint'), undefined);
});

test('release delivery workflows keep their explicit protected-main boundaries', () => {
  const worker = readFileSync(join(root, '.github/workflows/app-worker.yml'), 'utf8');
  assert.match(worker, /workflow_run:/);
  assert.match(worker, /npm run build:public/);
  assert.match(worker, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(worker, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(worker, /name: app/);
  assert.match(worker, /CLOUDFLARE_API_TOKEN/);
  assert.match(worker, /probes\/app-release-probe\/wrangler\.jsonc/);
  // The gate is the runner's own view of the public app, because it is outside Cloudflare and
  // is the closest thing here to what a visitor's browser does. The probe observes alongside
  // it: on 26cf2d1 the runner saw the revision in 52 seconds while the probe said otherwise
  // for 450, so a probe that cannot see the app must not be able to stop a release.
  // The gate proves the bundle before it ships and asks nothing of the network. Bot fight mode
  // refuses automated traffic — correctly — so every check that visits the site can only
  // observe. A release gate that needs that protection weakened would not survive contact with
  // the first person who turns the protection back on.
  assert.match(worker, /scripts\/verify-release-bundle\.mjs/);
  const bundleGate = worker.slice(worker.indexOf('Verify the assembled bundle is the reviewed revision'), worker.indexOf('Validate Worker packaging'));
  assert.doesNotMatch(bundleGate, /continue-on-error/);
  // And it must run before the upload, so a wrong bundle is never published.
  assert.ok(worker.indexOf('scripts/verify-release-bundle.mjs') < worker.indexOf('Publish the reviewed public bundle'));

  for (const observer of ['Observe the public app from the runner', 'Observe the external release probe']) {
    const step = worker.slice(worker.indexOf(observer));
    assert.match(step.slice(0, 400), /continue-on-error: true/, `${observer} must not be able to fail a release`);
  }
  assert.match(worker, /deploy-release-probe\.mjs/);
  assert.match(worker, /verify-release-probe\.mjs/);
});

test('no workflow deploys to GitHub Pages, which serves no Together Ledger address', () => {
  const workflows = readdirSync(join(root, '.github/workflows'));
  assert.ok(!workflows.includes('pages.yml'));
  for (const workflowName of workflows) {
    const workflow = readFileSync(join(root, '.github/workflows', workflowName), 'utf8');
    assert.doesNotMatch(workflow, /actions\/configure-pages@/);
    assert.doesNotMatch(workflow, /actions\/deploy-pages@/);
    assert.doesNotMatch(workflow, /actions\/upload-pages-artifact@/);
  }
});

test('the release marker is declared uncacheable at the edge', () => {
  // The edge ignores query strings on this zone, so the probe's ?revision= cache-buster is
  // inert. Without this header the probe reads a stale marker and reports a healthy release
  // as unconfirmed, which is what every delivery on 18 September did.
  const headers = readFileSync(join(root, 'public', '_headers'), 'utf8');
  const marker = headers.slice(headers.indexOf('/release.json'));
  assert.match(marker, /^\/release\.json\s*\n\s+Cache-Control:\s*no-store/m);
});

test('the release bundle verifier proves the revision and the visible control before shipping', async () => {
  const bundle = {
    '_site/release.json': JSON.stringify({ revision }),
    '_site/index.html': '<h1>Keep what matters, together.</h1>',
  };
  const readFileImpl = async (path) => {
    const key = String(path).replaceAll('\\', '/');
    if (!(key in bundle)) throw new Error('missing');
    return bundle[key];
  };

  const result = await verifyReleaseBundle({ directory: '_site', revision, requiredText: 'Keep what matters,', readFileImpl });
  assert.equal(result.revision, revision);

  // A bundle built from the wrong commit must never be uploaded.
  await assert.rejects(
    verifyReleaseBundle({ directory: '_site', revision: 'b'.repeat(40), requiredText: 'Keep what matters,', readFileImpl }),
    /carries revision .* instead of the reviewed/,
  );

  // A marker alone proves a build ran, not that the page is the product.
  await assert.rejects(
    verifyReleaseBundle({ directory: '_site', revision, requiredText: 'A control that is not there', readFileImpl }),
    /does not contain the required user-visible control/,
  );

  // A missing bundle is a failure, never a pass by absence.
  await assert.rejects(
    verifyReleaseBundle({ directory: '_site', revision, requiredText: 'Keep what matters,', readFileImpl: async () => { throw new Error('missing'); } }),
    /has no release marker/,
  );
});

test('the availability check separates refused from down from drift', async () => {
  const base = { baseUrl: 'https://app.example.test', revision, requiredText: 'Keep what matters,', attempts: 1, delayMs: 0 };
  const page = (body = '<h1>Keep what matters, together.</h1>', status = 200) => new Response(body, { status });

  const healthy = await checkPublicAvailability({
    ...base,
    fetchImpl: async (url) => (String(url).endsWith('release.json') ? Response.json({ revision }) : page()),
  });
  assert.equal(healthy.state, 'healthy');

  // Being turned away is the protection working. It must never read as the site being broken,
  // or the check becomes another red light people learn to skip.
  for (const status of [401, 403, 429]) {
    const refused = await checkPublicAvailability({ ...base, fetchImpl: async () => new Response('no', { status }) });
    assert.equal(refused.state, 'refused', `HTTP ${status} is a refusal, not an outage`);
  }

  // A challenge page answers 200 with HTML where JSON was asked for. Same meaning.
  const challenged = await checkPublicAvailability({ ...base, fetchImpl: async () => page('<html>checking your browser</html>') });
  assert.equal(challenged.state, 'refused');

  const down = await checkPublicAvailability({ ...base, fetchImpl: async () => new Response('boom', { status: 503 }) });
  assert.equal(down.state, 'down');

  const unreachable = await checkPublicAvailability({ ...base, fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  assert.equal(unreachable.state, 'down');

  // Production serving something other than main is worth knowing even while it is healthy.
  const drifted = await checkPublicAvailability({
    ...base,
    fetchImpl: async (url) => (String(url).endsWith('release.json') ? Response.json({ revision: 'b'.repeat(40) }) : page()),
  });
  assert.equal(drifted.state, 'drift');

  // A marker alone is not a working page.
  const hollow = await checkPublicAvailability({
    ...base,
    fetchImpl: async (url) => (String(url).endsWith('release.json') ? Response.json({ revision }) : page('<html>an error page</html>')),
  });
  assert.equal(hollow.state, 'drift');
});

test('the availability schedule cannot block a release', () => {
  const availability = readFileSync(join(root, '.github/workflows/public-availability.yml'), 'utf8');
  assert.match(availability, /schedule:/);
  assert.match(availability, /scripts\/check-public-availability\.mjs/);
  // It runs on its own timer, never on a push or a deployment, so it can never gate one.
  assert.doesNotMatch(availability, /workflow_run:/);
  assert.doesNotMatch(availability, /on:\s*\n\s*push:/);
  const worker = readFileSync(join(root, '.github/workflows/app-worker.yml'), 'utf8');
  assert.doesNotMatch(worker, /check-public-availability/);
});
