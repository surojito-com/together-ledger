# Invitation links on the phone

An invitation link opens the phone app when it is installed, and the website when it isn't: one link everywhere (#266). This page says what is claimed, what the owner sets up once, and how to check it on a real phone. Both platforms fail **silently** when something is wrong: the link just opens the browser. Reading the config proves nothing; tapping a real link on a real phone does.

## What is claimed

Only an invitation's own path: `https://app.together-ledger.com/invite`. The code is after the #, as `/invite#invite=<code>`, and is never in the path or the query (owner, Oct 10, 2026). Verification links (`/#verify=…`) and recovery links (`/#recovery=…`) stay on the web, and the app does not claim them.

Invitations have their own path because Android's App Links match a path but never what follows the #. A link at `/` could only be claimed together with every verification and recovery link.

| Where | What | File |
|---|---|---|
| Email | `https://app.together-ledger.com/invite#invite=<code>` | `server/mailer.js` (`INVITATION_PATH`) |
| Website | `/invite` is the app page; it reads the code, takes it out of the address and goes back to `/`. Every older shape still works: `/#invite=` and `/?invite=` | `src/app.js`, `wrangler.jsonc` (single-page fallback) |
| iPhone | `associatedDomains: ["applinks:app.together-ledger.com"]` | `apps/mobile/app.json` |
| iPhone | `/.well-known/apple-app-site-association`, served as `application/json`, for `769MBW6826.com.togetherledger.ledger`, claiming `/invite` only | `public/.well-known/`, `public/_headers` |
| Android | One `autoVerify` intent filter for `https://app.together-ledger.com/invite` | `apps/mobile/app.json` |
| Android | `/.well-known/assetlinks.json` (`application/json` from its extension) | `public/.well-known/assetlinks.json` |
| Phone | Reads the code from the opened link (`app/+native-intent.tsx`), keeps it in the keychain until it is answered (`src/invitations/`), and shows the invitation (`app/invite.tsx`) | `apps/mobile/` |

`scripts/app-links.mjs` says what each file must hold. The build checks them, the release gate checks them (`scripts/verify-release-bundle.mjs`), and so does `tests/app-links.test.js`.

## What the owner sets up once

### Apple: Associated Domains on the App ID

Capability sync is off in this repository (`EXPO_NO_CAPABILITY_SYNC=1`, `docs/IOS_RELEASE.md`), so EAS will not turn this on, and a build whose entitlements ask for it fails to sign without it.

1. developer.apple.com → Certificates, Identifiers & Profiles → Identifiers → `com.togetherledger.ledger`.
2. Tick **Associated Domains**. Leave Sign in with Apple on. Save.
3. Run the next iOS build as usual. A provisioning profile made before the capability was on doesn't carry it; if the build says so, let EAS make a new one when it offers to. **Not confirmed:** whether EAS does that without being asked.

No domain is entered in the portal. The domain comes from the app's entitlements and the website's file.

### Google: the two certificate fingerprints

`public/.well-known/assetlinks.json` holds two marked placeholders (`OWNER-TO-SUPPLY: …`). While it does, the build leaves the file out, the release gate refuses a bundle that carries it, and Android opens invitation links in the browser (#180 covers the same key).

1. Play Console → Together Ledger → **Test and release** → **App integrity**, where the app signing key and the upload key are shown.
2. Copy the **SHA-256 certificate fingerprint** under **App signing key certificate**. This is what Play-installed copies are signed with.
3. Copy the one under **Upload key certificate**. This is what EAS and the phone test APK sign with before Play re-signs.
4. Replace the two placeholders with them, as shown: upper-case hex pairs separated by colons (`AB:CD:…`, 32 pairs). Open a PR; the tests check the form.
5. After it deploys, Android re-verifies on the next install or update of the app.

## Checking it

**The files, once deployed** (from a browser or `curl`; Bot Fight Mode may refuse an automated client, which is why none of this is a gate):

- `https://app.together-ledger.com/.well-known/apple-app-site-association`: 200, `Content-Type: application/json`, no redirect.
- `https://app.together-ledger.com/.well-known/assetlinks.json`: 200, `application/json`, once the fingerprints are in. Until then the address answers with the app page.
- What Apple's CDN holds: `https://app-site-association.cdn-apple.com/a/v1/app.together-ledger.com`. It can lag a deploy by hours.
- What Google sees: `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://app.together-ledger.com&relation=delegate_permission/common.handle_all_urls`.

**Not verified yet:** whether Cloudflare's Bot Fight Mode lets Apple's and Google's verifiers fetch the files. If either platform's check fails while the files look right in a browser, look at Security → Events for `/.well-known/` first.

**On a real phone**, with a build that carries this change. Each of #266's four cases:

| Case | Do | Expect |
|---|---|---|
| App installed, signed in | Tap an invitation link in Mail or Messages | The app opens on the invitation: who invited you, the journey, Join and Not now |
| App installed, signed out | Tap the link, then Sign in (or Create account, or Google, or Apple) | After signing in, the invitation again, not an empty ledger. A new account sees "Verify your email…"; after verifying in the browser and coming back, the invitation |
| App not installed | Tap the link | The website opens and handles it. Then install the app, open it, choose **Have an invitation?** and paste the link or the code |
| Desktop browser | Open the link | The website handles it, and the address ends at `/` |

Also check: tapping the same link again once joined says you're already in, and nothing changes; a verification or recovery link still opens the browser, not the app.

Android only: `adb shell pm get-app-links com.togetherledger.ledger` should say `app.together-ledger.com: verified`. `adb shell pm verify-app-links --re-verify com.togetherledger.ledger` asks again.
