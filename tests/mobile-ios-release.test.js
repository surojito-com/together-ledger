import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

// The iPhone build that EAS makes in the cloud and sends to TestFlight (docs/IOS_RELEASE.md). These
// are the facts about it that must not drift, because each one is either something App Store
// Connect refuses a build over, or something we have told Apple in a form.

const root = new URL('../', import.meta.url);
const mobile = new URL('apps/mobile/', root);
const app = JSON.parse(await readFile(new URL('app.json', mobile), 'utf8')).expo;
const eas = JSON.parse(await readFile(new URL('eas.json', mobile), 'utf8'));
// A file inside an installed package, wherever npm put it (the workspace or the root), without
// going through its package.json `exports`, which hide the native files.
function installed(path) {
  for (const base of [new URL('node_modules/', mobile), new URL('node_modules/', root)]) {
    const url = new URL(path, base);
    if (existsSync(url)) return url;
  }
  return new URL(path, new URL('node_modules/', root));
}

test('the bundle ID is the one App Store Connect, the server and the products are set up for', () => {
  assert.equal(app.ios.bundleIdentifier, 'com.togetherledger.ledger');
  assert.equal(app.android.package, app.ios.bundleIdentifier, 'the same identifier on both stores');
});

test('v1 is iPhone only', () => {
  // supportsTablet false is what makes the build iPhone only (TARGETED_DEVICE_FAMILY 1). Turning it
  // on means iPad screenshots and iPad review, so it is the owner's decision, not a tidy-up.
  assert.equal(app.ios.supportsTablet, false);
  assert.equal(app.ios.isTabletOnly, undefined);
});

test('the build says it uses only exempt encryption, so App Store Connect does not ask on every upload', () => {
  // The app's only encryption is the system's: HTTPS through the platform's networking, the
  // Keychain, and expo-crypto's random UUIDs. expo-sqlite is built without SQLCipher.
  assert.equal(app.ios.infoPlist.ITSAppUsesNonExemptEncryption, false);
  assert.equal(app.plugins.some((plugin) => [plugin].flat()[0] === 'expo-sqlite'), false, 'expo-sqlite with useSQLCipher would be non-exempt encryption');
});

test('the iPhone asks for no permission and carries no usage description', () => {
  const usage = Object.keys(app.ios.infoPlist).filter((key) => /UsageDescription$/.test(key));
  assert.deepEqual(usage, [], 'An iOS usage description is a permission prompt; it is a privacy decision.');
  assert.deepEqual(Object.keys(app.ios.infoPlist), ['ITSAppUsesNonExemptEncryption']);
  assert.equal(app.ios.entitlements, undefined, 'no capability, so no push, no Sign in with Apple, no app groups');
  assert.equal(app.ios.usesAppleSignIn, undefined);
  assert.equal(app.notification, undefined);
});

test('the phone offers no social login, so App Store guideline 4.8 does not ask for Sign in with Apple', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', mobile), 'utf8'));
  for (const name of ['expo-apple-authentication', 'expo-auth-session', '@react-native-google-signin/google-signin']) {
    assert.equal(pkg.dependencies[name], undefined, `${name} would put a social login on the phone, and Sign in with Apple with it`);
  }
  const files = [];
  for (const directory of ['app', 'src']) {
    for (const entry of await readdir(new URL(directory, mobile), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(`${entry.parentPath ?? entry.path}/${entry.name}`);
    }
  }
  assert.ok(files.some((file) => file.endsWith('src/api/client.ts')));
  for (const file of files) {
    assert.doesNotMatch(await readFile(file, 'utf8'), /\/auth\/(google|apple)\b/, `${file} calls a social sign-in route`);
  }
});

test('the 1024px icon has no alpha channel, which App Store Connect refuses', async () => {
  const png = await readFile(new URL(app.icon, mobile));
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  // Colour type 4 and 6 carry alpha; a tRNS chunk adds transparency to the others.
  assert.ok([0, 2].includes(png[25]), `colour type ${png[25]} carries alpha`);
  assert.equal(png.includes(Buffer.from('tRNS', 'latin1')), false, 'a tRNS chunk makes part of the icon transparent');
});

