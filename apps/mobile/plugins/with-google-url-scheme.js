const { IOSConfig, withInfoPlist } = require('expo/config-plugins');

// The scheme Google returns to on an iPhone (#217): the iOS client ID reversed,
// `com.googleusercontent.apps.<id>`, from the build profile, never the source (app.config.js). Google's
// own sign-in library is not in the iOS app (owner, Oct 9, 2026), so neither is its plugin; this adds
// the same one thing it did, the URL scheme in Info.plist, and nothing on Android.
module.exports = function withGoogleUrlScheme(config, { scheme } = {}) {
  if (!/^com\.googleusercontent\.apps\.[\w-]+$/.test(scheme || '')) throw new Error(`with-google-url-scheme: not a Google iOS client scheme: ${scheme}`);
  return withInfoPlist(config, (plist) => {
    if (!IOSConfig.Scheme.hasScheme(scheme, plist.modResults)) plist.modResults = IOSConfig.Scheme.appendScheme(scheme, plist.modResults);
    return plist;
  });
};
