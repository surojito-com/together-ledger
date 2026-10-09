# Together Ledger

**A private shared journey workspace for two people to hold what happened, return to what matters, and make room for repair.**

Together Ledger is a local-first relationship-resilience tool. It offers a gentle timeline for promises, acknowledgments, triggers, missed chances, heart-to-heart talks, memories, feelings, boundaries, repair requests, and the practical things people navigate together.

> A shared journey cannot measure love. No moment, practical detail, or open thread becomes a score of effort, care, or commitment.

## Why this exists

Together Ledger makes a different set of questions possible:

- What happened, in words that feel true?
- What would feel good to acknowledge?
- Is there an open thread worth returning to with care?
- What practical context belongs inside this moment, if any?

This is not couples therapy, financial advice, surveillance software, or a relationship score. It is a neutral surface for a better conversation.

## What works today

- A gentle **Our shared journey** timeline for moments, current check-ins, recent memories, and open threads.
- Moment types for promises, acknowledgments, triggers, missed chances, heart-to-heart talks, memories, feelings, boundaries, repair requests, things learned, calls requested or received, practical matters, and a person-named **Add your own moment** choice.
- Per-moment visibility cues: **private**, **shared now**, or **share later**.
- Optional practical money context inside a moment; no money totals, budgets, balances, cash-flow view, or spending dashboard.
- Multiple browser-local journeys with creation and switching that never mixes records.
- Lossless migration of original trip and expense records into preserved practical-context moments.
- Edit, remove, export, and import local journey records.
- A public welcome that explains the journey and its browser-only boundary before the first moment, plus a bounded one-prompt-at-a-time check-in with no saved written answers.
- Per-journey action milestones that describe shared actions—not relationship quality.
- Honest local settings for themes, full backup/restore, and demo reset.
- A visible Event Manager under every journey for locally attributable moment, thread, milestone, and practical-detail changes, including deletion tombstones.
- Four curated themes carrying the full semantic colour contract, with a global switcher that persists the user’s choice.
- Synthetic demo data featuring Alex and Jordan—no household records.
- An explicit browser-only mode that never uploads existing local journey data.
- Private sync for separate accounts, verified-email invitations, PostgreSQL journeys, recovery, deletion, conflict protection, server-authoritative shared moments, and HMAC-chained events.
- A portable container and active/passive AWS-primary/GCP-standby operations plan.
- A disabled-by-default test-mode paid-journey-capacity candidate using Stripe-hosted Checkout and a tightly restricted Customer Portal, Billing, verified webhooks, and provider-neutral entitlements; it models $1 USD monthly for one person beyond the first two and does not claim live billing.

## Try it locally

Requirements: Node.js 22 or newer.

```bash
git clone https://github.com/together-ledger-digital-llc/together-ledger.git
cd together-ledger
npm run check
npm run dev
```

Open `http://127.0.0.1:4173` for browser-only mode.

No account, cloud database, environment variable, or API key is required for browser-only mode. To exercise private sync, use the container procedure in [docs/OPERATIONS.md](docs/OPERATIONS.md).

The web-billing candidate is documented in [docs/STRIPE.md](docs/STRIPE.md). Never paste Stripe secrets into source, commits, issue text, logs, screenshots, or chat; rotate any key that has been exposed before configuring a local test environment.

## Mobile app

`apps/mobile` is an Expo client for iPhone and Android against the same server. It has product
screens: registration and sign-in, journeys and their moments, History, Settings, in-app purchases
and account deletion (`apps/mobile/app/`). The web client at `src/` is separate; nothing in
`apps/mobile` touches its auth, storage, or styling.

`apps/mobile` is an npm workspace, so install from the repository root, never inside it:

```bash
npm ci                                                  # at the repository root
cp apps/mobile/.env.example apps/mobile/.env.local      # points the app at a locally running API
npm start -w apps/mobile
```

The local API is the server on port 4174 (`server/config.js`), run as the local platform test in
[docs/OPERATIONS.md](docs/OPERATIONS.md) describes. `npm run dev` serves only the static web app,
on 4173, and the phone can't use it (#283). `localhost` reaches your computer from the iOS
Simulator; from an Android emulator or a phone on USB, run `adb reverse tcp:4174 tcp:4174` first.

The app needs a development build, not Expo Go: it carries native code Expo Go doesn't include,
such as `expo-iap` for in-app purchases, and `expo-dev-client` is installed for exactly this
(`apps/mobile/package.json`). Make one with `eas build --profile development` (the `development`
profile in `apps/mobile/eas.json`) and install it; it then loads the app from the dev server that
`npm start -w apps/mobile` runs. `npm run typecheck -w apps/mobile` and `npm run lint -w apps/mobile` are the
checks CI runs on every pull request (`.github/workflows/ci.yml`); they are not part of
`npm run check` at the repo root.

