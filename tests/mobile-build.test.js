import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

// #359: the phone shows which build it is at the foot of Settings, and every request it makes says
// the same in one header, so a tester's report can be matched to the build that sent it.

const mobile = new URL('../apps/mobile/', import.meta.url);
const read = (path) => readFile(new URL(path, mobile), 'utf8');

async function importMobile(path) {
  const { outputText } = ts.transpileModule(await read(path), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

const { buildName } = await importMobile('src/config/build-name.ts');
const { createAccountClient } = await importMobile('src/api/client.ts');

test('the build reads as Settings shows it and as the header carries it', () => {
  assert.deepEqual(buildName({ platform: 'android', version: '0.1.0', buildNumber: '2', commit: '977f365' }), { label: '0.1.0 (2) · 977f365', header: 'and/0.1.0+2/977f365' });
  assert.deepEqual(buildName({ platform: 'ios', version: '1.4.0', buildNumber: '31', commit: 'dev' }), { label: '1.4.0 (31) · dev', header: 'ios/1.4.0+31/dev' });
  // Nothing known, as in a test runner or the web: still a build name, never an empty header.
  assert.deepEqual(buildName({ platform: 'web', version: null, buildNumber: null, commit: null }), { label: '0 (0) · dev', header: 'web/0+0/dev' });
  assert.equal(buildName({ platform: 'android', version: '0.1.0 beta', buildNumber: '2/3', commit: '977f365' }).header, 'and/0.1.0beta+23/977f365', 'only what a version is made of');
});

test('the track and release number stay in the release notes, not in the app', async () => {
  const source = await read('src/config/build-name.ts');
  assert.doesNotMatch(source.replace(/\/\*\*[\s\S]*?\*\//g, ''), /INT-|track/i);
});

test('version and build number come from the installed app; the commit is baked in when it is built', async () => {
  const build = await read('src/config/build.ts');
  assert.match(build, /import \{ nativeApplicationVersion, nativeBuildVersion \} from 'expo-application';/);
  assert.match(build, /Constants\.expoConfig\?\.extra\?\.buildCommit/);
  const eas = JSON.parse(await read('eas.json'));
  assert.equal(eas.cli.appVersionSource, 'remote', 'EAS keeps the version and build number, so the config cannot be read for them');
  const app = JSON.parse(await read('app.json')).expo;
  assert.equal(app.ios.buildNumber, undefined);
  assert.equal(app.android.versionCode, undefined);
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.dependencies['expo-application'], '57.0.3');

  const require = createRequire(new URL('app.config.js', mobile));
  const config = require(new URL('app.config.js', mobile).pathname);
  const before = { ...process.env };
  try {
    for (const name of ['EAS_BUILD_GIT_COMMIT_HASH', 'GITHUB_SHA']) delete process.env[name];
    const resolved = config({ config: app });
    assert.equal(resolved.extra.buildCommit, 'dev', 'a build made anywhere else says dev');
    assert.deepEqual(resolved.extra.eas, app.extra.eas, 'app.json is extended, never replaced');
    assert.equal(resolved.android.package, app.android.package);
    process.env.EAS_BUILD_GIT_COMMIT_HASH = '977F365ABCDEF0123456789abcdef0123456789a';
    assert.equal(config({ config: app }).extra.buildCommit, '977f365');
    delete process.env.EAS_BUILD_GIT_COMMIT_HASH;
    process.env.GITHUB_SHA = '0123456789abcdef0123456789abcdef01234567';
    assert.equal(config({ config: app }).extra.buildCommit, '0123456', 'the GitHub test APK says its commit too');
    assert.equal(config.shortCommit({ EAS_BUILD_GIT_COMMIT_HASH: 'not a commit; rm -rf' }), 'dev');
  } finally {
    for (const name of ['EAS_BUILD_GIT_COMMIT_HASH', 'GITHUB_SHA']) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
});

test('every request from the phone says which build sent it, the image loader\'s included', async () => {
  const seen = [];
  let held = { token: 'access', tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), refreshToken: 'refresh', refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  const client = createAccountClient({
    base: () => 'https://api.example.test/api/v1',
    build: 'and/0.1.0+2/977f365',
    tokens: { read: async () => held, write: async (value) => { held = value; }, clear: async () => { held = null; } },
    fetch: async (url, init) => {
      seen.push(init.headers);
      if (url.endsWith('/session')) return { ok: true, status: 200, json: async () => ({ data: { user: { id: 'u1' } } }) };
      return { ok: false, status: 503, json: async () => null };
    },
  });
  await client.session();
  await client.login({ identifier: 'someone', password: 'x' }).catch(() => undefined);
  const image = await client.imageSource('j', 'm', 'i');
  for (const headers of [...seen, image.headers]) {
    assert.equal(headers['x-together-build'], 'and/0.1.0+2/977f365');
    assert.equal(headers['x-together-client'], 'app');
  }
  assert.equal(seen.length, 2);

  const session = await read('src/auth/session.tsx');
  assert.match(session, /createAccountClient\(\{ base: apiBase, fetch: \(url, init\) => fetch\(url, init\), tokens: secureTokenStore, build: thisBuild\.header \}\)/, 'the app\'s one client carries it');
});

test('Settings shows the build at its foot, plainly and copyable', async () => {
  const settings = await read('app/settings.tsx');
  const foot = settings.lastIndexOf('{thisBuild.label}');
  assert.ok(foot > settings.indexOf('ledger-support@together-ledger.com'), 'below everything else');
  assert.match(settings, /<Text selectable accessibilityLabel=\{`This build: \$\{thisBuild\.label\}`\}[^>]*>\{thisBuild\.label\}<\/Text>\s*<\/Screen>/);
});

test('no crash reporting comes with it', async () => {
  const pkg = JSON.parse(await read('package.json'));
  for (const name of Object.keys(pkg.dependencies)) assert.doesNotMatch(name, /sentry|crashlytics|bugsnag|firebase/i);
});
