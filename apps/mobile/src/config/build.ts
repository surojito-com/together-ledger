import { nativeApplicationVersion, nativeBuildVersion } from 'expo-application';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { buildName } from './build-name';

/**
 * This build, read from the installed app (#359). eas.json keeps the version and build number on
 * EAS ("appVersionSource": "remote") and app.json carries no build number, so both come from the
 * app as installed, never from the config. The commit is baked in by app.config.js.
 */
export const thisBuild = buildName({
  platform: Platform.OS,
  version: nativeApplicationVersion,
  buildNumber: nativeBuildVersion,
  commit: typeof Constants.expoConfig?.extra?.buildCommit === 'string' ? Constants.expoConfig.extra.buildCommit : null,
});
