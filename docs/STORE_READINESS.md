# Store readiness: what Together Ledger collects, and the answers we give about it

This is the one place the facts are written down (#264). `PRIVACY.md`, Google Play's Data Safety
form and Apple's App Store privacy labels are all written **from** this file, never from each other
and never from memory. When they disagree with it, this file is checked against the code, and the
one that is wrong is corrected.

- **As of:** `1cc17a6` on `main` (Oct 7, 2026, "Let a lapsed journey rest read-only…"). Every
  section below was checked against that commit. A section checked later says so: the phone's
  store purchases (#340) were added on Oct 8, 2026, checked at that pull request's head.
- **Scope of the store answers (Part 3):** the phone app in `apps/mobile`, as it builds today. Not
  the web app. The server is described because the forms ask what happens to data after it leaves
  the phone.
- **Keeping it true:** a change that adds a dependency that makes a network request, a permission,
  or a new data field updates this file in the same pull request (`CONTRIBUTING.md`).
  `tests/store-readiness.test.js` fails when either `package.json` names a dependency that Part 2's
  dependency tables don't.

Every entry carries one of three marks:

- **Verified in code**: read in the code at the commit above, with the lines cited.
- **Decision**: a choice someone made (named and dated where known), or a judgement this file
  makes that the owner should confirm before it goes into a console.
- **Not verified**: believed true but not checked, or only checkable outside this repository (a
  console setting, a deployed host, captured traffic). TL-C-03 (#261), capturing the phone's real
  traffic, has not happened yet, so no entry here is verified by captured traffic.

---

## Part 1. Open problems the forms have to reflect

The Oct 7 code survey (#258) found five places where the code and `PRIVACY.md` disagree. Two were
fixed in #332; three are still true at `1cc17a6`. Each is either a code fix or an honest sentence.
**Which one is the owner's call**, and the store answers in Part 3 are written for the code as it
is, so they are honest today and say which answer changes if a fix lands.

### 1.1 The phone re-sends a moment's coordinates when it is edited (still true)

- **Verified in code.** The web adds a device location as a place carrying `latitude`, `longitude`
  and `accuracyMeters`, and writes the coordinates to four decimals into the place's label too:
  `Device location (22.5726, 88.3639)` (`src/app.js:1276-1279`).
- **Verified in code.** The phone never reads the device's location: it has no location library
  (`apps/mobile/package.json:13-30`) and adds places as typed words only
  (`apps/mobile/src/journey/moment-draft.ts:118-123`). But it copies every place of a moment it
  opens, coordinates included (`moment-draft.ts:63`), and sends them all back on save
  (`moment-draft.ts:112`, called from `apps/mobile/src/journey/moment-actions.ts:45`) and on
  "share now" (`moment-draft.ts:149-151`, `moment-actions.ts:60`). The server stores what it is
  sent (`server/platform.js:292-301`).
- **What it means for the forms.** The phone transmits precise coordinates off the device whenever
  someone edits a moment that has a device location. Google and Apple both count that as
  collecting precise location, even though the coordinates came from the web. Part 3 declares it.
- **The fix, if wanted, is not one line.** Leaving `locations` out of the payload when the places
  didn't change would stop the plain re-send (the server keeps the stored places when the field is
  absent, `server/platform.js:292`), but removing or adding one place still has to send the rest,
  and the label itself carries the coordinates. Until the phone never handles them, keep the
  declaration.

### 1.2 Uploaded photos kept their EXIF data (fixed, server half not yet live)

- **Verified in code.** The server removes a photo's location and camera details before storing it
  (`server/platform.js:1624-1637`, using `src/photo-metadata.js`), and the web does the same before
  sending (#332, merged as `675a399`).
- **Not verified.** On Oct 8 the API on production still predated #332: a hand-made upload came
  back unchanged (#258, Oct 8 comment). It is fixed in production only once the API is redeployed
  and that check is repeated.
- **Decision (Oct 8, owner):** photos stored before the fix stay as they are for now, and so do the
  backups that hold them.
- **Verified in code.** Kept with each photo: its original file name (`server/platform.js:257-266`,
  `:1651`). A phone's file name often carries a date and time.
- **For the phone forms: no change.** The phone cannot attach photos yet (#187): it has no image
  picker dependency (`apps/mobile/package.json:13-30`) and sends `images: []`
  (`apps/mobile/app/moment.tsx:98`). It only downloads photos others added
  (`apps/mobile/src/api/client.ts:197-212`). When #187 ships, Photos becomes collected (Part 3).

### 1.3 A shared moment's title and places stay in the journey history after deletion (still true)

- **Verified in code.** When a shared moment is added, updated or deleted, the journey's event
  history records a copy of it with only `detail` removed (`server/platform.js:268-272`): its title,
  kind, date, money context, theme, and **places with their coordinates**
  (`server/platform.js:1538`, `:1560`, `:1601-1602`). Every journeyer receives that history
  (`server/platform.js:1764`, `:1784`), the phone included.
- **Verified in code.** Deleting the moment adds a `moment_deleted` event whose `before` is that
  copy (`server/platform.js:1560`). Deleting the account removes the person from a journey others
  are still in but leaves its events (`server/platform.js:1878-1891`); only a journey nobody else
  is in is deleted with its history (`server/platform.js:1871-1877`).
- **Verified in code.** Private and share-later moments are not affected: their history holds
  visibility and theme only (`server/platform.js:992`, `:1540`, `:1556`), and they are deleted with
  the account (`server/platform.js:1879-1880`).
- **Where `PRIVACY.md` is wrong.** It says the shared stream records sharing "without copying its
  title or detail" (`PRIVACY.md:40`). That is true only for the moment a share-later moment is
  shared (`server/platform.js:1600-1602`); a moment added as shared, or edited or deleted after,
  copies the title and places.

### 1.4 The person's email stays visible to journeyers after their account is deleted (still true)

- **Verified in code.** Deletion replaces the email on the account row (`server/platform.js:1917-1920`),
  so anything that reads the email through the account shows the replacement: who proposed
  someone (`server/platform.js:1746-1748`) and each journeyer's answer to a proposal
  (`:1749-1753`).
- **Verified in code.** But two tables hold their own copy of an email address, and deletion only
  partly clears them:
  - `invitations.email_normalized`: invitations the person **sent** are deleted, and invitations
    **to** them that were never accepted are revoked (`server/platform.js:1915-1916`). An accepted
    invitation to them keeps their real email, and every journeyer reads it
    (`server/platform.js:144`, `:1745`, `:1777`).
  - `journey_invite_proposals.email_normalized`: a proposal to add them keeps their real email,
    whatever its state, and every journeyer reads it (`server/platform.js:171`, `:1746-1748`,
    `:1778`). Deletion does not touch this table.
- **Since #348 and #350 (Oct 8, 2026)** journeyers no longer read either address whole: the server
  sends it masked (`s••d@gmail.com`), and the journey's history records each invitation step with
  the same mask and never the full address. The rows above still hold the real address, which the
  server needs to send the invitation and to match the person accepting it. `PRIVACY.md` says so.
- **Where `PRIVACY.md` was wrong.** It said the history records the deletion "without your email"
  (`PRIVACY.md:80`). The `member_deleted_account` event itself is without it
  (`server/platform.js:1890`); the invitation and proposal records are not.

### 1.5 Apple and Google sign-in exist on the server (true; the web offers them once configured, the phone doesn't)

- **Verified in code.** `POST /api/v1/auth/google` and `/api/v1/auth/apple`, and the link route,
  exist (`server/app.js:191-209`), backed by `server/platform.js:528-680`, `server/identity.js` and
  `server/apple.js`. A new account from either stores the provider's subject id, the email it gives
  (or a placeholder for an Apple relay that is taken or missing), and the name it gives
  (`server/platform.js:607-645`). An Apple account also keeps an encrypted Apple refresh token,
  revoked with Apple when the account is deleted (`server/platform.js:1897-1914`, `:1928-1931`).
- **Verified in code.** The phone offers neither: its client has no call to these routes
  (`apps/mobile/src/api/client.ts:135-268`) and no Apple or Google sign-in dependency
  (`apps/mobile/package.json:13-30`).
- **Verified in code (#216).** The web offers both together, or neither. It shows "Continue with
  Google" and "Continue with Apple" only when `GET /api/v1/auth/providers` says both are
  configured (`server/app.js:194-197`, `server/platform.js:644-651`), and it loads Google's and
  Apple's own scripts only when a signed-out person opens the account dialog
  (`src/app.js:1683-1715`). Until `GOOGLE_WEB_CLIENT_ID` is set on the server, it shows neither.
  The store answers in Part 3 are about the phone and don't change.
- **What it means.** Nothing goes to Apple or Google for sign-in from the phone, and nothing from
  the web until the owner sets `GOOGLE_WEB_CLIENT_ID`. Then, on the web, the person's browser
  signs in with Apple or Google directly, and `PRIVACY.md` already names both (its "Signing in
  with Apple or Google"). **App Store guideline 4.8 requires Sign in with Apple on the phone
  whenever Google sign-in is offered there.**
- **Verified in code.** The phone deletes an account only with a password
  (`apps/mobile/app/delete-account.tsx:48-50`). A Google or Apple account has none
  (`server/platform.js:642`, `:1842-1848`), so the phone's delete screen needs to change before
  either sign-in reaches the phone. Apple requires in-app deletion for every account.

### 1.6 Android template permissions (fixed; two added for store purchases)

- **Verified in code.** The template's and libraries' extra permissions are blocked
  (`apps/mobile/app.json:32-39`), enforced by `tests/mobile-permissions.test.js`. The release APK's
  own permission list was read in #332: `INTERNET` and the app's own
  `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` (#258, Oct 8 comment).
- **Added by #340 (checked Oct 8, 2026).** Selling through Google Play brings two more, granted in
  `apps/mobile/app.json:27-31` and listed in `tests/mobile-permissions.test.js:28`:
  `com.android.vending.BILLING`, declared by the Play Billing library, and
  `android.permission.ACCESS_NETWORK_STATE`, declared by Google's datatransport libraries that Play
  Billing 9.1.0 depends on. The APK built from #340 (Phone test APK run 37737591737) asks for
  exactly `INTERNET`, `BILLING`, `ACCESS_NETWORK_STATE` and the app's own receiver permission; the
  workflow's check fails on anything else. Neither new permission shows a prompt (2.6).

---

## Part 2. The facts

### 2.1 Account fields

| Field | Required | Where it comes from | Mark |
|---|---|---|---|
| Email address | Required | Typed at registration (`apps/mobile/src/api/client.ts:136-139`); normalized and stored (`server/platform.js:457`, `:466-468`) | Verified in code |
| Username (private sign-in name) | Required | Typed at registration; 3–30 lowercase letters, numbers, hyphens (`server/platform.js:76-82`) | Verified in code |
| Password | Required | Typed at registration, 12–128 characters, stored only as an Argon2id hash (`server/platform.js:89-91`, `server/security.js:17-27`) | Verified in code |
| Display name (what journeyers see) | Optional | Starts as the username (`server/platform.js:459`); changed in the app (`client.ts:214-216`, `server/platform.js:1801-1815`). A change is written into every journey's history (`server/platform.js:1809-1812`) | Verified in code |
| Email verified, created-at | Set by the server | `server/platform.js:99-108`, `:492` | Verified in code |
| Google/Apple subject id, provider email and name, Apple refresh token | Only for a Google/Apple account | `server/platform.js:607-645`; the web, once configured, and not the phone (1.5) | Verified in code |
| Store purchase tokens (random UUIDs per account and per journey) | Only when a purchase starts | `server/platform.js:1824-1839`; fetched by the phone before each purchase (`apps/mobile/src/api/client.ts:255`) and handed to Apple or Google (`apps/mobile/src/billing/store-purchase.ts:117`, `:121`) (#340) | Verified in code |
| Store purchases (the Apple signed transaction, or the Google product and purchase token; the moment for an extra place) | Only when the person buys | Sent by the phone after each purchase (`apps/mobile/src/api/client.ts:264-268`, `apps/mobile/src/billing/store-purchase.ts:186`) and kept as a `billing_store_purchases` row (`docs/STORE_PURCHASES.md`) (#340) | Verified in code |
| What Apple or Google says about a purchase afterwards (App Store Server Notifications, Google Play Real-time developer notifications: type, subtype, Apple's `transactionId` or a 16-character hash of Google's purchase token, when it was signed or happened and when it was received, and what changed) | Only when Apple or Google sends one, server to server; the phone is not involved | Kept as a `billing_store_notifications` row (`server/migrations/034_hear-refunds-and-renewals-from-the-stores.sql`, `docs/STORE_PURCHASES.md`) (#273) | Verified in code |

No birthdate, phone number, address, gender, photo of the person, contacts, or device identifier
is asked for anywhere in the phone app (`apps/mobile/src/api/client.ts:135-268` is every call it
makes). **Verified in code.**

### 2.2 User content stored on the server, by kind

What the phone can send, from `apps/mobile/src/api/client.ts`:

| Kind | Fields | Phone call | Server | Mark |
|---|---|---|---|---|
| Journey | Name, a place in words, start and end dates (no budget: always 0) | `client.ts:176-178`, `apps/mobile/src/journey/journey-draft.ts:66-79` | `server/platform.js:1172-1192`, `:316-328` | Verified in code |
| Moment | Kind, date, title (≤120), detail (≤1200), visibility, theme, optional money amount and currency, up to 12 places | `client.ts:183-192`, `moment-draft.ts:101-115` | `server/platform.js:274-314`, `:1525-1619` | Verified in code |
| Place on a moment | Words typed on the phone; coordinates only when re-sent (1.1) | `moment-draft.ts:63`, `:112`, `:118-123` | `server/platform.js:292-301` | Verified in code |
| Photo | **Not sent by the phone** (1.2) | — | `server/platform.js:1621-1654` | Verified in code |
| Return-to conversation | Title, detail, status | `client.ts:254-263`, `apps/mobile/app/concern.tsx:34` | `server/platform.js:1673-1712` | Verified in code |
| Proposal to add someone | **Another person's email address**, an optional note about who they are (≤300) | `client.ts:221-223`, `apps/mobile/app/journey-settings.tsx:100`, `:151` | `server/platform.js:1262-1328`; emails go to each journeyer (`:1256-1260`) | Verified in code |
| Agreeing, declining, removing, transferring, resting order, asking for more time | Decisions about a journey | `client.ts:224-241` | `server/platform.js:1329-1475`, `:841-930` | Verified in code |
| Journey event history | A record of the above, kept by the server; see 1.3 for what it copies | — | `server/platform.js:975-991`, `:268-272` | Verified in code |
| Expenses | **Not sent by the phone**; the phone reads them in the snapshot | — | `server/platform.js:1476-1524`, `:1754` | Verified in code |

### 2.3 On the phone vs. synced

| Held on the phone | Where | Leaves the phone? | Mark |
|---|---|---|---|
| Sign-in tokens (access and refresh) | Keychain / Keystore-backed storage, `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (`apps/mobile/src/auth/token-storage.ts:9-10`) | Sent to our API only, as the bearer token (`client.ts:80`). Kept out of iOS backups by the accessibility class, and out of Android Auto Backup and device transfer (`apps/mobile/plugins/with-tokens-out-of-backup.js:5-42`) | Verified in code |
| Chosen theme, whether the ledger was begun | SQLite key-value store in the app sandbox (`apps/mobile/src/storage/phone-storage.ts:11-17`, `use-stored-preferences.ts:12-13`) | Included in normal Android Auto Backup and iOS backups (only tokens are excluded) | Verified in code |
| A synthetic sample ledger | Written once when the ledger is begun (`apps/mobile/src/storage/ledger-store.ts:54-59`, `src/model.js:49`) | As above. It holds no personal data | Verified in code |
| A moment held while the service can't be reached (#352): everything the form sends (kind, date, title, words, places as typed, visibility, theme, money context), the journey's id and name, when it was held, a random key chosen on the phone, and the service's words if it refused it | Same SQLite key-value store, one list per account id (`apps/mobile/src/journey/waiting-moments.ts`, `apps/mobile/src/storage/phone-storage.ts`) | Sent to our API, with its key, once the connection returns or the app opens; removed from the phone as soon as the API has it. Until then, included in normal Android Auto Backup and iOS backups like the rows above. Removed earlier if the person discards it after a refusal, signs out on purpose (asked first), or deletes the account. Kept through a sign-in that ends by itself, for the same account | Verified in code |
| The id of the account this phone is signed in as | Same store (`SIGNED_IN_ACCOUNT_KEY`, `waiting-moments.ts`) | Never sent. Lets an app opened offline count only that account's waiting moments; removed on sign-out | Verified in code |
| The person's account and journeys | Held in memory while the app runs; the phone keeps no copy of a journey between launches (no call to the local store outside `_layout.tsx:74`) | Fetched from the API each time | Verified in code |

**What that means for the person:** on the phone, everything they write lives on our server, not
the phone, except a moment held while the service can't be reached, which waits on the phone until
it is sent (#352). Losing the phone loses only the sign-in (which can be revoked by changing the
password, `server/platform.js:821-840`), the theme, and any moment still waiting to be sent.

### 2.4 Processors: who receives data and why

| Processor | What it gets | Why | Mark |
|---|---|---|---|
| Amazon Web Services | The API host and its PostgreSQL database: everything in 2.1–2.2 | Hosting | Not verified in code (`PRIVACY.md:60`; the host is configured outside this repository) |
| Google Cloud | Encrypted database backups; the key is held elsewhere | Disaster recovery | Not verified in code (`PRIVACY.md:61`, `docs/OPERATIONS.md:70`, `:133-140`) |
| Cloudflare | Domain names, and serves the web app; sees request details for those hosts | DNS, web app hosting | Partly: the web app deploys through Wrangler (`wrangler.jsonc`); whether `api.together-ledger.com` is proxied through Cloudflare is not verified |
| Email sender (Resend) | Destination address, message content (verification, recovery, invitation and proposal emails) | Sending account and journey emails | The code sends through any SMTP server (`server/mailer.js:41-43`, `server/config.js:23`); that it is Resend is **not verified** in code (`PRIVACY.md:46`) |
| Stripe | Email, internal account/journey/moment references (`server/billing.js:185-186`, `:223-240`, `:272`, `:288`) | Web payments | Verified in code. **The phone never reaches Stripe** (`tests/mobile-no-stripe.test.js`) |
| Apple | For a purchase on iPhone: the purchase, with our journey token. For deletion of an Apple account: its refresh token, to revoke it (`server/apple.js:21`, `:71`). For sign-in: nothing from the phone; on the web, once configured, the person's browser signs in with Apple directly (1.5). The server fetches Apple's public keys (`server/identity.js:20`, `:57`) | Store purchases, Sign in with Apple | Verified in code. The phone's purchase screen is #340: StoreKit 2 on the phone, our server verifies the transaction without calling Apple |
| Google | For a purchase on Android: our server asks the Play Developer API about it (`server/store-google.js:33-35`, `:94`, `:115`). For sign-in: nothing from the phone; on the web, once configured, the person's browser signs in with Google directly (1.5). The server fetches Google's public keys (`server/identity.js:16`, `:57`) | Store purchases, Google sign-in | Verified in code. The phone's purchase screen is #340 |
| Google, through Play Billing on the phone | Whatever the Play Billing library itself reports to Google. It depends on Google's datatransport libraries (`transport-runtime`, `transport-backend-cct`), which exist to upload Google's own diagnostics. Our code sends nothing through them | Google's purchase flow | **Not verified**: what Play Billing uploads was not captured (TL-C-03, #261). **Decision (owner, Oct 8, 2026)**: it stays *not verified*; Google Play's own guidance is checked before the Data safety form is filled in, and that decides whether it counts as our collection or Google's |
| Expo (EAS) | Builds and submits the phone app. The app itself makes no call to Expo: there is no `expo-updates`, `expo-insights` or notifications dependency (`apps/mobile/package.json:13-30`) | Building | Not verified by captured traffic (TL-C-03, #261) |

### 2.5 Every client-side dependency that makes a network request

**The phone makes requests to one place: our API.** The origin is set per build, never hardcoded
(`apps/mobile/src/config/api.ts:14-29`); preview and production builds use
`https://api.together-ledger.com` (`apps/mobile/eas.json:16`, `:25`). Every request goes through
one function (`apps/mobile/src/api/client.ts:71-89`) or the photo loader with the same origin
(`client.ts:197-212`), and `fetch` is passed in once (`apps/mobile/src/auth/session.tsx:20`).
**Verified in code.** Not yet verified by captured traffic (#261).

**The web app** loads no script, font or stylesheet from another origin (`index.html`) and calls
only our API (`src/api.js:50`, `:117`, `:133`). **Verified in code.**

The tables below name every dependency in both manifests. `tests/store-readiness.test.js` reads
them: a dependency added to either `package.json` without a row here fails the test, and so does a
row for one that is gone.

#### `apps/mobile/package.json` (ships in the phone app)

| Package | Makes a network request? | Notes |
|---|---|---|
| `@expo-google-fonts/gelasio` | No | Font files bundled into the app, imported per weight (`apps/mobile/src/theme/fonts.ts:1-5`) |
| `@expo/metro-runtime` | Development only | Talks to the Metro dev server in development builds |
| `@react-native-community/datetimepicker` | No | The system date picker |
| `@react-native-community/netinfo` | No | Says whether the phone is connected, for the offline notice (#300). Its own check that the internet can be reached would ask `clients3.google.com` on iOS; it is switched off (`apps/mobile/src/shell/use-connection.ts`), so the library makes no request. On Android it declares `ACCESS_NETWORK_STATE`, already granted (2.4), and `ACCESS_WIFI_STATE`, which is blocked (`apps/mobile/app.json`): only connected or not is read, never the Wi-Fi network's name |
| `expo` | No (not verified by traffic) | Core runtime. No update, analytics or notification module is installed |
| `expo-application` | No | Reads the installed app's version and build number, shown at the foot of Settings and sent in the `x-together-build` header to our API only (#359, `apps/mobile/src/config/build.ts`) |
| `expo-constants` | No | Reads build constants |
| `expo-crypto` | No | Only `randomUUID()`, for the key each moment held on the phone carries so a resend is never a second moment (#352, `apps/mobile/src/journey/use-waiting-moments.ts`) |
| `expo-dev-client` | Development only (not verified) | Connects to a dev server only in a development build (`eas.json:7-11`) |
| `expo-font` | No | Loads the bundled fonts above; never given a URL |
| `expo-linking` | No | Opens the app from its own links (`scheme`, `app.json:6`) |
| `expo-router` | No | Navigation |
| `expo-secure-store` | No | Keychain/Keystore for the tokens (2.3) |
| `expo-sqlite` | No | Local key-value store (2.3) |
| `expo-iap` | Yes, to the store | StoreKit 2 on iOS, Play Billing on Android (#340). Talks only to the App Store or Google Play through the platform's own store services, never to a server of ours or the library author's. Our code imports it in one file (`apps/mobile/src/billing/store-kit.ts:26`). Its Android library depends on Play Billing 9.1.0, which brings Google's datatransport (2.4) and `play-services-location` 19.0.0; the built APK asks for no location permission (1.6) |
| `expo-status-bar` | No | |
| `react` | No | |
| `react-native` | Yes, as the platform | Provides `fetch`, used only by our API client (above) |
| `react-native-safe-area-context` | No | |
| `react-native-screens` | No | |
| `@types/react` | No | Development only, not shipped |
| `eslint` | No | Development only, not shipped |
| `eslint-config-expo` | No | Development only, not shipped |
| `typescript` | No | Development only, not shipped |

#### `package.json` (the server, the web build, and tests; nothing here ships in the phone app)

| Package | Makes a network request? | Notes |
|---|---|---|
| `@fastify/cookie` | No | Web session cookie |
| `@fastify/helmet` | No | Security headers (`server/app.js:21`) |
| `@fastify/rate-limit` | No | In-process rate limits (`server/app.js:22`) |
| `@fastify/static` | No | Serves files |
| `argon2` | No | Password hashing (`server/security.js:17-27`) |
| `fastify` | No (it is the server) | |
| `fastify-raw-body` | No | Stripe webhook signature check |
| `nodemailer` | Yes, from the server | SMTP to the email sender (2.4) |
| `pg` | Yes, from the server | Our own database |
| `stripe` | Yes, from the server | Stripe's API (2.4) |
| `zod` | No | Config validation |
| `@axe-core/playwright` | No | Tests only |
| `@playwright/test` | No | Tests only |
| `pg-mem` | No | Tests only |
| `smtp-server` | No | Tests only: a local SMTP server |
| `wrangler` | Yes, at deploy time | Deploys the web app to Cloudflare; never at run time |

The server also calls Apple and Google directly with the platform's own `fetch`, not through a
dependency (2.4).

### 2.6 Permissions, per platform

| Platform | Permission | Feature that needs it | Mark |
|---|---|---|---|
| Android | `INTERNET` | Talking to our API | Verified in code (`apps/mobile/app.json:27-31`) |
| Android | `com.android.vending.BILLING` | Buying through Google Play (#340). Declared by the Play Billing library; no prompt | Verified in code (`app.json:27-31`) and in the built APK (1.6) |
| Android | `ACCESS_NETWORK_STATE` | Nothing of ours. Declared by Google's datatransport, which Play Billing depends on: it schedules uploads that wait for a network, which Android 9+ refuses without this. Says only whether the phone is online and on what kind of network; no prompt | Verified in code (`app.json:27-31`) and in the built APK (1.6). **Decision (owner, Oct 8, 2026)**: granted, not blocked. Google's billing code needs it, and it shows no prompt |
| Android | Storage, overlay, vibrate, biometric | Nothing: blocked from the merged manifest | Verified in code (`app.json:32-39`, `tests/mobile-permissions.test.js`) |
| iOS | None. `Info.plist` carries no usage description, so the app cannot ask for location, camera, photos, contacts or anything else | — | Verified in code (`apps/mobile/app.json:14-16`) |
| Both | Notifications | Not used; no notifications dependency | Verified in code (`apps/mobile/package.json:13-30`) |

### 2.7 Retention

| What | How long | Mark |
|---|---|---|
| Account and journeys | As long as the account exists | Verified in code (no expiry job touches them) |
| Phone access token / refresh token | 30 minutes / 30 days by default, rotated on use | Verified in code (`server/config.js:19-20`, `server/platform.js:432-448`) |
| Web session | 7 days by default | Verified in code (`server/config.js:17`) |
| Email links (verify, recover) | 30 minutes by default | Verified in code (`server/config.js:18`, `TOKEN_MINUTES`) |
| Invitation link | 14 days by default; one that runs out can be sent again while the proposal's 30 days last (#347) | Verified in code (`server/config.js`, `INVITATION_DAYS`) |
| Invite proposal | Lapses after 30 days if not agreed | Verified in code (`server/platform.js:56`) |
| Removed photo | The most recently removed one per moment, until another is removed or the moment is deleted | Verified in code (`server/platform.js:1668-1669`) |
| A moment's hold key: the phone's random key, the moment it made, and a keyed hash of what it said (#352) | As long as the journey and the person in it; the moment link is emptied when the moment is deleted | Verified in code (`server/migrations/033_let-a-moment-held-offline-arrive-once.sql`, `server/platform.js`, `holdMoment`) |
| A store notification's log row (#273) | As long as the purchase record it explains (`ON DELETE CASCADE`); one about no purchase we hold, 30 days | Verified in code (`server/migrations/034_hear-refunds-and-renewals-from-the-stores.sql`, `server/store-purchases.js`, `noteNotification`) |
| A moment waiting on the phone | Until the API has it, or the person discards it after a refusal, signs out on purpose, or deletes the account (2.3) | Verified in code (`apps/mobile/src/journey/waiting-moments.ts`) |
| Server request logs (with network address, and the phone app's build, such as `and/0.1.0+2/977f365`, #359) | Rotated: 3 files of 10 MB each, oldest overwritten | Verified in code (`compose.production.yaml:36-43`, `server/log-options.js`) |
| Local encrypted backups | Deleted after 29 full days (`-mtime +29`) | Verified in code (`scripts/backup-postgres.sh:78-80`) |
| Offsite backups (Google Cloud) | 30-day lifecycle rule, up to a day more for deletion to run (TL-C-04) | Decision; bucket setting not verified here (`docs/OPERATIONS.md:133-140`) |
| Store purchase records | Kept after the journey is deleted, for refunds and reconciliation | Verified in code (`server/platform.js:1873-1876`) |

### 2.8 Deletion

In the phone app: **Settings → Delete account**, with the password and the word DELETE,
then a confirmation (`apps/mobile/app/settings.tsx:38`, `apps/mobile/app/delete-account.tsx:21`, `:48-50`; `client.ts:264-267`). On
the web: Settings (`index.html:334`). Both call `DELETE /api/v1/account` (`server/app.js:302`).
**Verified in code.**

| Removed | Mark |
|---|---|
| Sessions, phone tokens, email-link tokens (`server/platform.js:1894-1896`) | Verified in code |
| Journeys only the person was in, with everything in them and their history (`:1871-1877`) | Verified in code |
| Their private and share-later moments and private history in shared journeys (`:1879-1880`) | Verified in code |
| The keys of moments they held from a phone (#352), in every journey (`server/platform.js`, `eraseAccount`) | Verified in code |
| Moments still waiting on the phone they delete from, after the deletion is confirmed (`apps/mobile/app/delete-account.tsx`) | Verified in code |
| Google/Apple identities; Apple's grant revoked with Apple (`:1897-1914`, `:1928-1931`) | Verified in code |
| Invitations they sent; pending invitations to them are revoked (`:1915-1916`) | Verified in code |
| Their email, username and name on the account row, replaced; password hash removed (`:1917-1920`) | Verified in code |

| Survives | For how long | Mark |
|---|---|---|
| Moments they had shared, with their places and photos, in journeys others are still in | As long as that journey | Verified in code (`server/platform.js:1878-1892`) |
| Copies of shared moments' titles and places in the journey history (1.3) | As long as that journey | Verified in code |
| Their real email in accepted invitations and in proposals to add them (1.4) | As long as that journey | Verified in code |
| Expenses they paid, with the payer shown as Deleted account | As long as that journey | Verified in code (`server/platform.js:1881-1889`) |
| Store purchase records | Not limited in code | Verified in code (`server/platform.js:1873-1876`) |
| A log line with the account id (never the email), to re-apply the deletion after a restore | Until the logs rotate | Verified in code (`server/platform.js:1923-1926`) |
| Everything, in backups | Up to 30 days (plus up to a day) | See 2.7 |

A journey owner with others still in it must hand the journey over first
(`server/platform.js:1861-1867`). **Verified in code.**

### 2.9 Export

- **Verified in code.** The web's "Export all journeys" writes the browser's own ledger to a file
  (`src/app.js:1870`, `src/store.js:176-184`). Account ids in it are replaced with per-export
  aliases, marked `identityProtection: 'account-aliases-v1'` (`src/store.js:136-174`, `:181`), so
  a shared export does not carry another journeyer's account id.
- **Verified in code.** There is no server endpoint that exports an account's data (the routes in
  `server/app.js:132-396`), and the phone has no export. A request for a copy goes to
  legal@together-ledger.com (below).

### 2.10 Contact routes (TL-C-05)

- **Verified in code.** In the phone: Settings → Privacy and help names ledger-support@ for help
  and legal@ for privacy (`apps/mobile/app/settings.tsx:42-44`), and the privacy policy screen
  repeats legal@ (`apps/mobile/app/privacy.tsx:44`). The policy itself is built into the app from
  `PRIVACY.md` (`apps/mobile/src/policies/privacy.json`, #328).
- **Not verified.** That both inboxes are monitored. TL-C-05 (#263) is still open.

### 2.11 Security posture (TL-C-01)

| Claim | Mark |
|---|---|
| Passwords hashed with Argon2id, 19 MiB memory, 2 passes (`server/security.js:17-20`); unknown accounts take the same work (`server/platform.js:514`) | Verified in code |
| Tokens and links stored only as SHA-256 hashes (`server/platform.js:471-472`, `:487`) | Verified in code |
| Web: CSRF value bound to the session (`server/security.js:59-60`); phone: bearer tokens, no cookie (`client.ts:78-80`) | Verified in code |
| Rate limits: 300/minute overall, tighter per sign-in, registration and recovery route (`server/app.js:22`, `:143-292`) | Verified in code |
| Logs never carry passwords, tokens, cookies or authorization headers (`server/log-options.js:19`) | Verified in code |
| TLS for the phone's traffic: production and preview builds use an `https://` origin (`apps/mobile/eas.json:16`, `:25`) | Verified in code |
| TLS on the API host (Caddy, `Caddyfile`) | Not verified (deployed host) |

---

## Part 3. The store answers, for the phone app

These are written to be pasted. They describe the build that `apps/mobile` makes at `1cc17a6`.
Each answer that rests on a judgement rather than a plain fact is marked **Decision**, with the
date the owner confirmed it. All were confirmed on Oct 8, 2026.

### 3.1 Google Play: Data safety

**Data collection and security**

| Question | Answer | Why |
|---|---|---|
| Does your app collect or share any of the required user data types? | **Yes** | Email, name, user id, user content, precise location (1.1), purchase history (#340) |
| Is all of the user data collected by your app encrypted in transit? | **Yes** | 2.11 |
| Which ways can users create an account? | **Username and password** (and "OAuth" only once Google or Apple sign-in reaches the phone, 1.5) | `client.ts:136-142` |
| Do you provide a way for users to request that their data is deleted? | **Yes** | 2.8 |
| Delete account URL | **Decision (owner, Oct 8, 2026), for now:** `https://together-ledger.com/privacy`, whose Deletion section says how (Settings → Delete account, in the app or at `https://app.together-ledger.com/`). Play wants a page that explains the steps without the app; that section does once `PRIVACY.md` carries 1.3 and 1.4. The page has no per-section anchors (`scripts/render-privacy-page.mjs`), so the link lands at the top. A dedicated deletion page would be clearer; not built | 2.8 |
| Can users request that some data be deleted without deleting their account? | **Yes**: moments, places, conversations and display name can be edited or deleted in the app | 2.2 |
| Committed to Play Families Policy? / Independent security review? | **No** / **No** | Not a children's app (`PRIVACY.md:13`); no review has been done |

**Data types.** "Shared" means transferred to a third party. Nothing below is shared: what goes to
other journeyers goes at the person's own direction, and what goes to the email sender and the
host is a service provider acting for us, both of which Play exempts. **Decision (owner, Oct 8, 2026)**, on Play's
own definitions. No data is processed ephemerally; all of it is stored.

| Category → Type | Collected | Shared | Required or optional | Purposes | Notes |
|---|---|---|---|---|---|
| Location → **Approximate location** | No | No | — | — | Nothing coarser than 1.1 is collected |
| Location → **Precise location** | **Yes** | No | **Optional** (only if a moment has a device location added on the web, then edited or shared on the phone) | **App functionality** | 1.1. Becomes "No" only if the phone stops re-sending coordinates and labels that carry them. **Decision (owner, Oct 8, 2026)** |
| Personal info → **Name** | **Yes** | No | **Optional** (the display name starts as the username) | **App functionality, Account management** | 2.1 |
| Personal info → **Email address** | **Yes** | No | **Required** | **App functionality, Account management** | The person's own, and another person's email when proposing to add them (2.2) |
| Personal info → **User IDs** | **Yes** | No | **Required** | **Account management** | The username |
| Personal info → Address, Phone number, Race and ethnicity, Political or religious beliefs, Sexual orientation, Other info | No | No | — | — | Not asked for (2.1). **Decision (owner, Oct 8, 2026)** on sensitive types: the app never asks about these, though a person may write anything in a moment; that free text is declared below |
| Financial info → User payment info, Credit score | No | No | — | — | The phone has no payment screen; Stripe is never reached from the phone |
| Financial info → **Purchase history** | **Yes** | No | **Optional** | **App functionality** | Store purchases on the phone (#340): which product, for which journey or moment, kept against the account (2.1). **Decision (owner, Oct 8, 2026)**: Yes on both stores. Card details never reach us; Apple and Google hold those |
| Financial info → **Other financial info** | **Yes** | No | **Optional** | **App functionality** | The optional money amount and currency on a moment (`moment-draft.ts:110-111`). **Decision (owner, Oct 8, 2026)**: it is context the person types, not an account balance, but declaring it is the safer reading |
| Health and fitness | No | No | — | — | |
| Messages → Emails, SMS or MMS | No | No | — | — | The app sends no message content written by the person; the proposal note is declared below |
| Messages → **Other in-app messages** | No | No | — | — | **Decision (owner, Oct 8, 2026)**: a return-to conversation is a titled record with a status, kept in the journey alongside moments, not a chat thread. It is declared below as user-generated content |
| Photos and videos → **Photos** | No | No | — | — | Becomes **Yes, Optional, App functionality** when the phone can attach photos (#187), 1.2 |
| Photos and videos → Videos | No | No | — | — | |
| Audio files | No | No | — | — | |
| Files and docs | No | No | — | — | |
| Calendar | No | No | — | — | Dates are typed into the app, not read from the calendar |
| Contacts | No | No | — | — | A proposed email is typed, never read from contacts |
| App activity → App interactions | No | No | — | — | **Decision (owner, Oct 8, 2026)**: the journey history records what a person did to shared records so others can see it; it is the content itself, not usage measurement |
| App activity → In-app search history, Installed apps | No | No | — | — | |
| App activity → **Other user-generated content** | **Yes** | No | **Optional** | **App functionality** | Journey names and places, moments (title, detail, places in words), return-to conversations (title, detail, status; `client.ts:254-263`), notes on proposals (2.2). **Decision (owner, Oct 8, 2026)** for the conversations |
| App activity → Other actions | No | No | — | — | |
| Web browsing | No | No | — | — | |
| App info and performance → Crash logs, Diagnostics, Other app performance data | No | No | — | — | No crash or analytics SDK (2.5). **Decision (owner, Oct 8, 2026)**: the server's request logs (address, time, route, status) are operational logs kept 2.7's limit, not app diagnostics. Since #359 they also keep which build of the phone app asked (platform, version, build number, commit): a fact about the binary, the same for everyone on that build, not about the person |
| Device or other IDs | No | No | — | — | No advertising id or device id is read |

**Deletion, as Play asks it in the policy text:** everything above is deleted with the account
except what 2.8's "Survives" table lists. Those exceptions must be in `PRIVACY.md` before
submission (Part 4).

### 3.2 Apple: App Privacy ("nutrition labels")

**Do you or your third-party partners collect data from this app?** **Yes.**

**Tracking:** **No** for every type. The app links no data with third-party data for advertising
and shares nothing with data brokers (`PRIVACY.md:42`; no such dependency, 2.5).

For every type below: **Linked to the user: Yes** (it is stored against the account).
**Used for tracking: No.** Apple's labels have no "optional" or "deletion" field; those belong in
the privacy policy (Part 4).

| Category → Type | Collected | Purposes | Notes |
|---|---|---|---|
| Contact Info → **Name** | **Yes** | **App Functionality** | The display name |
| Contact Info → **Email Address** | **Yes** | **App Functionality** | The person's, and a proposed person's |
| Contact Info → Phone Number, Physical Address, Other User Contact Info | No | — | |
| Health and Fitness | No | — | |
| Financial Info → Payment Info, Credit Info | No | — | |
| Financial Info → **Other Financial Info** | **Yes** | **App Functionality** | The optional money context on a moment. **Decision**, as in 3.1 |
| Location → **Precise Location** | **Yes** | **App Functionality** | 1.1: four-decimal coordinates are "three or more decimal places" in Apple's definition. **Decision**, as in 3.1 |
| Location → Coarse Location | No | — | |
| Sensitive Info | No | — | **Decision (owner, Oct 8, 2026)**, as in 3.1 |
| Contacts | No | — | |
| User Content → Emails or Text Messages | No | — | **Decision (owner, Oct 8, 2026)**: return-to conversations are records in the journey, declared under Other User Content, as on Play |
| User Content → **Photos or Videos** | No | — | Becomes **Yes, App Functionality** with #187 |
| User Content → Audio Data, Gameplay Content, Customer Support | No | — | Support is by email, outside the app |
| User Content → **Other User Content** | **Yes** | **App Functionality** | As "Other user-generated content" in 3.1, return-to conversations included |
| Browsing History, Search History | No | — | |
| Identifiers → **User ID** | **Yes** | **App Functionality** | The username and the account id behind the tokens |
| Identifiers → Device ID | No | — | |
| Purchases → **Purchase History** | **Yes** | **App Functionality** | Store purchases on the phone (#340), as in 3.1. **Decision (owner, Oct 8, 2026)** |
| Usage Data → Product Interaction, Advertising Data, Other Usage Data | No | — | **Decision**, as for App interactions in 3.1 |
| Diagnostics → Crash Data, Performance Data, Other Diagnostic Data | No | — | **Decision**, as in 3.1 |
| Surroundings, Body | No | — | |
| Other Data | No | — | |

**The app's privacy manifest says the same.** `expo.ios.privacyManifests` in
`apps/mobile/app.json` lists the seven types answered **Yes** above: linked, not used for
tracking, collected for App Functionality. It declares no tracking and no tracking domains.
`tests/mobile-ios-release.test.js` reads this table, so a change here fails until the manifest
changes with it. The required-reason APIs it declares, and why, are in `docs/IOS_RELEASE.md`
(added Oct 9, 2026, after the commit named at the top of this file). **Verified in code.**

**Privacy policy URL:** `https://app.together-ledger.com/privacy`, the same on both stores
(**Decision (owner, Oct 8, 2026)**), built from `PRIVACY.md` by `scripts/build-public-site.mjs:33-34`.
**Verified in code.** Not `https://together-ledger.com/privacy`, which is the company site's own
privacy page, not this product's.

**Account deletion (guideline 5.1.1(v)):** in the app, Settings → Delete account (2.8).

---

## Part 4. What `PRIVACY.md` has to say before submission

`PRIVACY.md` is rewritten from this file in #207, not here. Coordinate there; don't fix the same
sentence twice, differently. What it currently gets wrong or leaves out, against Part 2:

1. **History copies of shared moments** (1.3): `PRIVACY.md:40` and `:80` say the shared stream
   doesn't copy titles and that nothing personal stays; titles and places (with coordinates) do.
2. **Email after deletion** (1.4): `PRIVACY.md:80` says "without your email"; accepted invitations
   and proposals keep it.
3. **The phone re-sending coordinates** (1.1): `PRIVACY.md:26` says coordinates are taken only
   when "Use my device location" is pressed. True of the reading; the phone then sends them again.
4. **Photo metadata** (1.2): the policy can say location and camera details are removed, once the
   API is redeployed and checked, and must say the file name is kept.
5. **Apple and Google** (1.5): name them as recipients the day either sign-in reaches a client.
6. **Backups:** `PRIVACY.md:72` says each backup is deleted 30 days after it is made; the local
   copies go after 29 full days (2.7), which is within the promise.
7. **Export:** `PRIVACY.md:86` describes the web's export; the phone has none (2.9).
8. **Store purchases** (#340): the policy has to say the phone sells through the App Store and
   Google Play, what we keep about a purchase (2.1), and that deleting the account does not cancel a
   store subscription, which is cancelled with Apple or Google (the phone already says so before
   deleting, `apps/mobile/app/delete-account.tsx:24`).
9. **A moment held offline** (#352, 2.3): the phone keeps it, for that account only, until our
   service has it. `PRIVACY.md` says nothing about it yet; the sentence proposed for it is in the
   pull request that built it, for the owner to approve.
10. **The phone's build in the request log** (#359, 2.7): `PRIVACY.md:61` lists what the logs
   record; it does not yet name the build. Proposed in the same pull request.

The sibling products need the same file: I'm Home and Green Light (#264). File those issues once
this one has been through a submission.
