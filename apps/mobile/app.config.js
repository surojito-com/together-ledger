// app.json stays the app's configuration, and what the tests read. This only adds the commit the
// build was made from (#359), so the app can say which build it is at the foot of Settings and in
// the header every request carries (src/config/build.ts).
//
// EAS sets EAS_BUILD_GIT_COMMIT_HASH on its build machines. The phone test APK built on GitHub
// (.github/workflows/phone-test-apk.yml) has GITHUB_SHA instead. Anywhere else, such as a
// development build on someone's own machine, it says "dev".
function shortCommit(env) {
  for (const value of [env.EAS_BUILD_GIT_COMMIT_HASH, env.GITHUB_SHA]) {
    if (typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value)) return value.slice(0, 7).toLowerCase();
  }
  return 'dev';
}

// Google's sheet on an iPhone returns to the app through a URL scheme made from the iOS client ID
// (#217): the ID reversed, `com.googleusercontent.apps.<id>`. The ID is public and comes from the
// build profile (eas.json, EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID), never from the source. Without it the
// phone offers no Google, and Google's plugin is left out, since it refuses to run without a scheme.
// The plugin adds only that scheme to Info.plist; on Android it adds nothing.
function googleUrlScheme(env) {
  const id = typeof env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID === 'string' ? env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID.trim() : '';
  const match = /^([\w-]+)\.apps\.googleusercontent\.com$/.exec(id);
  return match ? `com.googleusercontent.apps.${match[1]}` : null;
}

module.exports = ({ config }) => {
  const scheme = googleUrlScheme(process.env);
  return {
    ...config,
    plugins: scheme ? [...config.plugins, ['@react-native-google-signin/google-signin', { iosUrlScheme: scheme }]] : config.plugins,
    extra: { ...config.extra, buildCommit: shortCommit(process.env) },
  };
};

module.exports.shortCommit = shortCommit;
module.exports.googleUrlScheme = googleUrlScheme;
