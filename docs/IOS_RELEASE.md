# Releasing the iPhone app to TestFlight

How the iPhone app is built in EAS's cloud and sent to TestFlight, without a Mac. The steps are
in the order the owner runs them. Each cites the Expo or Apple page it rests on. Those pages were
read on Oct 9, 2026. Anything that couldn't be confirmed against them is marked **Not confirmed**.

Nothing here is run by a pull request or a cloud session: no `eas build`, no `eas submit`, and no
change in App Store Connect, the Apple Developer account or EAS. The owner runs every step.

- **App:** Together Ledger, bundle ID `com.togetherledger.ledger`, iPhone only
  (`apps/mobile/app.json`).
- **App Store name:** "Together-Ledger" (`store/app-store/README.md`). The name under the icon stays
  "Together Ledger".
- **Build profile and submit profile:** `production` in `apps/mobile/eas.json`.
- **Held to these facts by:** `tests/mobile-ios-release.test.js`.

---

## Before you start

1. **A computer with Node 22 or later**, on macOS, Windows or Linux. EAS Submit "works on macOS,
   Linux, and Windows, so you don't need a Mac to ship iOS builds"
   ([Expo: Submit to the Apple App Store](https://docs.expo.dev/submit/ios/)). The build itself
   runs on EAS's machines.
2. **EAS CLI**, signed in to the Expo account that owns the project
   (`together-ledger-digital-llc-company`, `apps/mobile/app.json`):

   ```
   npm install --global eas-cli
   eas login
   ```

   ([Expo: Submit to the Apple App Store, Prerequisites](https://docs.expo.dev/submit/ios/)).
   `apps/mobile/eas.json` asks for EAS CLI 16 or later.
3. **A clean checkout of `main`** at the commit you mean to ship. The build records its commit
   (`apps/mobile/app.config.js`), and that commit goes into the release name (step 5).
   Run every `eas` command from `apps/mobile`. It is an npm workspace, so install from the
   repository root (`npm ci`), never inside `apps/mobile`.
4. **The app record in App Store Connect.** `ascAppId` points EAS at an existing app record, so the
   record has to exist before step 3
   ([Expo: TestFlight, Prerequisites](https://docs.expo.dev/submit/testflight/)). The in-app
   purchase products (#271) need the same record, so it probably exists already. If it doesn't:
   App Store Connect → Apps → **+** → New App, platform iOS, name "Together-Ledger", bundle ID
   `com.togetherledger.ledger`.
5. **The record's Apple ID, in `apps/mobile/eas.json`.** Done Oct 9: `submit.production.ios.ascAppId`
   is `6820375940`, the number shown at App Store Connect → Apps → Together-Ledger → **App Information** → General Information
   → **Apple ID** ([Expo: How to find ascAppId](https://docs.expo.dev/submit/ios/#configure-a-submission-profile);
   [Apple: App information](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information):
   "A unique identifier automatically generated for your app"). It is not a secret, so commit it in
   its own pull request. EAS accepts only digits there: "It should consist only of digits"
   (`@expo/eas-json` 24.9.0, `build/submit/schema.js`). Android submissions are not affected.
6. **The iOS Google client ID, in `apps/mobile/eas.json`, for Continue with Google and Sign in with
   Apple (#217).** Without it the build still works and offers email sign-in only. In Google Cloud
   Console → APIs & Services → Credentials, in the project that holds the web's client
   (`GOOGLE_WEB_CLIENT_ID`), create an OAuth client of type **iOS** with bundle ID
   `com.togetherledger.ledger`. Put its client ID (`<number>-<letters>.apps.googleusercontent.com`)
   in `build.production.env` as `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, and in `build.preview.env`
   for a preview build, in its own pull request; it is public, not a secret. Add the same ID to the
   server's `GOOGLE_CLIENT_IDS`, or the server refuses its tokens and the iPhone shows neither
   button. Apple needs nothing new: the server already accepts the bundle ID
   (`APPLE_CLIENT_IDS`), and the key that exchanges Apple's code is the web's.

---

## 1. Create an App Store Connect API key and give it to EAS

The key lets EAS sign in to Apple for you: to make the signing certificate and provisioning
profile (step 2) and to upload the build (step 3). **The key file never goes in this repository**,
or in any file a commit could pick up. `.gitignore` refuses `*.p8`, `*.p12` and
`*.mobileprovision` as a backstop.

1. **Make sure API access is on.** The first time only, the Account Holder requests it: App Store
   Connect → **Users and Access** → **Integrations** → App Store Connect API → **Request Access**
   ([Apple: App Store Connect API, "Request access"](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api)).
   Apple reviews the request "on a case-by-case basis".
2. **Generate a Team key.** As Account Holder or Admin: **Users and Access** → **Integrations** →
   **Team Keys** → **Generate API Key**. Give it a name you will recognise later, such as "EAS". Set
   **Access** to **App Manager**, then click **Generate**
   ([Apple: "Generate a team API key"](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api)).
   Use a Team key, not an individual one: "Individual keys aren't able to use Provisioning
   endpoints" ([Apple: Creating API Keys for App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)),
   and making the certificate and profile needs those endpoints.
3. **Download the `.p8` file**, and note the **Key ID** and the **Issuer ID** shown on the same
   page. Apple lets you download the key only once. Keep it in your password manager or another
   private place outside the repository.
4. **Give it to EAS**, from `apps/mobile`:

   ```
   eas credentials --platform ios
   ```

   Choose the `production` build profile and sign in when asked. Then choose **App Store Connect:
   Manage your API Key** → **Set up your project to use an API Key for EAS Submit**
   ([Expo: Submit to the Apple App Store, "Automate with EAS Workflows"](https://docs.expo.dev/submit/ios/#automate-with-eas-workflows)).
   When asked, give the path to the `.p8` file, the Key ID and the Issuer ID. EAS stores the key on
   its servers, against the project.
   **Not confirmed:** the exact wording of the choice that adds an existing key rather than making
   a new one. Expo's page names only the two menu entries above.

**Not confirmed: whether an App Manager key can make the distribution certificate.** Apple's role
page says an Admin on an organisation team has "Certificates, Identifiers & Profiles by default",
and says nothing equivalent for App Manager
([Apple: Role permissions](https://developer.apple.com/help/app-store-connect/reference/account-management/role-permissions)).
Expo says an App Manager *user* can make credentials only with that access switched on
([Expo: Apple Developer Program roles and permissions](https://docs.expo.dev/app-signing/apple-developer-program-roles-and-permissions/)).
A key has no such switch. Expo's own example for updating Apple credentials with a key uses one
with Admin access. So if step 2 refuses to make the certificate with the App Manager key, don't
reach for an Admin key. Either:

- answer **yes** when `eas build` asks to sign in to your Apple account, as the Account Holder,
  and let EAS make the credentials that once ([Expo: Managed credentials](https://docs.expo.dev/app-signing/managed-credentials/)); or
- generate a second Team key with **Admin** access just for that, and revoke it afterwards
  ([Apple: "Manage individual and team keys"](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api)).

Which of the two is your call.

---

## 2. The first build

From `apps/mobile`:

```
eas build --platform ios --profile production
```

([Expo: Submit to the Apple App Store, "Build a production app"](https://docs.expo.dev/submit/ios/#build-a-production-app)).

- **Signing.** On the first iOS build EAS makes and stores the **distribution certificate** and
  the **App Store provisioning profile**
  ([Expo: Managed credentials](https://docs.expo.dev/app-signing/managed-credentials/);
  [Expo: App credentials](https://docs.expo.dev/app-signing/app-credentials/)). Let it. One
  distribution certificate serves every app on the account. The profile is this app's own and
  "expire[s] after 12 months", after which the next `eas build -p ios` makes a new one. **Not
  confirmed:** that EAS also registers the bundle ID with Apple when it doesn't exist yet. It
  should already exist, because the App Store Connect record (Before you start, 4) can't be made
  without it. To have it
  use the API key from step 1 rather than an Apple sign-in, set these in the same terminal first.
  They are values, not files, and none of them go in the repository
  ([Expo: Building on CI, "Provide an ASC API token for your Apple team"](https://docs.expo.dev/build/building-on-ci/#optional-provide-an-asc-api-token-for-your-apple-team)):

  ```
  EXPO_ASC_API_KEY_PATH=<path to the .p8 file, outside the repository>
  EXPO_ASC_KEY_ID=<Key ID>
  EXPO_ASC_ISSUER_ID=<Issuer ID>
  EXPO_APPLE_TEAM_ID=<Team ID, from developer.apple.com → Membership details>
  EXPO_APPLE_TEAM_TYPE=COMPANY_OR_ORGANIZATION
  ```

  **Not confirmed:** that the team type is `COMPANY_OR_ORGANIZATION`. It should be, for an LLC's
  organisation membership. Check Membership details.
- **Leave the App ID's capabilities alone: set `EXPO_NO_CAPABILITY_SYNC=1`.** On the first build
  (Oct 9, `TL IOS 0.1.0+2`), `eas build` tried to switch **Push Notifications** and **Sign in with
  Apple** off on the App ID `com.togetherledger.ledger`, and Apple refused, so the build stopped.
  The app declares no entitlements (`apps/mobile/app.json`), and EAS turns off a capability it
  knows when the app's entitlements don't ask for it (eas-cli 24.12.1,
  `build/credentials/ios/appstore/bundleIdCapabilities.js`, `getCapabilitiesToDisable`). Both have
  to stay on: Sign in with Apple is used by the web and the server. EAS's own error named the way
  out: "Auto capability syncing can be disabled with the environment variable
  `EXPO_NO_CAPABILITY_SYNC=1`." With it set, EAS turns no capability on or off (the same file).
  Set it in the same terminal as the values above, for every iOS build:

  ```
  EXPO_NO_CAPABILITY_SYNC=1
  ```

  The cost: if the app ever does need a capability (push, for example, #265), turn it on in the
  Apple Developer portal by hand, because EAS no longer will.

  **Since #217 the app declares one capability, Sign in with Apple** (`usesAppleSignIn`, and
  `expo-apple-authentication`'s plugin, in `apps/mobile/app.json`). That doesn't make the variable
  unnecessary: the app still has no push entitlement, so without it EAS would still try to switch
  **Push Notifications** off on the App ID, which the web's Apple setup shares. Keep setting it.
  Sign in with Apple is already on for `com.togetherledger.ledger`, and has to stay on: the
  iPhone's own sign-in now needs it as well as the web's.
- **The build number.** `eas.json` keeps the version and build number on EAS's servers
  (`"appVersionSource": "remote"`) and adds one to the build number on every production build
  (`"autoIncrement": true`). The first build is 1 unless EAS already holds one
  ([Expo: App version management, "Remote version source"](https://docs.expo.dev/build-reference/app-versions/#remote-version-source)).
  The version stays 0.1.0, from `app.json`, until someone changes it there.
- **What the build carries.** The API origin is `https://api.together-ledger.com`
  (`eas.json` `build.production.env`). `ITSAppUsesNonExemptEncryption` is false, so App Store
  Connect doesn't ask the encryption questions on every upload. The app's only encryption is the
  system's: HTTPS, the Keychain, and random UUIDs
  ([Apple: Complying with encryption export regulations](https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations)).
  The privacy manifest is described below.

When it finishes, EAS shows the build's page, with the commit it was built from and the build
number.

---

## 3. Submit it to TestFlight

From `apps/mobile`, with `ascAppId` filled in (Before you start, 5):

```
eas submit --platform ios --profile production
```

([Expo: Submit to the Apple App Store, "Submit with eas submit"](https://docs.expo.dev/submit/ios/#submit-with-eas-submit)).
Choose the build from step 2 when asked. EAS uploads it with the API key from step 1. The build
appears under **TestFlight** → iOS Builds once Apple has processed it. Expo's two pages give
"10-15 minutes" and "5 to 10 minutes", Apple promises no time, and Apple sends an email when it is
done ([Expo: TestFlight, "Wait for processing"](https://docs.expo.dev/submit/testflight/)).

**If `eas submit` asks you to sign in with your Apple ID, put the key in the submit profile for
that one run.** On the first submission (Oct 9, `TL IOS 0.1.0+2`), giving `eas submit` the API key
when it asked for one interactively still ended in a request for an Apple ID sign-in. What worked
was adding the key's three values to `submit.production.ios` in `apps/mobile/eas.json`, on the
owner's Mac, next to `ascAppId`; `eas submit` then uploaded with the key alone, with no sign-in:

```json
"ios": {
  "ascAppId": "6820375940",
  "ascApiKeyPath": "<path to the .p8 file, outside the repository>",
  "ascApiKeyIssuerId": "<Issuer ID>",
  "ascApiKeyId": "<Key ID>"
}
```

Those three are fields EAS reads in a submit profile (`@expo/eas-json` 24.9.0,
`build/submit/schema.js`). **Never commit them.** Undo the edit afterwards:

```
git checkout -- eas.json
```

from `apps/mobile`, then check `git status` is clean. `tests/mobile-ios-release.test.js` fails if
any of the three reaches the repository.

**Watch your email after the upload.** Apple writes "within a few minutes" if the build uses a
required-reason API that the privacy manifest doesn't explain
([Expo: Privacy manifests, "Testing the privacy manifest"](https://docs.expo.dev/guides/apple-privacy/)).
If that email comes, add exactly the reason it names to `expo.ios.privacyManifests` in
`apps/mobile/app.json`, update this file and the test, and build again. Don't add reasons Apple
didn't ask for.

---

## 4. Add internal testers in TestFlight

Internal testers are people on the App Store Connect team, up to 100. They can install a build as
soon as Apple has processed it, with no Beta App Review
([Expo: TestFlight, "Internal versus external testing"](https://docs.expo.dev/submit/testflight/#internal-versus-external-testing);
[Apple: Add internal testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers)).

1. Anyone who should test but isn't on the team yet: add them under **Users and Access** →
   **People**, with access to this app. Internal testers are "App Store Connect users with access
   to your content". If someone doesn't appear when you invite testers, Apple's advice is to
   change their user role.
2. App Store Connect → Apps → Together-Ledger → **TestFlight**. In the sidebar, click **+** next to
   **Internal Testing**, name the group (for example "Together Ledger team") and click **Create**.
   "Enable automatic distribution" sends each new build to the group by itself.
3. In the group, click **Invite Testers**, tick the people and click **Add**.
4. If automatic distribution is off: **Builds** → **+** → choose the build → fill in **What to
   Test** → **Add**. Put the release name (step 5) at the top of What to Test, so a tester can
   match what they installed to what Settings shows.
5. Each tester accepts the email invitation in the **TestFlight** app on their iPhone and installs
   from there. A build can be tested for 90 days.

Later builds can go straight to the group:
`eas submit --platform ios --profile production --groups "<group name>" --what-to-test "<release name>"`
([Expo: TestFlight, the tip under "Invite testers"](https://docs.expo.dev/submit/testflight/)).

---

## 5. The release name

```
TL IOS 0.1.0+N TFI-1 <commit>
```

The shape is the one `apps/mobile/src/config/build-name.ts` describes for every phone release:
`PRODUCT PLATFORM VERSION+BUILD TRACK-N COMMIT` (Android's first was `TL AND 0.1.0+2 INT-1 977f365`).

| Part | Value | Where it comes from |
|---|---|---|
| `TL` | Together Ledger | |
| `IOS` | iPhone | |
| `0.1.0` | the version | `expo.version` in `apps/mobile/app.json` |
| `N` | the build number | EAS assigns it (step 2); shown on the build's page and next to the build in TestFlight |
| `TFI-1` | TestFlight Internal, the first release on that track | counted by hand; the next internal release is `TFI-2` |
| `<commit>` | the first 7 characters of the commit the build was made from | the build's page on EAS (`EAS_BUILD_GIT_COMMIT_HASH`, read by `apps/mobile/app.config.js`) |

The app shows the same build at the foot of Settings as `0.1.0 (N) · <commit>`, and sends
`ios/0.1.0+N/<commit>` in the `x-together-build` header (#359). The track and release number
(`TFI-1`) belong to the store release, not the binary, so the app never shows them.

---

## The privacy manifest

Apple turns away an upload that uses a "required reason" API without saying why in a privacy
manifest: "Starting May 1, 2024, apps that don't describe their use of required reason API in
their privacy manifest file aren't accepted by App Store Connect"
([Apple: Describing use of required reason API](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api)).
The manifest also lists the data the app collects, "on all platforms"
([Apple: Privacy manifest files](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files)).

**Where it comes from.** `expo.ios.privacyManifests` in `apps/mobile/app.json` becomes
`PrivacyInfo.xcprivacy` in the app target on prebuild
([Expo: Privacy manifests, "Configuration in app config"](https://docs.expo.dev/guides/apple-privacy/#configuration-in-app-config);
`withPrivacyInfo` in `@expo/config-plugins`). When `pod install` runs on EAS, React Native then
adds the reasons from every library that bundles a manifest of its own. It also adds its own core
reasons (`privacy_file_aggregation_enabled`, on unless `apple.privacyManifestAggregationEnabled`
is `false`; `react-native/scripts/cocoapods/privacy_manifest_utils.rb`). Expo still advises
declaring what libraries need, because "Apple does not correctly parse all the PrivacyInfo files
included by static CocoaPods dependencies"
([Expo: Privacy manifests, "Including required reasons for Expo SDK packages and other third-party libraries"](https://docs.expo.dev/guides/apple-privacy/#including-required-reasons-for-expo-sdk-packages-and-other-third-party-libraries)).
Apple's rule is the same: a library linked into the app's own executable is covered by the app's
manifest ("For each executable or dynamic library in an app that uses a required reason API, the
bundle that includes the executable or dynamic library needs to include a privacy manifest file
that reports the API").

**What the libraries already bring** (copied in by `pod install`, checked in `node_modules` at
this commit):

| Library | Category | Reasons |
|---|---|---|
| React Native core (`React-Core`, `React-cxxreact`, `React-timing`; the aggregation step adds these itself as well) | File timestamp; User defaults; System boot time | C617.1; CA92.1; 35F9.1 |
| `expo-application` | File timestamp | C617.1 |
| `expo-constants` | User defaults | CA92.1 |
| `expo-file-system` (a dependency of `expo`) | File timestamp; Disk space | 0A2A.1, 3B52.1; E174.1, 85F4.1 |

**What the app declares itself**, in `app.json`, because the library that needs it ships no
manifest:

| Category | Reason | Why |
|---|---|---|
| `NSPrivacyAccessedAPICategoryFileTimestamp` | **C617.1**: "access the timestamps, size, or other metadata of files inside the app container" | `expo-sqlite` compiles SQLite into the app (`vendor/sqlite3/sqlite3.c`), and SQLite calls `stat`, `fstat` and `lstat` on its database file, which is in the app's own container. `expo-sqlite` has no `PrivacyInfo.xcprivacy` |
| `NSPrivacyAccessedAPICategoryUserDefaults` | **CA92.1**: "read and write information that is only accessible to the app itself" | `expo-iap`'s StoreKit library, the `openiap` pod 3.6.1 (`expo-iap/openiap-versions.json`), writes one flag (`dev.hyo.openiap.firstPurchaseNoticeShown`) to `UserDefaults.standard` in `OpenIapFirstPurchaseNotice.swift`. Its podspec bundles no manifest |

The reason codes and API lists are Apple's
([NSPrivacyAccessedAPIType](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype)).
Nothing else is declared, because nothing else was found. The rest of the libraries with native
iOS code, read for the same APIs: `expo-secure-store` (the Keychain), `expo-crypto`, `expo-font`,
`expo-linking`, `expo-modules-core`, `@react-native-community/netinfo`,
`@react-native-community/datetimepicker`, `react-native-screens`,
`react-native-safe-area-context`, and since #217 `expo-apple-authentication` 57.0.2 and
`@react-native-google-signin/google-signin` 16.1.5's own Objective-C. None of them uses one.

**Google's sign-in SDK brings a manifest of its own, and it declares collected data (#217).**
`@react-native-google-signin/google-signin` depends on Google's `GoogleSignIn` pod (`~> 9.0`), which
pulls in `AppAuth`, `GTMAppAuth`, `GTMSessionFetcher` and `AppCheckCore`. `GoogleSignIn` 9.0.0's
`PrivacyInfo.xcprivacy` (read Oct 9, 2026, at
[google/GoogleSignIn-iOS, `GoogleSignIn/Sources/Resources/PrivacyInfo.xcprivacy`](https://github.com/google/GoogleSignIn-iOS/blob/9.0.0/GoogleSignIn/Sources/Resources/PrivacyInfo.xcprivacy))
declares User defaults (CA92.1, already in the list below) and, as data the SDK collects: Name,
Email Address, Phone Number, Other Data Types, Coarse Location and User ID for App Functionality,
and Other Data Types, User ID, Device ID and Other Usage Data for **Analytics**. None for tracking.
That is Google's description of its own SDK, not of anything our code does, and the app's own
manifest above is unchanged. **Not confirmed, and the owner's call:** whether App Store Connect's
App Privacy answers (`docs/STORE_READINESS.md` 3.2) have to grow to cover it, since Apple holds an
app's answers to include what its third-party code collects. The pods it pulls in were not read
for their own manifests; the `.ipa` check below shows every manifest that ends up in the app. `expo-dev-client`'s launcher and menu do
use user defaults, but they are linked only into development builds
(`:configurations => :debug`, `expo-dev-client.podspec`).

**Tracking:** `NSPrivacyTracking` false, `NSPrivacyTrackingDomains` empty. The app makes requests
only to our API (`docs/STORE_READINESS.md`, 2.5).

**Collected data:** the seven types `docs/STORE_READINESS.md` 3.2 answers **Yes**: Name, Email
Address, Other Financial Info, Precise Location, Other User Content, User ID, Purchase History.
Each is linked to the person, not used for tracking, and collected for App Functionality only
([Apple: NSPrivacyCollectedDataType](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatype)).
The test reads 3.2's table, so the two can't disagree. When 3.2 changes (photos, #187), the
manifest changes in the same pull request.

**What the built app should end up with**, once `pod install` has merged the libraries' reasons:
File timestamp C617.1, 0A2A.1, 3B52.1; User defaults CA92.1; System boot time 35F9.1; Disk space
E174.1, 85F4.1. **Not confirmed**: this is worked out from the aggregation script, not read from a
built app, because no iOS build has been made yet. To check it after step 2, download the `.ipa`
from the build's page, unzip it (it is a zip on any computer), and open
`Payload/TogetherLedger.app/PrivacyInfo.xcprivacy`. The reasons that come from `expo-file-system`
(0A2A.1, 3B52.1, 85F4.1) describe that library's own uses, not features of ours.

**The development client's local-network prompt.** A prebuild writes `NSLocalNetworkUsageDescription`
and `NSBonjourServices` into `Info.plist` for `expo-dev-client`, so a development build can find
Metro on the local network. A build phase added by the same plugin deletes both from every build
that isn't Debug ("[Expo Dev Launcher] Strip Local Network Keys for Release",
`expo-dev-launcher/plugin/build/withDevLauncher.js`). So the production build asks for no
permission at all. **Not confirmed** in a built app. The same `.ipa` check shows it:
`Payload/TogetherLedger.app/Info.plist` should have no `NSLocalNetworkUsageDescription`.

---

## iOS facts this rests on

Checked at this pull request's head. `tests/mobile-ios-release.test.js` fails if one changes.

| Fact | Where |
|---|---|
| Bundle ID `com.togetherledger.ledger` | `apps/mobile/app.json:13` |
| iPhone only (`supportsTablet: false`, which a prebuild turns into `TARGETED_DEVICE_FAMILY = "1"`) | `apps/mobile/app.json:12`. **Owner to confirm for v1** |
| `ITSAppUsesNonExemptEncryption` false | `apps/mobile/app.json:15` |
| No usage description in `Info.plist`: no camera, photos, location, contacts, microphone or notifications | `apps/mobile/app.json` (`infoPlist` holds only the encryption flag); no notifications dependency (`apps/mobile/package.json`). A prebuild adds `CFBundleAllowMixedLocalizations` (expo-apple-authentication, so Apple's button follows the phone's language) and, when the build has an iOS Google client, that client's URL scheme (`apps/mobile/app.config.js`); neither is a permission |
| One entitlement: Sign in with Apple (#217) | `usesAppleSignIn: true` and the `expo-apple-authentication` plugin in `apps/mobile/app.json`; the prebuilt entitlements file holds only `com.apple.developer.applesignin` = `Default`. Until #217 it was empty (#370) |
| The 1024 × 1024 icon has no alpha channel | `apps/mobile/assets/icon.png`: PNG colour type 2 (RGB), no `tRNS` chunk |
| The StoreKit product IDs match the server's | `apps/mobile/src/billing/store-products.ts:29-38` and `server/store-products.js:19-28`, the same eight IDs; held by `tests/mobile-store-purchase.test.js:116-122` |
| Guideline 4.8: Sign in with Apple comes with Google on the iPhone (#217) | The iPhone shows Continue with Google only beside Sign in with Apple, both or neither, and only once `GET /auth/providers?platform=ios` says both work (`apps/mobile/src/auth/social-sign-in.ts`, `offeredSignIns`). Until #217 the phone had no social login at all, and this row said so (#370) |
| The Google client ID is the build's, not the source's | `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` in the build profile's `env` (`apps/mobile/eas.json`), read by `apps/mobile/src/config/google.ts` and turned into Google's URL scheme by `apps/mobile/app.config.js`. Unset, the iPhone offers neither Google nor Apple |
| Privacy manifest present, no tracking | `apps/mobile/app.json`, `expo.ios.privacyManifests` |
| Submit profile points at the owner's app | `apps/mobile/eas.json`, `submit.production.ios.ascAppId`, `6820375940` (App Information → Apple ID) |
