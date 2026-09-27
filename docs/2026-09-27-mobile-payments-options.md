# Paying for another person from a phone — options for the owner

**Status: options only. Nothing here is decided.** Written 27 September 2026 as part of the store
launch handoff. How in-app payments work is the owner's call. This document sets out what the
repository already commits to, what the stores require, and three ways to proceed.

Store policy moves, especially in the United States. Everything below about App Store and Google
Play rules must be checked against the live guideline text in the week of submission, not taken from
this page.

## What is already settled in the repository

- **Stripe is the web rail only.** `docs/STRIPE.md` says that native apps use the store's own
  purchase system, and that Apple and Google transactions are never recreated as Stripe charges.
- **Entitlements are provider-neutral.** `billing_entitlements.source` already allows `'apple'`
  and `'google'` (`server/migrations/008_stripe_web_billing.sql`). A store purchase is meant to
  project into the same journey-scoped capacity record that a Stripe subscription does.
- **In-app purchase is out of scope for the TL-M epic** (#175): "that is the payments epic." There
  is no issue for that epic yet.
- **Web billing is not live.** It is test-mode code with an approved test offer of $1 USD a month
  per additional person, with the first two people included (`docs/STRIPE.md`).
  `docs/PRODUCTION_READINESS.md` still has "Apple App Store and Google Play rules have been
  reviewed" unchecked.

## What the stores require

- **Apple (App Review Guidelines 3.1.1):** digital features unlocked inside the app must be sold
  through In-App Purchase. Paid capacity for another person in a journey is a digital feature.
- **Apple (3.1.3(b), multiplatform services):** an app may honour something bought on the web
  only if the same thing is also available as an In-App Purchase inside the app.
- **Apple, United States storefront:** the guidelines now exempt the US storefront from the ban on
  "buttons, external links, or other calls to action" that point to other ways to buy (checked
  27 September 2026). Whether Apple may charge a commission on linked purchases has been in
  litigation. Check the current rule before relying on it.
- **Google Play (Payments policy):** digital goods are sold through Play Billing. US-only
  alternative-billing and external-link programs followed *Epic v. Google*, launching in December
  2025. They have their own enrolment and fees. Secondary sources report that Google begins
  charging those fees on 1 October 2026; confirm in Play Console Help.
- **Both stores:** subscriptions can be cancelled only where they were bought. The web billing
  page already says so: "Apple App Store and future Google Play purchases remain with those stores."

### The detail that shapes the product: store subscriptions have no quantity

The Stripe design is one subscription per journey, with an integer quantity of additional people
from 1 to 99. StoreKit and Play Billing subscriptions have one price per product and no quantity.
"$1 per additional person" therefore cannot be sold from a phone as it is sold on the web. It has
to become one of these:

- **Fixed capacity tiers.** For example, products for 1, 2, 5, 10 and 25 additional people. This
  means one subscription group on Apple with upgrades and downgrades between tiers, and one
  subscription with several base plans on Play.
- **One product per step,** up to the 99 ceiling. That is technically possible, but painful to
  review, price and localise.

Two more things to confirm in each store's price grid:

- that the per-tier prices land where the web prices do;
- whether the store's commission (15% on subscriptions for small developers in both stores) is
  absorbed or passed on.

## Options

### A. Launch the phones with no purchase at all *(recommended first step)*

The iOS and Android apps ship the two-person journey that is free today, with no paid-capacity
screen, no price, and no link to buy on the web. Nothing is for sale anywhere yet, because web
billing is not live either. With no paid feature to unlock, 3.1.1 and the Play Payments policy
have nothing to apply to.

- **Cost:** none, and it takes payments off the launch's critical path.
- **Constraint:** before web billing goes live, the phone app must not unlock capacity that was
  bought on the web unless option B or C also exists (3.1.3(b)). Until then, a paid journey opened
  on a phone would show the capacity it has without offering to change it. Confirm with App Review
  that this is acceptable, or keep paid journeys web-only at first.

### B. In-App Purchase through RevenueCat, feeding the existing entitlement ledger

RevenueCat wraps StoreKit 2 and Play Billing. It validates receipts and sends one webhook shape for
both stores. The server would add an adapter that turns those webhooks into
`billing_entitlements` rows with `source = 'apple' | 'google'`, the same way the Stripe webhook
does today.

- **Cost:** RevenueCat is free up to a revenue threshold and then takes a percentage. Check current
  pricing. It is also a third-party SDK in the app, and the mobile README currently promises none.
  That promise, the privacy policy and both store privacy forms would have to change.
- **Benefit:** the least code to write and maintain across two stores.

### C. In-App Purchase directly: StoreKit 2 and Play Billing, verified by our own server

This uses `expo-iap` (or `react-native-iap`) in the app. The server gains:

- App Store Server API calls and App Store Server Notifications v2;
- the Google Play Developer API and Real-time Developer Notifications (Cloud Pub/Sub);
- reconciliation for both, like the existing Stripe path.

- **Cost:** the most engineering. It adds two more webhook ingestion paths and two more
  reconciliation paths.
- **Benefit:** no third party in the app or in the money path.

The US link-out rules could be layered on top of B or C later, for the US storefront only. They
are not a substitute for either, because they do not apply outside the US.

## What the owner needs to decide

1. **Timing.** A, then B or C later? Or payments before the first store release?
2. **Tiers.** If B or C: which capacity tiers, at what store price points, and whether a journey
   paid on one rail can be topped up on another. (The ledger allows overlap. The product copy
   would have to explain it without saying "seats".)
3. **RevenueCat or direct.** B or C.
4. **The US storefront.** Whether to use link-out there, once its terms are settled.

Relates to #175, #117 and #47.
