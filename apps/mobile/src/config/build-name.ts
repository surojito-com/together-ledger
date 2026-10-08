/**
 * Which build of the phone app this is (#359), in the two shapes it is read in: at the foot of
 * Settings, and in the one header every request to our service carries, so a report can be matched
 * to the build that sent it in the API's log.
 *
 * The release name is `PRODUCT PLATFORM VERSION+BUILD TRACK-N COMMIT`, e.g.
 * `TL AND 0.1.0+2 INT-1 977f365`. Product, platform, version, build number and commit come from the
 * build itself. The track and release number (`INT-1`) belong to the store release, not the
 * binary, so they stay in the release notes and are never shown here.
 *
 * Kept free of runtime imports so it can be tested as it is (tests/mobile-build.test.js). What is
 * read from the installed app is src/config/build.ts.
 */
export type BuildFacts = {
  platform: string;
  /** The installed app's version, e.g. "0.1.0" (expo-application, nativeApplicationVersion). */
  version: string | null;
  /** The installed app's build number, e.g. "2" (expo-application, nativeBuildVersion). */
  buildNumber: string | null;
  /** The commit baked in when it was built (app.config.js), or "dev". */
  commit: string | null;
};

const PLATFORMS: Record<string, string> = { android: 'and', ios: 'ios' };

// Only what a version, a build number or a commit is ever made of: nothing a person typed.
function part(value: string | null | undefined, fallback: string) {
  const clean = String(value ?? '').replace(/[^A-Za-z0-9.-]/g, '').slice(0, 24);
  return clean || fallback;
}

export function buildName({ platform, version, buildNumber, commit }: BuildFacts) {
  const facts = { platform: PLATFORMS[platform] ?? part(platform, 'unknown'), version: part(version, '0'), build: part(buildNumber, '0'), commit: part(commit, 'dev') };
  return {
    /** What Settings shows, plainly, for copying into a report: `0.1.0 (2) · 977f365`. */
    label: `${facts.version} (${facts.build}) · ${facts.commit}`,
    /** The `x-together-build` header: `and/0.1.0+2/977f365`. */
    header: `${facts.platform}/${facts.version}+${facts.build}/${facts.commit}`,
  };
}