// ---------------------------------------------------------------------------------------------
// The privacy manifest (PrivacyInfo.xcprivacy). Expo writes `ios.privacyManifests` into the app
// target on prebuild; React Native's pod install then adds the reasons from every library that
// bundles its own manifest. What is declared here is what the app's own code and the libraries
// with no manifest of their own use. docs/IOS_RELEASE.md has the sources for each entry.

const manifest = app.ios.privacyManifests;

// Apple's reason codes per category ("NSPrivacyAccessedAPITypeReasons"), without the ones only a
// third-party SDK may declare (0A2A.1, C56D.1).
const APP_REASONS = {
  NSPrivacyAccessedAPICategoryFileTimestamp: ['DDA9.1', 'C617.1', '3B52.1'],
  NSPrivacyAccessedAPICategorySystemBootTime: ['35F9.1', '8FFB.1', '3D61.1'],
  NSPrivacyAccessedAPICategoryDiskSpace: ['85F4.1', 'E174.1', '7D9E.1', 'B728.1'],
  NSPrivacyAccessedAPICategoryActiveKeyboards: ['3EC4.1', '54BD.1'],
  NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1', '1C8F.1', 'AC6B.1'],
};

test('the privacy manifest says nothing is used for tracking and names no tracking domain', () => {
  assert.ok(manifest, 'expo.ios.privacyManifests is what puts PrivacyInfo.xcprivacy in the app');
  assert.equal(manifest.NSPrivacyTracking, false);
  assert.deepEqual(manifest.NSPrivacyTrackingDomains, []);
  for (const entry of manifest.NSPrivacyCollectedDataTypes) assert.equal(entry.NSPrivacyCollectedDataTypeTracking, false, entry.NSPrivacyCollectedDataType);
});

test('the privacy manifest declares the required-reason APIs the app needs, each with a reason an app may give', () => {
  const declared = Object.fromEntries(manifest.NSPrivacyAccessedAPITypes.map((entry) => [entry.NSPrivacyAccessedAPIType, entry.NSPrivacyAccessedAPITypeReasons]));
  for (const [category, reasons] of Object.entries(declared)) {
    assert.ok(APP_REASONS[category], `${category} is not one of Apple's categories`);
    for (const reason of reasons) assert.ok(APP_REASONS[category].includes(reason), `${reason} is not a reason an app may give for ${category}`);
  }
  assert.deepEqual(declared, {
    // expo-sqlite compiles SQLite into the app with no manifest of its own, and SQLite calls stat,
    // fstat and lstat on its database, which sits in the app's container.
    NSPrivacyAccessedAPICategoryFileTimestamp: ['C617.1'],
    // expo-iap's StoreKit library (the openiap pod) writes one flag to UserDefaults.standard and
    // ships no manifest of its own.
    NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1'],
  });
});

