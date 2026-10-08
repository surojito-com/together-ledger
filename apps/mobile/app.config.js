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

module.exports = ({ config }) => ({
  ...config,
  extra: { ...config.extra, buildCommit: shortCommit(process.env) },
});

module.exports.shortCommit = shortCommit;
