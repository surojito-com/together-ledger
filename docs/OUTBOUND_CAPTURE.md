# What the website and the phone actually send (TL-C-03, #261)

`docs/STORE_READINESS.md` says what the code does. This checks that against what leaves the
browser and the phone, so `PRIVACY.md` and the store forms rest on evidence, not belief. Repeat it
on any release that adds a dependency, and run the by-hand phone capture below before a store
submission.

- **Last run:** Oct 10, 2026 (00:19 UTC), against `144803c` on `main` ("Let people continue with
  Google and Apple on the phone", #377), in a Linux cloud session, with headless Chromium 141.
- **Website:** captured, end to end, with stand-ins for every third party. **Phone:** inspected,
  not captured; a capture needs a device, which is the owner's by-hand step.

## How to run it

Website: a throwaway PostgreSQL database, then the script. It builds `_site` exactly as the release
does, serves it and the API at their production hostnames over TLS (a certificate made for the
run), and drives Chromium through every flow. Chromium resolves only our three hostnames, to the
script, and uses no proxy, so nothing reaches the internet.

```bash
docker compose up -d postgres
docker compose exec postgres createdb -U together tl_capture
DATABASE_URL=postgres://together:change-me@127.0.0.1:5432/tl_capture node scripts/capture-outbound.mjs
```

Phone: no database, no device. `--maven` also reads the Android manifests of the Maven libraries
behind Google sign-in and Play Billing, and needs the network.

```bash
node scripts/capture-outbound.mjs --phone --maven
```

Both write to `test-results/outbound-capture/` (`capture.md` and `capture.json`, `phone.md`) and
exit 1 if a check fails. Add `--chromium=/path/to/chrome` where Playwright's own browser isn't
installed. Neither runs in CI or the release gate: the website needs a database and a browser, and
`--maven` the network. `tests/outbound-declarations.test.js` holds the facts a file read can hold.

### What the website capture stands in for

| Real | Stand-in | So the capture shows |
|---|---|---|
| Google Identity Services (`accounts.google.com/gsi/client`) and Sign in with Apple JS (`appleid.cdn-apple.com`) | Served at the same addresses; Google's button hands back an ID token signed by a key made for the run, Apple's `signIn()` resolves with one | When and how the page loads them, and what it sends our API afterwards. **Not** what Google's and Apple's real scripts request once loaded (their iframes, popups and cookies): that is the providers' own traffic |
| Google's and Apple's key sets, Apple's token and revoke endpoints | The server's `fetch` answered in-process | What our server sends them, and when |
| Stripe's API | A local server the real Stripe SDK is pointed at | Exactly what the SDK would have sent `api.stripe.com` |
| Stripe Checkout (`checkout.stripe.com`) | A page that sends the person back to `success_url` | The navigation to Stripe with its `Referer`, and the return leg |
| The email sender (Resend) | The real mailer, with its transport replaced | Every message, its links, and where those links lead |
| The company site (`together-ledger.com`) | This repository's `public/` files | That the page asks for its icons there |
| Cloudflare and Caddy | Node's TLS server, mimicking `wrangler.jsonc`'s asset handling | — |

## What leaves the browser

Every flow #261 lists ran: first load and the three policy pages, register, verify email, sign out
and in, Continue with Google, Continue with Apple, create a journey, add a moment, add a photo
carrying GPS and camera EXIF, open it, invite, the invited person registering, verifying and
accepting, open billing, start a Stripe checkout and return, recovery in another browser, and
deleting two accounts (a password one and an Apple one).

| Host | Who | When | What is sent |
|---|---|---|---|
| `app.together-ledger.com` | Us (Cloudflare) | Every page load | Standard request details. Opening an emailed link sends its one-time token in the address (see Findings) |
| `api.together-ledger.com` | Us (AWS) | Every account action | JSON bodies (register, sign-in, moments, photo bytes, invitations, deletion), the `tl_session` cookie, the CSRF header, the photo's file name in `X-Together-Image-Name`. `Referer` is the origin only |
| `together-ledger.com` | Us (Cloudflare, the company site) | Every page load | The favicon and touch icon `index.html` links there. `Referer` origin only, no cookie. The company site's Worker sets no cookie and has no analytics (`together-ledger.com` repo, `worker/index.ts`) |
| `accounts.google.com` | Google | A signed-out person opens Sign in, for any reason, on a server with both providers configured | A script request; `Referer` origin only |
| `appleid.cdn-apple.com` | Apple | The same moment | A script request; `Referer` origin only |
| `checkout.stripe.com` | Stripe | Starting a checkout | A navigation; `Referer: https://app.together-ledger.com/`, no journey or moment id |

And from our server, because of what the browser did:

| Host | When | What is sent |
|---|---|---|
| Email sender (Resend) | Register, invite, recovery | Address, subject, body, and a link to `app.together-ledger.com` with a one-time token |
| `api.stripe.com` | Checkout | Price check; a customer with the payer's email and our account id; a session with our account and journey ids, quantity and return addresses |
| `www.googleapis.com` | Continue with Google | A request for Google's public keys, nothing about the person |
| `appleid.apple.com` | Continue with Apple; deleting that account | Public keys; the one-time code exchanged for a refresh token; that token revoked on deletion |

Checks, all passing: no host beyond these; every request `https`; **no font request of any kind**
(the web has no `@font-face` yet, so not even Gelasio is fetched); **Stripe's script loads on no
page**: only the checkout navigation reaches Stripe; 28 secrets (cookies, CSRF values, emailed
tokens, ID tokens, Apple's code, passwords) appear in no address or `Referer` beyond the emailed
link itself; the uploaded photo carried only its Orientation tag (the original had Make, Model,
Software, the EXIF directory and GPS); no request used the legacy accept route that puts an
invitation token in the address.

## What the phone can reach

From both exported bundles (`npx expo export --no-bytecode`, production API origin), the
autolinking commands the Podfile and Gradle run, and the manifests those libraries bring.

| Host | iPhone | Android | Why |
|---|---|---|---|
| `api.together-ledger.com` | calls | calls | Every request the app makes, over https |
| `accounts.google.com` | opens | — | Google's sign-in page in the system's sign-in sheet. The address is in the Android bundle too, as an unused constant in the shared `src/auth/social-sign-in.ts`; Android signs in through Google's SDK |
| `oauth2.googleapis.com` | calls | — | The iPhone exchanges Google's code for the ID token. Unused constant on Android, as above |
| Google Play services | — | via the system | Google's SDK, `play-services-auth` 21.4.0 |
| Apple's sign-in sheet, the App Store, Google Play | via the system | via the system | Sign in with Apple; StoreKit 2; Play Billing and its datatransport (still **not verified**, STORE_READINESS 2.4) |
| `kit.openiap.dev` | never | never | expo-iap's optional IAPKit service, in its JavaScript and native code alike; reached only through `kitApi()` or `verifyPurchaseWithProvider()`, which the app never calls (tested) |
| `clients3.google.com` | never | never | NetInfo's reachability probe, switched off (tested) |
| `apps.apple.com`, `play.google.com` | never | never | expo-iap's `deepLinkToSubscriptions()`, never called (tested) |
| `auth.expo.io`, `classic-assets.eascdn.net`, `localhost:8081`, `localhost:3000`, `expo.dev` | never | never | Expo's auth proxy (unused: the app returns on its own scheme), Expo Go, the dev server, router hints in error messages |

The rest are documentation links in error messages and bases for parsing paths.

- **The iPhone links no Google SDK.** Its autolinking lists 37 native libraries and none is
  Google's; Android's lists `@react-native-google-signin/google-signin`.
- **iOS privacy manifests:** expo-application, expo-constants, expo-file-system and React Native's
  six declare required-reason APIs only (as `docs/IOS_RELEASE.md` lists); none declares collected
  data or tracking.
- **Android adds no permission beyond STORE_READINESS 2.6.** `play-services-auth` and its 36
  dependencies declare none (they add Google's sign-in activity and a revocation service). Play
  Billing 9.1.0 brings `BILLING` and `ACCESS_NETWORK_STATE`, as 1.6 says; `play-services-location`
  19.0.0 declares none. `expo-file-system` asks for storage and NetInfo for Wi-Fi state; both are
  blocked in `app.json`. The built APK was last read on Oct 8 (#340), before #377: run Actions →
  Phone test APK once to confirm it from the APK itself.

## Against what we declare

`PRIVACY.md` covers the web and the phone. The Data safety and App Privacy answers
(STORE_READINESS Part 3) are for the phone app only, so the web's hosts are justified there by
scope.

| Host | `PRIVACY.md` | Data safety (3.1) | App Privacy (3.2) |
|---|---|---|---|
| `app.together-ledger.com` | Named (Cloudflare) | Web only | Web only |
| `api.together-ledger.com` | Named (Amazon Web Services) | Every type declared is what reaches it | Same |
| `together-ledger.com` | Cloudflare "runs our domain names"; the icon requests aren't said | Web only | Web only |
| Google and Apple sign-in, web | Said only "if you choose to sign in with" them; **the scripts load when Sign in opens** | Web only | Web only |
| Google and Apple sign-in, phone | Named | OAuth sign-in; no new type | No new type (decided Oct 9) |
| Stripe | Named, with the ids it receives | Phone never reaches Stripe | Same |
| Resend | Named | Service provider | — |
| App Store, Google Play | Named | Purchase history | Purchase history |
| `kit.openiap.dev` and the other never-reached hosts | Need nothing | Need nothing | Need nothing |

## Findings, for the owner

1. **An emailed link's token reaches Cloudflare.** Verification (30 minutes), recovery (30 minutes)
   and invitation (14 days) links carry their one-time token in the query. Opening one sends it to
   `app.together-ledger.com` in the address, and again in the `Referer` of the page's own three
   files, before the page removes it from the address bar. No other host receives it; the API gets
   it only in a body. The app Worker has Workers Logs on at full sampling (`wrangler.jsonc`);
   whether asset requests are logged there is **not verified**. `PRIVACY.md`'s promise that
   one-time codes are removed from logs is about our API's logs. Fixing it means carrying the
   token in the fragment (`/#verify=…`), which no browser sends anywhere. That would be a mailer,
   page and test change, not made here.
2. **Google and Apple hear about every signed-out Sign in.** Once `GOOGLE_WEB_CLIENT_ID` is set,
   their scripts load when a signed-out person opens Sign in, including to use a password or to
   recover an account. `PRIVACY.md` says they learn about it "if you choose to sign in with" them.
   What their real scripts do next was stood in for, not captured.
3. **The app's icons come from the company site.** STORE_READINESS 2.5 says the web loads no
   script, font or stylesheet from another origin. That is true, but its favicon and touch icon are
   fetched from `together-ledger.com`. The same files are in `_site`, so pointing `index.html` at
   `/favicon.svg` would keep every load on the app's own host. The company site's source has no
   `/favicon.svg` or `/apple-touch-icon.png` route, so in production those requests may not even
   succeed. That is **not verified**: production isn't fetched, on purpose.

## The real phone capture, by hand

Do this on both builds before submitting: a TestFlight build on an iPhone, and the Play internal
test build (or an EAS preview APK) on an Android phone. Both must have the production API origin
and the Google client IDs set. Use phones with nothing else signed in if you can, so other apps'
traffic is easy to set aside.

1. On the Mac: `brew install mitmproxy`, then `mitmweb --mode wireguard`. It shows a WireGuard
   configuration and a QR code.
2. On the phone: install the WireGuard app, scan the QR code, and turn the tunnel on. All the
   phone's traffic now passes through the Mac.
3. To read contents as well as hosts, open `mitm.it` in the phone's browser and install the
   certificate. On iPhone: Settings → General → VPN & Device Management → install the profile,
   then Settings → General → About → Certificate Trust Settings → turn on full trust. On Android
   a release build won't trust a certificate a person installs. Its connections then fail, but
   mitmproxy's event log still names the host of each one (the TLS SNI). Hosts are what this
   step is for.
4. With the app closed, wait two minutes and note what the phone sends on its own. That is the
   baseline, not ours.
5. Open the app and go through every flow: first launch, register, verify email (open the link
   on the phone), sign out and in, Continue with Google, Continue with Apple (iPhone), create a
   journey, hold a moment with a place, hold one with airplane mode on and let it send once you
   reconnect, invite someone and accept on a second account, a sandbox purchase (App Store sandbox
   account, or a Play licence tester) and Restore, recovery, delete the account.
6. In mitmweb, filter out the baseline. Every host left must be in the phone table above, or one
   of Apple's or Google's own system hosts for sign-in and purchases. For `api.together-ledger.com`
   flows, check that no address carries a token, and that each request carries nothing beyond its body,
   the bearer token, and the `x-together-client` and `x-together-build` headers.
7. Write the date, the two build numbers and the host list in a comment on #261. A host not in
   the table is a finding: say what sent it before anything is changed.

**Turn the WireGuard tunnel off and remove the certificate** (Settings → General → VPN & Device
Management) when done.
