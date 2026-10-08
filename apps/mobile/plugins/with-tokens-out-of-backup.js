const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

/**
 * Keeps the phone's sign-in tokens out of Android backups (#258). On Android, expo-secure-store
 * keeps them encrypted in a SharedPreferences file named SecureStore, with the key in the
 * Keystore. Auto Backup copies SharedPreferences to the person's Google Drive and to a new phone
 * during device transfer; the Keystore key never travels, so what arrives cannot be decrypted, but
 * the encrypted tokens would still have left the phone. On iOS, WHEN_UNLOCKED_THIS_DEVICE_ONLY in
 * src/auth/token-storage.ts already keeps them out of every backup.
 *
 * Only that one file is excluded. With no <include> rule, everything else is backed up exactly
 * as before, the phone's own ledger in SQLite among it. expo-secure-store's own plugin would
 * instead back up SharedPreferences alone and drop the ledger from backup, so it is not used.
 * `android/` is generated, so this writes the rules on every prebuild.
 */
const FULL_BACKUP_RULES = 'tokens_out_of_backup_rules';
const DATA_EXTRACTION_RULES = 'tokens_out_of_data_extraction_rules';
const SECURE_STORE_FILE = 'SecureStore.xml';

const exclusion = `<exclude domain="sharedpref" path="${SECURE_STORE_FILE}"/>`;

// Android 11 and lower.
const FULL_BACKUP_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- Written by plugins/with-tokens-out-of-backup.js: sign-in tokens never leave this phone. -->
<full-backup-content>
  ${exclusion}
</full-backup-content>
`;

// Android 12 and higher: cloud backup and device-to-device transfer are ruled separately.
const DATA_EXTRACTION_XML = `<?xml version="1.0" encoding="utf-8"?>
<!-- Written by plugins/with-tokens-out-of-backup.js: sign-in tokens never leave this phone. -->
<data-extraction-rules>
  <cloud-backup>
    ${exclusion}
  </cloud-backup>
  <device-transfer>
    ${exclusion}
  </device-transfer>
</data-extraction-rules>
`;

function withBackupRuleFiles(config) {
  return withDangerousMod(config, ['android', (config) => {
    const directory = join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${FULL_BACKUP_RULES}.xml`), FULL_BACKUP_XML);
    writeFileSync(join(directory, `${DATA_EXTRACTION_RULES}.xml`), DATA_EXTRACTION_XML);
    return config;
  }]);
}

function withBackupRulesInManifest(config) {
  return withAndroidManifest(config, (config) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    application.$['android:fullBackupContent'] = `@xml/${FULL_BACKUP_RULES}`;
    application.$['android:dataExtractionRules'] = `@xml/${DATA_EXTRACTION_RULES}`;
    return config;
  });
}

module.exports = function withTokensOutOfBackup(config) {
  return withBackupRulesInManifest(withBackupRuleFiles(config));
};
module.exports.FULL_BACKUP_XML = FULL_BACKUP_XML;
module.exports.DATA_EXTRACTION_XML = DATA_EXTRACTION_XML;
