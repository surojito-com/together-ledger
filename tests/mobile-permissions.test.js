import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

// The phone asks for nothing it does not use (#258). Expo's Android template grants
// SYSTEM_ALERT_WINDOW, VIBRATE and READ/WRITE_EXTERNAL_STORAGE unless told otherwise, and
// expo-file-system, which Expo itself depends on, merges the storage pair back in from its own
// manifest. `permissions` sets what is granted; `blockedPermissions` writes tools:node="remove",
// which is the only thing that keeps a library's permission out of the merged manifest.
//
// To check a change: `npx expo prebuild --platform android --no-install` in apps/mobile, read
// android/app/src/main/AndroidManifest.xml, then delete android/ (it is generated, never committed).

const mobile = new URL('../apps/mobile/', import.meta.url);
const app = JSON.parse(await readFile(new URL('app.json', mobile), 'utf8')).expo;
const require = createRequire(import.meta.url);

// The phone talks to the API. Nothing else.
const GRANTED = ['android.permission.INTERNET'];
const BLOCKED = ['android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE', 'android.permission.SYSTEM_ALERT_WINDOW', 'android.permission.VIBRATE'];

test('the phone is granted only the network on Android, and gaining a permission fails here first', () => {
  assert.deepEqual(app.android.permissions, GRANTED, 'A new Android permission is a privacy decision: say what it is for, check the generated manifest, and update this list in the same change.');
});

test('what the template and libraries would add on their own is blocked', () => {
  for (const permission of BLOCKED) assert.ok(app.android.blockedPermissions.includes(permission), `${permission} must stay blocked`);
  for (const permission of app.android.blockedPermissions) assert.equal(GRANTED.includes(permission), false, `${permission} is both granted and blocked`);
});

test('iOS asks for no permission either', () => {
  const usage = Object.keys(app.ios.infoPlist || {}).filter((key) => /UsageDescription$/.test(key));
  assert.deepEqual(usage, [], 'An iOS usage description is a permission prompt; it is a privacy decision like an Android permission.');
});

test('no config plugin arrives unexamined, since a plugin can add permissions of its own', () => {
  assert.deepEqual(app.plugins, ['expo-router', './plugins/with-scene-life-cycle', './plugins/with-tokens-out-of-backup', '@react-native-community/datetimepicker'], 'Check the generated manifest and Info.plist for what a new plugin adds, then update this list.');
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
