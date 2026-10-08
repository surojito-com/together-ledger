# App Store listing

Draft of the App Store Connect listing for Together Ledger
(`com.togetherledger.ledger`, iPhone only in v1), and the notes for App Review
(#357). It sits beside the Play listing in `store/google-play/` and follows the
same rules: the wording follows `CLAUDE.md` ("Language", "Design system") and
`docs/PRODUCT_PRINCIPLES.md`, and every claim points at the code that makes it
true.

Unlike the Play listing, this one describes **what the iPhone app does**, not
the whole product. App Store Review Guideline 2.3 asks that the metadata
reflect the app, and the phone doesn't yet attach photos, export, or run a
check-in, which the web does. The web is mentioned only as somewhere the same
account works.

| App Store Connect field | File | Limit | Now |
|---|---|---|---|
| Name | `name.txt` | 2 to 30 characters | 15 |
| Subtitle | `subtitle.txt` | 30 characters | 30 |
| Promotional text | `promotional-text.txt` | 170 characters | 118 |
| Keywords | `keywords.txt` | 100 bytes | 96 |
| Description | `description.txt` | 4,000 characters | 2,451 |
| App Review notes | `review-notes.txt` | 4,000 bytes | 2,530 |
| App Review notes, with the extra place | `review-notes.txt` + `review-notes-extra-place.txt` | 4,000 bytes | 2,798 |

The limits were checked on Oct 8, 2026, against Apple's own pages:

- Name and subtitle: [App information](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information)
  ("at least two characters and no more than 30 characters"; subtitle "can't be longer than 30 characters").
- Promotional text, description, keywords and the review notes:
  [Platform version information](https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information)
  (170 characters; 4,000 characters; "up to 100 bytes"; "The Notes field can contain up to 4000 bytes").

Keywords and the notes count **bytes**, not characters, so a curly apostrophe
counts three. The check counts them the way Apple does.

Before pasting, run:

```
node store/app-store/check-listing.mjs
```

It runs in `npm run check` too. It checks every limit above; emoji; the
capacity words `CLAUDE.md` rules out (seats, licences, slots, "removed");
emergency, SOS and panic; any email address or password; any photo-privacy
claim (#258); other platforms' names and ranking claims in the listing; what
the iPhone can't do yet (photos, export, check-in, notifications, offline,
encryption, sync); keywords with a wasted space, a repeat, or a word the name
already gives; that the description still says a journey of two is free, the
agreement rule, 18 and over, how a subscription renews, and the terms and
privacy links; and that the notes still say where to sign in, where the
purchase screen is, and the sandbox rule. It also holds the notes to the code:
the partner's username is the one `server/review-journey.js` makes, the
refusal quoted is the server's own sentence, the Settings entries named are
still there, and the home-screen name in `apps/mobile/app.json` is still
"Together Ledger".

## The name

The App Store name is **"Together-Ledger"** for now, because "Together Ledger"
is taken on the App Store. **The owner hasn't confirmed it as final.** The name
under the icon on the home screen stays **"Together Ledger"**: that comes from
`expo.name` in `apps/mobile/app.json`, not from App Store Connect, and the check
fails if it changes.

The keywords leave out "together" and "ledger", because Apple already searches
the name.

## Store settings to enter alongside them

- **Privacy policy URL:** https://app.together-ledger.com/privacy. The Play
  listing uses this one too. `docs/STORE_READINESS.md` (3.2) gives
  `https://together-ledger.com/privacy`; both serve `PRIVACY.md`. Pick one and
  use it on both stores.
- **Terms of use:** the description links https://app.together-ledger.com/terms
  (`TERMS.md`, `tests/terms-page.test.js`). Guideline 3.1.2 asks for a terms
  link in the metadata of an app with auto-renewing subscriptions. Whether to
  also set it as a custom licence agreement in App Store Connect, rather than
  keep Apple's standard one, is the owner's call.
- **Support URL and email:** ledger-support@together-ledger.com is the address
  `PRIVACY.md` and `TERMS.md` publish. A support URL isn't chosen.
- **Age rating:** Together Ledger is 18 and over (`TERMS.md`). The
  questionnaire answers aren't written yet.
- **Category:** not decided. Lifestyle is the suggestion, as on Play.

## The App Review notes

`review-notes.txt` goes into App Review Information → Notes. The reviewer's
**email and password never go in this repository**. They go only into App
Review Information → Sign-in required, from `/etc/together-ledger/app-review.env`
on the host (`docs/APP_REVIEW.md`). The notes point there ("this submission's
Sign-in Information") and name the partner only by the sample's fixed private
username, `app-review-alex`, which signs in in the same "Email or username"
field (`apps/mobile/app/account.tsx`).

**Paste `review-notes-extra-place.txt` after the notes only when production
counts paid places**: `MOMENT_LOCATION_BILLING_ENABLED` on, so the journey
snapshot's `extras.place` is true (`docs/STORE_PURCHASES.md`). Otherwise a
moment offers no extra place, and the paragraph would send the reviewer looking
for something that isn't there.

Before each submission, all of these have to be true, or the notes are wrong:

1. `server/seed-review-journey.js` has been run, as `docs/APP_REVIEW.md` says.
2. The `STORE_SANDBOX_ACCOUNT_IDS=…` line it printed is set in
   `/etc/together-ledger/production.env`, and the app restarted. Only Sam's new
   account id is added; Alex isn't listed, which is why the notes ask for test
   purchases as Sam.
3. Production runs with `JOURNEY_CAPACITY_MODE=billing` and the App Store
   configured. Without it, Journey sharing shows no Room for more people at all
   (`apps/mobile/app/journey-settings.tsx`, `snapshot.capacity?.mode === 'billing'`).
4. The products exist in App Store Connect (#271), so the offers show a price
   rather than "The App Store isn't offering this yet."
5. The API release carrying the purchase routes is live (`docs/SERVER_DEPLOY.md`).

`docs/APP_REVIEW.md` still says, under "Paying, for a reviewer", that the phone
has no store purchase and that its notes are "to be written once the products
exist". The purchase screens landed in `977f365`, so that section is out of
date. This PR leaves it alone; these notes are the written version.

## What every claim rests on

### The listing

| Claim | Where it's true |
|---|---|
| A promise, a memory, a heart-to-heart, a boundary, a repair request, or your own kind | `MOMENT_TYPES` in `src/model.js`; "Name this kind of moment" in `apps/mobile/app/moment.tsx` |
| A date, a place in your own words, an amount of money, detail; edit or delete | `apps/mobile/app/moment.tsx` (When, Enter a place, Amount and Currency, Delete moment); places are typed words only (`apps/mobile/src/journey/moment-draft.ts`) |
| Private / Share later / Shared now, in shape, word and border | `VISIBILITY_CUES` in `apps/mobile/src/journey/journey-view.ts`; the privacy cue language in `CLAUDE.md` |
| Sharing asks first; a shared moment can't be made private again | `SHARE_NOW` confirmation in `apps/mobile/src/journey/moment-actions.ts`; `visibilityLocked` in `moment-draft.ts`; `PRIVACY.md` |
| A conversation to come back to, marked resolved | `apps/mobile/app/concern.tsx`, `CONCERN_STATUSES` (Open, Resolved) in `apps/mobile/src/journey/sharing-view.ts` |
| A history that is only ever added to | `apps/mobile/app/history.tsx` (append-only, #184) |
| A journey of two is free; someone new joins only when everyone agrees | `TERMS.md` ("A journey of two is free, always"; "Someone new is added only when everyone already in the journey agrees"); `proposeInvitation` in `apps/mobile/app/journey-settings.tsx` |
| Up to 51 or 101 people; the first paid journey monthly, others a week or a month | `STORE_PRODUCTS` and `roomOfferFor` in `apps/mobile/src/billing/store-products.ts`; `docs/STORE_PURCHASES.md` |
| Room belongs to the journey, the same on every device | `ROOM_INTRO` in `store-products.ts` |
| If room isn't paid for, people rest, can still read, and no history is lost | `TERMS.md`; `server/migrations/029_rest-read-only-and-let-the-payer-ask-for-time.sql` (resting is always read-only) |
| No advertising, no analytics trackers, nothing sold | `PRIVACY.md` |
| No scores and no feed; money is context | `README.md`, `ROADMAP.md`, `moment.tsx` |
| Delete your account in the app | `apps/mobile/app/delete-account.tsx` |
| Same account on the phone and the web | the same API for both clients (`apps/mobile/src/api/client.ts`, `src/api.js`) |
| Light, Dark, Green, Flexoki; your theme is only your view | `ThemePicker` in `apps/mobile/app/settings.tsx` and the line under it |
| 18 and over; not therapy, financial advice or professional support | `TERMS.md`, `PRIVACY.md` |
| A subscription renews until cancelled at least 24 hours before; deleting the account doesn't cancel it | `subscriptionTerms` and `STORE_SUBSCRIPTION_NOT_CANCELLED` in `store-products.ts`; `TERMS.md` |

### The review notes

| Claim | Where it's true |
|---|---|
| Sam and Alex, a sample journey with content from both; Sam's private moment not visible to Alex | `server/review-journey.js`; `docs/APP_REVIEW.md` |
| First screen → Account → sign in; Settings → Account → Sign out | `apps/mobile/app/index.tsx`, `apps/mobile/app/account.tsx` |
| Settings → Journey sharing, History and conversations, Delete account | `apps/mobile/app/settings.tsx` |
| Room for more people, only for the journey's owner | `RoomForMorePeople` in `apps/mobile/src/components/store-offers.tsx` |
| Subscriptions while the store account holds none; passes once it holds one for another journey | `roomOfferFor` in `store-products.ts` |
| Restore purchases in Settings and under the offers | `apps/mobile/app/settings.tsx`; `RoomForMorePeople` |
| Sandbox purchases honoured only for listed accounts; the refusal's words | `assertEnvironment` and `testPurchaseRefused` in `server/store-purchases.js`; `STORE_SANDBOX_ACCOUNT_IDS` |
| Prices from the App Store; length, renewal and in-app terms and privacy links beside the offer | `Offer` in `store-offers.tsx` (Apple 3.1.2) |
| Delete account says a subscription isn't cancelled | `apps/mobile/app/delete-account.tsx` |
| No location, camera, photos, contacts or notifications permission | `apps/mobile/app.json` (no usage descriptions); `docs/STORE_READINESS.md` |
| An extra place, once a moment holds its free first one | `extrasFor` and `EXTRAS_INTRO` in `store-products.ts`; "The walk along the canal" has a place in `server/review-journey.js` |

## Left out on purpose

- **Photos.** The iPhone can't attach a photo yet (#187), and no photo-privacy
  claim goes anywhere until #258 confirms the server cleans photos on
  production. The check refuses "photo" in the listing.
- **An extra photo**, which the phone doesn't sell until it can add photos.
- **An extra place in the description.** It is sold only while production
  counts paid places; the review notes carry it as a separate paragraph for
  that case. Add a line to the description at the same time, if the owner
  wants one.
- **Export and the check-in**, which only the web has.
- **Notifications** (#265), **offline** (#300), **encryption**, and sync
  (#186), as on Play.
- **A price.** Prices come from the App Store for each storefront.
- **"Emergency".** Not even as a disclaimer: Together Ledger is never
  positioned as one, and nothing here needs the word.

## Proposed, not added

`store/google-play/check-listing.mjs` passes today but isn't in
`npm run check`. Adding it there, next to this one, would stop the Play text
drifting the same way. It's a one-line change to the `check` script and is
left for the owner to decide.

## Open calls for the owner

1. **The App Store name**, "Together-Ledger", before submission.
2. **Every sentence** in these files, quoted in the PR.
3. **Category, age rating answers, support URL**, and which privacy-policy URL
   both stores use.
4. **Terms of use**: link only, or also a custom licence agreement in App
   Store Connect.
5. **Screenshots**, from a build: `store/google-play/SCREENSHOTS.md` is the
   shot list for both stores, and they go in `store/app-store/screenshots/`.