The API origin is never hardcoded — it is read from the `EXPO_PUBLIC_API_ORIGIN` environment
variable at build time, the mobile equivalent of the web client's `together-api-origin` meta tag.
Preview and production builds get `https://api.together-ledger.com` from their profiles in
`apps/mobile/eas.json`; only a development build with nothing set falls back to the local API. See
`apps/mobile/src/config/api.ts`.

The iPhone app asks for no permission: its `Info.plist` carries no usage description, so it can't
ask for camera, photos, location, contacts or notifications (`apps/mobile/app.json`). On Android it
declares `INTERNET`, `com.android.vending.BILLING` for Google Play purchases, and
`ACCESS_NETWORK_STATE`, which Google's own billing libraries need (owner decision, Oct 8, 2026);
none of them shows a prompt, and the storage, overlay, vibration, biometric and Wi-Fi state
permissions libraries would add are blocked (`apps/mobile/app.json`,
`tests/mobile-permissions.test.js`, [docs/STORE_READINESS.md](docs/STORE_READINESS.md) 2.6). There
is no analytics or crash reporting; the only library that makes a request of its own is `expo-iap`,
to the App Store or Google Play (STORE_READINESS 2.5). Sign-in tokens are kept in the platform
keychain through `expo-secure-store`, never in plain on-device storage
(`apps/mobile/src/auth/token-storage.ts`).

## Brand themes

Every current surface—navigation, hero, cards, timeline, dialogs, forms, footer, and mobile action bar—reads from one set of semantic colour roles, so a theme is a set of values rather than a set of exceptions.

| Light themes | Dark themes |
|---|---|
| Light | Dark |
| Flexoki | Green |

Four themes, not sixteen. Each one defines all seventeen semantic roles, and `npm run check:themes`
refuses a theme that leaves any role undefined, unreadable, or too close in hue to a role it must
never be mistaken for. A theme retired in an earlier release resolves to the surviving surface
closest to it, so a saved choice is migrated rather than dropped.

The selected theme is saved in the browser and restored before the page paints.

## Privacy model

```text
browser-only                         private sync
────────────                         ────────────
UI → localStorage                    UI → same-origin API
   → explicit JSON export               → PostgreSQL
                                          → append-only event chain
```

The public static deployment remains safe to explore without an account. Its account screen states plainly when the protected service is unavailable; it never sends a name, email, or password to the static origin that serves it. Signing in never uploads existing browser journey data. Private sync is an explicit mode for newly created hosted journeys and is not production-ready until the operational release gate passes. **Browser-only visibility is a local cue, not separate-account privacy.** In private sync, private and share-later moments remain visible only to their creator; shared-now moments are visible to both authorized journeyers. Read [PRIVACY.md](PRIVACY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

The Event Manager remains browser-local in browser-only mode. The private-service candidate creates events inside the authorized PostgreSQL mutation transaction and chains them with HMAC evidence. HMAC chaining is tamper-evident, not magically immutable; deployment secret isolation and backup controls still matter.

## Relationship-resilience principles

1. **Facts before blame.** Hold what happened without assigning moral meaning.
2. **Shared clarity over perfect accounting.** The goal is a usable shared journey.
3. **Prompts, not scores.** Ask questions; never grade the relationship.
4. **Context over comparison.** Practical context can matter without becoming a total, ranking, or debt.
5. **Consent over surveillance.** No hidden tracking, notifications, or behavioral monitoring.
6. **Repair over punishment.** Make it easy to correct, revisit, and discuss.

The deeper rationale is in [docs/PRODUCT_PRINCIPLES.md](docs/PRODUCT_PRINCIPLES.md).

## Project status

Together Ledger is an early public prototype. Browser-only journeys are live. The PR#0003 branch contains a tested private-service candidate, but it is not a production multi-user claim until SMTP, cloud PostgreSQL, cross-cloud backup restoration, independent review, and DNS cutover pass.

The app's public home is `app.together-ledger.com`, served by this repository's Cloudflare Worker. The apex `together-ledger.com` is the company site and is deployed from the separate `together-ledger.com` repository; nothing in this repository serves it. See [docs/DOMAIN_MIGRATION.md](docs/DOMAIN_MIGRATION.md) for the safe cutover sequence and [ROADMAP.md](ROADMAP.md) for the boundary between the current safe starter and possible future collaboration features.

## Contributing

Thoughtful contributions are welcome—especially accessibility fixes, privacy improvements, inclusive language, tests, and research-grounded conversation design.

Please read [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md) before opening a pull request.

## License

[MIT](LICENSE) © 2026 Surojit Ojha and contributors.
