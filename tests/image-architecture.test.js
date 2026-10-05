import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/verify-image-architecture.sh', import.meta.url));

// Stand-ins for `uname` and `docker`, so the check runs for real against a controlled machine
// and a controlled image without needing either.
function run({ machine = 'x86_64', platform = 'linux/amd64', present = true, expected } = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'image-arch-'));
  try {
    writeFileSync(join(bin, 'uname'), `#!/bin/sh\necho ${machine}\n`);
    writeFileSync(join(bin, 'docker'), present ? `#!/bin/sh\necho ${platform}\n` : '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'uname'), 0o755);
    chmodSync(join(bin, 'docker'), 0o755);
    const env = { PATH: `${bin}:/usr/bin:/bin` };
    if (expected) env.EXPECTED_ARCH = expected;
    return spawnSync('sh', [script, 'registry.example/app@sha256:abc'], { env, encoding: 'utf8' });
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

test('an image built for the host architecture passes', () => {
  const result = run({ machine: 'x86_64', platform: 'linux/amd64' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS {2}image is linux\/amd64/);
});

test('an image built on an arm64 workstation is refused on an amd64 host', () => {
  const result = run({ machine: 'x86_64', platform: 'linux/arm64' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /image is linux\/arm64 but this release needs linux\/amd64/);
});

test('an arm64 host names its architecture the way Docker does', () => {
  assert.equal(run({ machine: 'aarch64', platform: 'linux/arm64' }).status, 0);
});

test('an image that was never pulled is refused rather than assumed', () => {
  const result = run({ present: false });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not present locally; pull it first/);
});

test('an unknown machine architecture fails closed', () => {
  const result = run({ machine: 's390x' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not know: s390x/);
});

test('an expected architecture can be named when checking away from the host', () => {
  assert.equal(run({ machine: 'arm64', platform: 'linux/amd64', expected: 'amd64' }).status, 0);
  assert.equal(run({ machine: 'arm64', platform: 'linux/arm64', expected: 'amd64' }).status, 1);
});