test('the libraries that bring their own manifest still declare only what was read', async () => {
  // React Native's pod install copies these into the app's manifest. When an update changes one,
  // read it again, and check docs/IOS_RELEASE.md and the declaration above still hold.
  const expected = {
    'expo-application/ios/PrivacyInfo.xcprivacy': ['NSPrivacyAccessedAPICategoryFileTimestamp'],
    'expo-constants/ios/PrivacyInfo.xcprivacy': ['NSPrivacyAccessedAPICategoryUserDefaults'],
    'expo-file-system/ios/PrivacyInfo.xcprivacy': ['NSPrivacyAccessedAPICategoryFileTimestamp', 'NSPrivacyAccessedAPICategoryDiskSpace'],
    'react-native/React/Resources/PrivacyInfo.xcprivacy': ['NSPrivacyAccessedAPICategoryFileTimestamp', 'NSPrivacyAccessedAPICategoryUserDefaults'],
    'react-native/ReactCommon/react/timing/PrivacyInfo.xcprivacy': ['NSPrivacyAccessedAPICategorySystemBootTime'],
  };
  for (const [path, categories] of Object.entries(expected)) {
    const plist = await readFile(installed(path), 'utf8');
    assert.deepEqual([...plist.matchAll(/NSPrivacyAccessedAPICategory\w+/g)].map((match) => match[0]), categories, path);
    assert.doesNotMatch(plist, /NSPrivacyTracking<\/key>\s*<true\/>/, `${path} says it tracks`);
  }
  // The two that ship no manifest, as read for the declaration above.
  assert.equal(JSON.parse(await readFile(installed('expo-iap/openiap-versions.json'), 'utf8')).apple, '3.6.1', 'a new openiap was not read for required-reason APIs');
  assert.ok(existsSync(installed('expo-sqlite/vendor/sqlite3/sqlite3.c')), 'expo-sqlite still compiles SQLite into the app');
  assert.equal(existsSync(installed('expo-sqlite/ios/PrivacyInfo.xcprivacy')), false, 'expo-sqlite now brings its own manifest: read it, and check whether the app still needs to declare file timestamps');
});

test('the privacy manifest collects exactly what the App Privacy answers say, for app functionality only', async () => {
  const readiness = await readFile(new URL('docs/STORE_READINESS.md', root), 'utf8');
  const section = readiness.slice(readiness.indexOf('### 3.2 Apple: App Privacy'), readiness.indexOf('**Privacy policy URL:**', readiness.indexOf('### 3.2')));
  assert.match(section, /\*\*Linked to the user: Yes\*\*/);
  assert.match(section, /\*\*Used for tracking: No\.\*\*/);
  const answered = [...section.matchAll(/^\| [^|]*?→ \*\*([^*]+)\*\* \| \*\*Yes\*\* \| \*\*([^*]+)\*\* \|/gm)]
    .map(([, type, purpose]) => ({ type: `NSPrivacyCollectedDataType${type.replace(/\s/g, '')}`, purpose: `NSPrivacyCollectedDataTypePurpose${purpose.replace(/\s/g, '')}` }));
  const yes = section.split('\n').filter((line) => /^\|[^|]+\| \*\*Yes\*\* \|/.test(line));
  assert.equal(answered.length, yes.length, 'every row answered Yes in 3.2 names an Apple type the manifest can be checked against');
  assert.equal(answered.length, 7, 'the rows answered Yes in 3.2');
  assert.deepEqual(manifest.NSPrivacyCollectedDataTypes.map((entry) => entry.NSPrivacyCollectedDataType).sort(), answered.map((row) => row.type).sort());
  for (const row of answered) {
    const entry = manifest.NSPrivacyCollectedDataTypes.find((candidate) => candidate.NSPrivacyCollectedDataType === row.type);
    assert.equal(entry.NSPrivacyCollectedDataTypeLinked, true, row.type);
    assert.deepEqual(entry.NSPrivacyCollectedDataTypePurposes, [row.purpose], row.type);
  }
});

// ---------------------------------------------------------------------------------------------

test('eas submit sends the iPhone build to the owner\'s App Store Connect app, once its ID is filled in', () => {
  // A placeholder, not an ID: EAS refuses an ascAppId that is not all digits, so `eas submit -p ios`
  // stops here until the owner puts in the Apple ID from App Information. It is not a secret.
  assert.equal(eas.submit.production.ios.ascAppId, '<OWNER: App Store Connect app ID>');
  assert.deepEqual(Object.keys(eas.submit.production.ios), ['ascAppId'], 'the API key lives in EAS, never here');
  assert.deepEqual(eas.submit.production.android, { track: 'internal', releaseStatus: 'draft' });
  assert.deepEqual(eas.build.production, { channel: 'production', env: { EXPO_PUBLIC_API_ORIGIN: 'https://api.together-ledger.com' }, autoIncrement: true });
});
