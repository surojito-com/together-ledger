import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

// The phone asks for nothing it does not use (#258). Expo's Android template grants
// SYSTEM_ALERT_WINDOW, VIBRATE and READ/WRITE_EXTERNAL_STORAGE unless told otherwise, and
// expo-file-system, which Expo itself depends on, merges the storage pair back in from its own
// manifest. expo-secure-store depends on androidx.biometric, which merges in USE_BIOMETRIC and
// USE_FINGERPRINT; the phone never asks for biometric unlock (no requireAuthentication).
// `permissions` sets what is granted; `blockedPermissions` writes tools:node="remove", which is
// the only thing that keeps a library's permission out of the merged manifest.
//
// To check a change: `npx expo prebuild --platform android --no-install` in apps/mobile, read
// android/app/src/main/AndroidManifest.xml, then delete android/ (it is generated, never committed).

const mobile = new URL('../apps/mobile/', import.meta.url);
const app = JSON.parse(await readFile(new URL('app.json', mobile), 'utf8')).expo;
const require = createRequire(import.meta.url);
// A file inside an installed package, wherever npm put it (the workspace or the root).
function installed(path) {
  for (const base of [new URL('node_modules/', mobile), new URL('../../node_modules/', mobile)]) {
    const url = new URL(path, base);
    if (existsSync(url)) return url;
  }
  return new URL(path, new URL('../../node_modules/', mobile));
}

// The phone talks to the API, and buys through Google Play (#272). Nothing else. BILLING is what
// Play Billing's own library declares; it lets the app reach Play's purchase service, shows no
// prompt, and reaches nothing on the phone. Play Console offers no products until a build has it.
// ACCESS_NETWORK_STATE comes with it: Play Billing depends on Google's datatransport, whose
// manifests declare it because they schedule their uploads to wait for a network, which Android 9
// and later refuse without it. It shows no prompt and says only whether the phone is online and on
// what kind of network. Blocking it would leave that code to fail inside Google's library.
const GRANTED = ['android.permission.INTERNET', 'com.android.vending.BILLING', 'android.permission.ACCESS_NETWORK_STATE'];
// ACCESS_WIFI_STATE is what @react-native-community/netinfo declares to read the Wi-Fi network's
// name and strength (#300). The phone needs only whether it is connected, which
// ACCESS_NETWORK_STATE already says, and the library checks for the permission before it reads
// anything Wi-Fi, so blocking it takes nothing away.
const BLOCKED = ['android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE', 'android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.VIBRATE', 'android.permission.USE_BIOMETRIC', 'android.permission.USE_FINGERPRINT', 'android.permission.ACCESS_WIFI_STATE'];

test('the phone is granted only the network and what Play Billing needs on Android, and gaining a permission fails here first', () => {
  assert.deepEqual(app.android.permissions, GRANTED, 'A new Android permission is a privacy decision: say what it is for, check the generated manifest, and update this list in the same change.');
});

test('what the template and libraries would add on their own is blocked', () => {
  for (const permission of BLOCKED) assert.ok(app.android.blockedPermissions.includes(permission), `${permission} must stay blocked`);
  for (const permission of app.android.blockedPermissions) assert.equal(GRANTED.includes(permission), false, `${permission} is both granted and blocked`);
});

test('nothing asks for biometric unlock, so blocking USE_BIOMETRIC and USE_FINGERPRINT takes nothing away', async () => {
  const files = [];
  for (const directory of ['app', 'src']) {
    for (const entry of await readdir(new URL(directory, mobile), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name)) files.push(`${entry.parentPath ?? entry.path}/${entry.name}`);
    }
  }
  assert.ok(files.some((file) => file.endsWith('token-storage.ts')), 'the phone\'s own code is read');
  for (const file of files) {
    assert.doesNotMatch(await readFile(file, 'utf8'), /requireAuthentication/, `${file}: biometric unlock needs USE_BIOMETRIC unblocked in app.json, and a privacy decision first.`);
  }
});

test('iOS asks for no permission either', () => {
  const usage = Object.keys(app.ios.infoPlist || {}).filter((key) => /UsageDescription$/.test(key));
  assert.deepEqual(usage, [], 'An iOS usage description is a permission prompt; it is a privacy decision like an Android permission.');
});

test('no config plugin arrives unexamined, since a plugin can add permissions of its own', () => {
  // expo-apple-authentication (#217) adds the Sign in with Apple entitlement and
  // CFBundleAllowMixedLocalizations on iOS, and nothing on Android.
  assert.deepEqual(app.plugins, ['expo-router', './plugins/with-scene-life-cycle', './plugins/with-tokens-out-of-backup', '@react-native-community/datetimepicker', 'expo-apple-authentication'], 'Check the generated manifest and Info.plist for what a new plugin adds, then update this list.');
  // The Google URL scheme (#217) is added by app.config.js through ./plugins/with-google-url-scheme,
  // only when the build has an iOS client ID: that scheme in Info.plist, and nothing on Android.
  // Google's Android library, play-services-auth 21.4.0, and the Play services libraries it
  // depends on declare no permission (read Oct 9, 2026), so the granted list above is unchanged.
  const withConfig = require('../apps/mobile/app.config.js');
  const saved = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  try {
    delete process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
    assert.deepEqual(withConfig({ config: app }).plugins, app.plugins);
    process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = '123-abc.apps.googleusercontent.com';
    assert.deepEqual(withConfig({ config: app }).plugins, [...app.plugins, ['./plugins/with-google-url-scheme', { scheme: 'com.googleusercontent.apps.123-abc' }]]);
  } finally {
    if (saved === undefined) delete process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
    else process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID = saved;
  }
  // The package's `exports` hide its native files, so they are read from where npm put it.
  const google = (path) => readFileSync(installed(`@react-native-google-signin/google-signin/${path}`), 'utf8');
  const manifest = google('android/src/main/AndroidManifest.xml');
  assert.doesNotMatch(manifest, /uses-permission/);
  const gradle = google('android/build.gradle');
  assert.match(gradle, /play-services-auth:\$\{safeExtGet\('googlePlayServicesAuthVersion', '21\.4\.0'\)\}/, 'a new play-services-auth was not read for the permissions it declares');
  // The iPhone's browser sheet, expo-web-browser, would add a Custom Tabs <queries> entry and an
  // activity on Android; nothing there uses it, so it is not linked there at all.
  const pkg = JSON.parse(readFileSync(new URL('package.json', mobile), 'utf8'));
  assert.deepEqual(pkg.expo.autolinking.android, { exclude: ['expo-web-browser'] });
});

test('sign-in tokens are kept out of Android cloud backup and device transfer, and nothing else is', async () => {
  const { FULL_BACKUP_XML, DATA_EXTRACTION_XML } = require('../apps/mobile/plugins/with-tokens-out-of-backup.js');
  const exclusion = '<exclude domain="sharedpref" path="SecureStore.xml"/>';
  assert.equal(FULL_BACKUP_XML.split(exclusion).length - 1, 1);
  assert.equal(DATA_EXTRACTION_XML.split(exclusion).length - 1, 2, 'once for cloud backup, once for device transfer');
  assert.match(DATA_EXTRACTION_XML, /<cloud-backup>\s*<exclude[^>]*\/>\s*<\/cloud-backup>/);
  assert.match(DATA_EXTRACTION_XML, /<device-transfer>\s*<exclude[^>]*\/>\s*<\/device-transfer>/);
  // An <include> would turn the rules into an allowlist and drop the ledger from backup.
  assert.doesNotMatch(FULL_BACKUP_XML + DATA_EXTRACTION_XML, /<include/);
  // The excluded file is where expo-secure-store keeps them. If the library renames it, this fails.
  const module = await readFile(require.resolve('expo-secure-store/android/src/main/java/expo/modules/securestore/SecureStoreModule.kt'), 'utf8');
  assert.match(module, /SHARED_PREFERENCES_NAME = "SecureStore"/);
  const tokenStorage = await readFile(new URL('src/auth/token-storage.ts', mobile), 'utf8');
  assert.match(tokenStorage, /from 'expo-secure-store'/);
  assert.match(tokenStorage, /WHEN_UNLOCKED_THIS_DEVICE_ONLY/, 'on iOS the keychain item stays on this device');
});

test('the APK check fails when it reads nothing, rather than passing an empty list', async () => {
  const workflow = await readFile(new URL('../.github/workflows/phone-test-apk.yml', import.meta.url), 'utf8');
  const step = workflow.slice(workflow.indexOf('- name: Check the APK asks only for the network and what Play Billing needs'));
  assert.match(step, /set -euo pipefail/, 'a missing aapt2 or APK must not hide behind tee');
  assert.match(step, /grep -qxF android\.permission\.INTERNET/, 'a list without INTERNET means the read failed');
  assert.match(step, /uses-permission\(-sdk-23\)\?/, 'uses-permission-sdk-23 grants a permission too');
  for (const permission of GRANTED) assert.ok(step.includes(`-e ${permission}`), `${permission} is what app.json grants, so the APK may ask for it`);
});
