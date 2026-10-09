# Store purchases: tying each one to an account

The phone sells through the App Store and Google Play; Stripe is the web's alone (#267). This page is about the
one thing every store purchase must carry, and why it is not optional (#269).

## The problem

A store purchase happens between a person and Apple or Google. We are not part of it. What comes back is a signed
transaction naming an Apple or Google account, never a Together Ledger one. Each store carries exactly one value
of ours through the purchase and back, and it can only be set **when the purchase starts**:

| Store | Field | Our value |
|---|---|---|
| App Store (StoreKit 2) | `appAccountToken` | the **journey value** |
| Google Play Billing | `obfuscatedAccountId` | the **account value** |
| Google Play Billing | `obfuscatedProfileId` | the **journey value** |

A purchase without them is verified, paid for, and impossible to attribute. The person is charged, and nothing
can be honoured: not on the phone, not on the web, not on a new phone. **Treat these fields as required, never as
metadata.**

## The values

Both are random UUIDs that we create and keep (migration `027_tie-every-store-purchase-to-an-account.sql`):

- **The account value** (`billing_store_accounts`) says who paid. There is one per account, the same on every device and after a reinstall.
- **The journey value** (`billing_store_journeys`) says who paid *and for which journey*. There is one per person per journey. Capacity belongs to a journey (`billing_entitlements` is journey-scoped), so a purchase has to name one. Apple carries only one value, so the journey value is what Apple gets; it still resolves to the account.

The account and journey ids themselves are never sent. The values travel to Apple and Google and come back in
receipts and server notifications. A mapping in our own table means none of that traffic names a person.

The journey value's row has no foreign key to `journeys`, on purpose. A journey is deleted with its last member,
and a refund or revocation can arrive afterwards. The record of what the value meant has to outlive the
journey, and must never be what stops a journey being deleted. Users are never removed, only marked deleted, so
the account link stays valid.

## Getting them

`POST /api/v1/journeys/:journeyId/billing/store-identity` returns:

```json
{ "data": { "appAccountToken": "…", "obfuscatedAccountId": "…", "obfuscatedProfileId": "…" } }
```

The values are created the first time and returned unchanged ever after, so the call is safe to repeat. It is
given only to someone who is:

- **signed in.** A signed-out phone is refused before anything else; a signed-out browser is asked to sign in.
- **verified.** An unverified account is refused with `email_unverified`. A purchase belongs to an account that can always be recovered.
- **in the journey.** A journeyer whose capacity is resting still gets them, because paying may be how capacity comes back.

## Decided: nothing is bought while signed out

Both stores will sell to someone who has not signed in. Together Ledger does not let them: the purchase cannot
start without the values, and the values need a signed-in, verified account. This is the simpler of the two
options #269 names, and the defensible one. Holding an anonymous transaction until a later sign-in would mean
storing purchases nobody can be asked about, and attaching them to whoever signs in next on that phone.

## On the phone

Every purchase is built by `purchaseOptions()` in `apps/mobile/src/billing/store-purchase.ts`. It refuses, before
anything is charged, unless every value it needs is a real UUID from the service. It then returns exactly what
StoreKit or Play Billing is given.

`tests/mobile-store-purchase.test.js` fails if any phone code starts a store purchase (`requestPurchase`,
`requestSubscription`, `launchBillingFlow`, and the like) without going through it.

### The purchase screen (TL-P-05, #272)

The phone buys through [expo-iap](https://github.com/hyochan/expo-iap): StoreKit 2 on iOS, Play Billing on
Android, as an Expo module that runs on the New Architecture. It is native code, so it needs a **new development
build**; an older build simply shows that purchases can't be made on that phone. `src/billing/store-kit.ts` is
the only file that imports it, and it hands the library whole to `src/billing/store-purchase.ts`, the only file
that starts a purchase (`startStorePurchase`) or tells a store one is finished (`settleStorePurchase`). A test
holds both.

- **Journey settings → Room for more people**, for the owner of a journey whose capacity is billed. The payer's
  first paid journey is offered the two monthly subscriptions; once this store account holds a subscription for
  another journey, this one is offered the four passes instead, because a second subscription in the same group
  would move the first journey's room here. A journey that already holds the subscription can change between 51
  and 101 people (on Google, up now with proration, down deferred to the end of the paid period).
  On Google, each subscription is bought through its base plan, whose ID must be exactly **`monthly`**
  (`GOOGLE_BASE_PLAN_ID`, `apps/mobile/src/billing/store-purchase.ts`). It is set in Play Console when the
  subscription is created, as the Book's "Together Ledger store products" Play Console steps say, and
  cannot be changed afterwards. A subscription with no `monthly` base plan can't be bought from the phone.
  "First paid journey" is judged per store account, from the subscriptions that store reports; someone with a
  subscription on the other platform is offered one again. Decided fine for v1 by the owner, Oct 8, 2026; knowing
  it across both stores is #344.
- **A moment → More on this moment**: an extra place, naming the moment, once it holds its free first place and
  only where the server counts a paid place. The journey snapshot says so in `extras.place`, which is true only
  with `MOMENT_LOCATION_BILLING_ENABLED` on and a billing service that counts paid places when a moment is saved;
  without billing, every second place is refused whatever was paid. An extra place the phone paid for but whose
  moment it no longer knows (the app closed before the store answered) waits, and can be put on any moment from
  there.
- **No extra photo is sold on the phone** until it can add photos to a moment (#187); owner, Oct 8, 2026.
- **Restore purchases**, in Settings and beside the room offers (#275). It gives one answer: a refusal on its own,
  or a purchase kept for a later try, or how many purchases it added. One our server had already honoured, such as
  a pass bought long ago, is in place but isn't counted as restored.
- Every price is the store's `displayPrice`. A product the store does not list says it isn't offered yet.
- **Apple 3.1.2.** Each monthly subscription offer shows its title, its length (one month, renewing until
  cancelled, and how to cancel), its price each month, and links to the **Terms of use** and the **Privacy
  policy**. Both open inside the app: the Terms screen shows TERMS.md, generated into
  `apps/mobile/src/policies/terms.json` by `scripts/mobile-policies.mjs` the way the privacy policy is, and
  `tests/mobile-policies.test.js` fails when it is stale. Settings opens both for everyone.
- **No room is offered until the store has said what this account holds**, so a "first paid journey" can't
  flash up before an existing subscription is known. What it holds is read again once a subscription purchase
  has arrived, not when the purchase flow returns.

Each transaction goes to `/billing/store-purchases/apple` or `/google`. It is finished on success; on a refusal
with `retryable: false`, an Apple transaction is finished, and a Google one is left unacknowledged so Google
refunds it within three days (decided by the owner, Oct 8, 2026); anything else (`retryable: true`, offline, a refusal that doesn't say) is kept for
the store to hand back. A purchase still waiting for approval (Ask to Buy on iOS, a pending payment on Google) is
not sent; the phone says once that it is waiting for approval and that nothing is charged until then.

The store connection lives as long as the signed-in account, never as long as a journey. Its listeners are
registered before it connects, as expo-iap's own `useIAP` does. On connecting, and every time the app returns to
the foreground, the phone sends everything the store still holds open: what `getAvailablePurchases` returns and,
on iOS, `getPendingTransactionsIOS`, since an unfinished consumable is not among the available purchases. A
purchase kept for a retry is therefore tried again the next time the app is opened, not only on the next launch.

On Android, Play Billing brings two permissions, so `app.json` grants them beside `INTERNET` and the Phone test APK
workflow allows them. `com.android.vending.BILLING` is declared by the billing library itself.
`android.permission.ACCESS_NETWORK_STATE` is declared by Google's datatransport, which Play Billing 9.1 depends on:
it schedules its uploads to wait for a network, which Android 9 and later refuse without it. Neither shows a prompt;
the second says only whether the phone is online and on what kind of network.

## When a purchase comes back (TL-P-05, #272)

A purchase is real when our server says it is. The phone reports what the store told it, and nothing is granted
on its word: a phone can be modified, and tools that fake exactly this exist.

| Method | Path | Body |
|---|---|---|
| POST | `/api/v1/billing/store-purchases/apple` | `{ "signedTransaction": "<StoreKit 2 JWS>", "momentId"?: "…" }` |
| POST | `/api/v1/billing/store-purchases/google` | `{ "productId": "…", "purchaseToken": "…", "momentId"?: "…", "packageName"?: "…" }` |

Both need a signed-in account (the phone's bearer token, or a browser session with its CSRF header). `momentId` is
needed only for an extra photo or place. The answer is `201` when this request granted the purchase and `200`
when it had been granted already, with the same body either way:

```json
{ "data": { "purchaseId": "…", "granted": true, "store": "apple", "environment": "live",
  "productId": "room_51_week_pass", "kind": "pass", "journeyId": "…", "acknowledgement": "not-needed",
  "room": { "people": 51, "state": "active", "from": "…", "until": "…" } } }
```

An extra answers with `"extra": { "kind": "photo", "momentId": "…", "slotIds": ["…"] }` instead of `room`. A slot id
is what `POST /journeys/:journeyId/moments/:momentId/images?paidSlotId=…` spends, exactly as for a photo paid
for on the web, and `GET …/image-slots` lists it alongside those.

### What is checked

**Apple** (`server/store-apple.js`). StoreKit 2 hands the app a JWS that Apple signed. It is verified here, with
no call to Apple: ES256, a three-certificate chain in `x5c` whose root is byte for byte one this server was given
(`APPLE_ROOT_CERTIFICATES`), each certificate issued and signed by the next and valid when Apple signed the
transaction, Apple's App Store signing marker on the leaf and its WWDR marker on the intermediate, and the
signature over the leaf's P-256 key. These are the checks Apple's own App Store Server Library makes. Only then is
the payload read: our `bundleId`, a product we sell with the type it should have, the environment this server
honours, no `revocationDate`, bought rather than family-shared, a subscription's `expiresDate` still ahead, and
`appAccountToken`. Revocation of Apple's certificates (OCSP) is not checked, because that is a network call on
every purchase.

**Google** (`server/store-google.js`). The phone has nothing Google signed, so the purchase token is looked up with
Google, server to server: `purchases.subscriptionsv2.get` for the monthly subscriptions, `purchases.products.get`
for passes and extras. The answer must name the product asked about, be purchased (a pending payment is answered
"still waiting", and granted once Google confirms it), and carry both `obfuscatedExternalAccountId` and
`obfuscatedExternalProfileId`, which must name the same person. A licence tester's purchase (`purchaseType` 0, or
`testPurchase` on a subscription) is a sandbox purchase.

**Both.** The value the purchase carried resolves through `billing_store_journeys` (and, for Google,
`billing_store_accounts`) to an account and a journey. A value we never issued, or none, is refused and logged. One
that resolves to a deleted account, or to an account other than the one asking, is explained and refused, and
nothing is moved (#275). Room is made only by the journey's owner, since one person pays for a journey and owning
it means paying for it (the Book, 4.7); anyone in the journey can buy an extra for a moment they can see.

### What a purchase becomes

| Product | Becomes |
|---|---|
| `room_51_monthly`, `room_101_monthly` | One `billing_entitlements` row (`source` `apple` or `google`) for the life of the subscription, keyed by Apple's `originalTransactionId` or Google's purchase token. Each renewal sent moves its end forward; a late, older one never moves it back. An Apple upgrade from 51 to 101 is the same row at the new size. A Google upgrade or downgrade is a new token naming the old one; see "Subscriptions over time" below. |
| `room_51_week_pass`, `room_101_week_pass` | Its own row, 7 days long. |
| `room_51_month_pass`, `room_101_month_pass` | Its own row, a calendar month long: the same day next month, or the month's last day when there is no such day (Jan 31 runs to Feb 28 or 29). |
| `extra_photo`, `extra_place` | An active slot on the moment, `moment_image_slots` or `moment_location_slots`, the same slot a web payment makes. It never lapses. |

The room is stored as the people beyond the two every journey holds: 51 is `quantity` 49, 101 is 99. Neither store
says how long a pass lasts, so its length is read from the product ID (`server/store-products.js`).

**A pass bought while another is running starts when that one ends**, if the running one holds at least as many
people: a second week adds a week rather than overlapping the first. A bigger pass bought during a smaller one
starts straight away, because making room for more people is why it was bought, and the smaller one runs on
beneath it. Passes from either store count, because the room is the journey's. A pass starts when our server
honours it, never earlier, so a purchase that reaches us late loses none of its days.

### When room bought in a store ends

Decided by the owner, Oct 8, 2026: **a pass that runs out, or a monthly subscription that lapses, gets the same grace
as a failed web payment.** Neither store tells us anything when that happens: a pass simply reaches its end, and a
subscription that isn't renewed sends no renewal. So the row stays `active`, and `paymentFor` (`server/platform.js`)
reads a store row whose end has passed as in grace for `BILLING_GRACE_DAYS` (7) from that end:

- New invitations wait, a banner tells everyone, and the payer can ask for another week, up to 6 times per journey
  per calendar year (migration 030), exactly as for Stripe.
- Room that has started always comes first, so a pass bought during the grace ends it straight away. That pass
  starts at once, because a pass that has ended isn't running for it to wait behind.
- A subscription marked `store_subscription_replaced` gets no grace: something newer took its place.
- When the grace and any weeks asked for are over, the people beyond two rest. Nobody is removed.

### Subscriptions over time

Decided by the owner, Oct 8, 2026, after review of #335:

- **A renewal extends the subscription without checking ownership again.** On Google a renewal keeps its purchase
  token, so it arrives as the same purchase. On Apple it has a new `transactionId`, and counts as a renewal when Apple
  marks it `transactionReason: RENEWAL` and it continues a subscription already granted to the same journey. Either
  way it extends the room even if the payer has since handed the journey to someone else. Refusing it would leave
  them paying Apple or Google for nothing. Ownership is checked when a subscription is first bought, resubscribed,
  upgraded or moved, all of which Apple marks `PURCHASE`.
- **The room follows the journey the person has just paid from.** Apple keeps the `originalTransactionId` across a
  resubscription or an upgrade, and the person may make it from another journey (that journey's `appAccountToken`).
  - The entitlement moves to that journey.
  - The journey it left goes into the usual grace (`BILLING_GRACE_DAYS`, 7) if its room was still running:
    invitations wait, and when grace ends the people beyond two rest. Nobody is removed. If its room had
    already lapsed and was still inside its grace (end plus 7 days, plus any week asked for), it keeps exactly
    the time it had left (owner, Oct 8, 2026), so the banner stays and nobody rests early.
  - Both journeys' records get an event, `paid_room_moved_out` and `paid_room_moved_in`, without naming the other
    journey.
  - A move needs a strictly newer payment, so an older transaction from the first journey arriving late moves
    nothing back.
- **A replaced Google subscription never comes back.** An upgrade, downgrade or resubscription on Google is a new
  token naming the one it replaces (`linkedPurchaseToken`).
  - The old token's room ends when the new purchase starts. For a deferred downgrade from 101 to 51, that is the end
    of the 101 period already paid for, not the moment of the downgrade.
  - When that new purchase was made from another journey, the old journey gets the usual 7 days of grace starting
    when its old room ends, and its record says so at once (owner, Oct 8, 2026).
  - The old token's room is marked `store_subscription_replaced` and is never made active again, even if the old
    token is sent while Google still reports it active.
  - A replaced token we had never seen is recorded the same way, so sending it later grants nothing.

While a journey holds more than one entitlement, it has the most generous one that has started and not ended,
fully paid ahead of in grace. That is a placeholder for the rules #274 and #276 will settle.

**The same transaction twice grants once.** Every verified purchase gets one row in `billing_store_purchases`
(migration 028), unique on store, environment and transaction (Apple's `transactionId`, Google's purchase token).
Sending it again finds the row and answers with what it already granted. Two sent at the same moment are decided
by that unique row; the Postgres test proves it.

### Sandbox and live never cross

`STORE_ENVIRONMENT` is `live` or `sandbox`, and a server honours only that one's purchases. A sandbox purchase on a
live server is refused ("test purchases don't add anything, and aren't charged"), and a real one on a test server
is refused too. Capacity and paid slots are read only from this server's own environments
(`config.billingEnvironments`), with the one exception below. A server that takes live Stripe payments must be
`STORE_ENVIRONMENT=live`, or it will not start.

**The exception: sandbox testers on a live server** (decided by the owner, Oct 8, 2026). App Review buys in the
sandbox against the production app, so a live server that refused every sandbox purchase would show the reviewer a
refusal. `STORE_SANDBOX_ACCOUNT_IDS` lists, comma-separated, the account ids whose sandbox purchases a live server
still honours: the App Review sample account (#260) and the owner's own test accounts.

- A listed account's sandbox purchase is granted and recorded as `sandbox`, never `live`.
- Sandbox room and slots are read on a live server only where a listed account paid for them
  (`server/billing-environments.js`). A sandbox row paid for by anyone else is never read, whoever's journey it is in.
- Everyone else's sandbox purchase is refused exactly as before, and logged.
- Whose purchase it is comes from the verified account value, as for every purchase. Signing in as a listed account
  does not make someone else's sandbox purchase count; it is refused as another account's.
- On a sandbox server the list is ignored: every sandbox purchase counts there already.
- An id that is not a UUID stops the server from starting.

**The review account's id changes when it is rebuilt.** `server/seed-review-journey.js` deletes both sample accounts
and makes them again on every run (#260), so each run gives the reviewer a new account id. The script prints the exact
line to set: `STORE_SANDBOX_ACCOUNT_IDS=…`, which keeps the configured ids that still belong to an account (your own
test accounts), drops the deleted reviewer, and adds the new one. Set it in the live server's environment and restart
before the next review. Until then, the old id belongs to a deleted account, which no purchase can use anyway.

### Google's three days

Google refunds a purchase nobody acknowledged within three days, silently, and takes the entitlement back. So once
a Google grant has committed, the server acknowledges it: a subscription with `purchases.subscriptions.acknowledge`,
a pass or extra with `purchases.products.consume`, which acknowledges it and lets it be bought again (Google
recommends consuming from a secure backend). If Google can't be reached, the row stays `pending`. The server looks
every ten minutes for pending rows whose wait is over (1, 5, 15 and 30 minutes after successive failures, then an
hour, then every two hours) and tries again, and it also tries again whenever the phone sends the purchase. One already acknowledged or consumed, by the phone or an earlier attempt, is
recorded as done without asking twice. Any failure on one purchase, of whatever kind (a Google error, an answer that
is not JSON, a bug), puts only that purchase back in the queue with a longer wait, so it never holds up the others. A purchase still pending at its deadline is logged as an error, `google
acknowledgement window missed`.

### When the store has the money and our write fails

Decided: **the phone sends it again, and nothing is acknowledged that was not written.** The grant and its
purchase row are one transaction, and Google is acknowledged only after it commits. Until the phone hears success,
it keeps the purchase open: StoreKit redelivers an unfinished transaction on every launch, and Play returns an
unacknowledged purchase to `queryPurchasesAsync`. When it is sent again, it is granted as if for the first time.
The worst case is that Google refunds a purchase we never managed to record, never that someone pays and keeps
nothing. Reconciling against the stores (TL-P-10, #277) is the second net.

### Refusals

Every refusal of a purchase carries `error.details.retryable`. The phone should **finish an Apple transaction only on success or
on a refusal that is not retryable**, and keep it otherwise. Every message is true for someone who has been
charged; where a purchase cannot be honoured, it says where a refund comes from.

| Code | Status | Retryable | Meaning |
|---|---|---|---|
| `store_unavailable` | 503 | yes | That store isn't configured here, or can't be reached. |
| `store_purchase_unverified` | 400 | no | Apple's signature or chain did not verify, or Google does not know the token. |
| `store_purchase_wrong_app` | 400 | no | Another app's bundle or package. |
| `store_product_unknown` | 400 | no | Not one of the eight products, or not the type it should be. |
| `store_purchase_quantity` | 400 | no | A quantity above ten, or above one for a subscription. |
| `store_environment_mismatch` | 409 | no | A sandbox purchase on a live server from an account not in `STORE_SANDBOX_ACCOUNT_IDS`, or a real one on a test server. Logged. |
| `store_purchase_refunded` | 409 | no | Apple has refunded or revoked it. |
| `store_purchase_family_shared` | 409 | no | Shared through Family Sharing, which is off for every product. |
| `store_purchase_canceled` | 409 | no | Google canceled it. |
| `store_purchase_pending` | 409 | yes | Google is still waiting for the payment. |
| `store_subscription_ended` | 409 | no | The subscription has ended. |
| `store_purchase_unlinked` | 409 | no | It carries no value of ours, one we never issued, or Google's two values disagree. Logged. |
| `store_purchase_account_deleted` | 409 | no | It belongs to a deleted account. Logged. |
| `store_purchase_other_account` | 409 | no | It belongs to another Together Ledger account. Logged. |
| `store_purchase_journey_gone` | 409 | no | The journey has gone, or the buyer has left it. Logged. |
| `store_purchase_not_owner` | 409 | no | Room bought by someone who doesn't hold the journey. Logged. |
| `store_extra_needs_moment` | 400 | yes | An extra sent without the moment it is for. |
| `store_extra_moment_missing` | 409 | yes | That moment has gone; send it again for another. |

A refusal's log line names the store, the code, the product, and Apple's `transactionId` or a 16-character hash of
Google's purchase token, which is itself a credential and never logged.

## What the stores say afterwards (#273)

A store purchase can change after it was made, and only the store knows: the person asks Apple for a refund, a
subscription renews or lapses. The stores tell us on a channel we have to listen on. Apple's and Google's are both built
here; what a refunded extra does is not yet (see "Not built here").

### Apple: App Store Server Notifications

| Method | Path | Body |
|---|---|---|
| POST | `/api/v1/billing/store-notifications/apple` | `{ "signedPayload": "<JWS>" }`, sent by Apple's servers (Version 2) |

The URL sits beside `/billing/store-purchases/apple`, and Google's beside it. It is not
`/api/v1/auth/apple/notifications`, which is Sign in with Apple's (#250) and unchanged.

Apple's servers send it, so there is no origin, cookie or token to check: **the signed payload is the only
credential.** It is checked exactly as a purchase is (`AppleTransactionVerifier`, `APPLE_ROOT_CERTIFICATES`), and so
is the transaction signed inside it. Both must name our `bundleId`. Without the root certificate the endpoint answers
`503`, and Apple sends again later.

| Notification | What it does to the room |
|---|---|
| `DID_RENEW` | The subscription runs to Apple's new end. A renewal the phone never sent is recorded as a purchase, so the phone sending it later grants nothing more. A renewal naming another journey changes nothing: a move is only made when the phone sends the purchase, with its checks. |
| `REFUND` | The room ends when Apple refunded it, or on its own end if that came first. Then the usual grace, then the people beyond two rest. A refund of an earlier period that has since been paid again changes nothing. A pass that had not started never starts. |
| `REVOKE` | The same as a refund. Family Sharing is off for every product, so a shared copy never made room to take back. |
| `EXPIRED`, `DID_FAIL_TO_RENEW`, `GRACE_PERIOD_EXPIRED` | Nothing to write: the room ends on the date already paid for, and the usual grace starts there, as for a failed web payment. A `DID_FAIL_TO_RENEW` with the `GRACE_PERIOD` subtype is the same: Apple's billing grace period never extends the room (see below). |
| `REFUND_REVERSED` | Logged as `not_acted_on`, and nothing changes. A reversed refund should bring the room back; that is not built yet (see "Not built here"). |
| `CONSUMPTION_REQUEST` | Logged as `not_acted_on`, and never answered (see below). |
| `TEST` | Logged, and nothing changes. |
| Any other | Logged as `not_acted_on`, and nothing changes. |

**Refunded room rests the usual way** (owner, Oct 8, 2026, on #203). There is no new path for a store refund: the
room's end moves to the refund, and from there `paymentFor` (`server/platform.js`) reads it exactly like a pass that
ran out. New invitations wait, everyone sees the grace, the payer can ask for more weeks, and when the grace is over
the people beyond two rest. Nobody is removed.

**Our grace is the only grace** (owner, Oct 8 and Oct 9, 2026). A store lapse gets the same grace as a failed web
payment, and nothing more. Billing Grace Period stays off in App Store Connect (see "Setting it up"). If a
`DID_FAIL_TO_RENEW` with the `GRACE_PERIOD` subtype arrives anyway, it is a lapse: the room still ends on the date
already paid for, and Apple's `gracePeriodExpiresDate` is never read. The same holds for Google: the end Google gives a
subscription in its own grace period is never read, whether a notification or the phone brings it.

**A refund writes nothing into the journey's History** (owner, Oct 9, 2026). A refund is the payer's own matter. What
everyone else sees is what any lapse shows: the grace, and then who rests. No notification writes a History entry.

**`CONSUMPTION_REQUEST` is never answered in v1** (owner, Oct 9, 2026). Answering it would send Apple how a person
used the app, while Apple decides a refund. PRIVACY.md doesn't say we share that, so we don't. The request is logged
as `not_acted_on`, and the server makes no call to Apple.

**An extra photo or place is only noted.** A refunded `extra_photo` or `extra_place` is logged as `extra_noted` and
its slot is left as it is, until what a refunded extra does is decided.

**A refunded transaction never comes back.** The purchase row is marked (`revoked_at`, `revocation`, migration 034),
and a copy of the transaction signed before the refund, sent again by a phone, extends nothing. A refunded renewal we
had never been sent is recorded as refunded, so sending it later grants nothing either.

**Received twice, applied once.** Apple sends again until it hears a `200`. Each notification is one row in
`billing_store_notifications`, unique on store and Apple's `notificationUUID`, written in the same transaction as
its effect, so a second delivery, or two at once, changes nothing. The Postgres test proves the second case.

**The log** (`billing_store_notifications`, migration 034) holds, for every notification received, whether or not it
changed anything: the store, its notification id, type and subtype, environment, the purchase it is about, Apple's
`transactionId`, when Apple signed it, when it arrived, and what it did (`outcome`). It keeps nothing else from the
payload. A row goes with the purchase it explains (`ON DELETE CASCADE`); one about no purchase we hold goes after
30 days.

| Code | Status | Meaning |
|---|---|---|
| `store_notification_unverified` | 400 | The signature or chain did not verify, on the notification or the transaction inside it. Logged. |
| `store_notification_wrong_app` | 400 | Another app's bundle ID. Logged. |
| `store_unavailable` | 503 | Apple isn't configured on this server. Apple sends it again later. |

Sandbox and live notifications both come here. Each one only ever touches rows of its own environment, so a sandbox
notification on the live server can reach only a sandbox tester's room (`STORE_SANDBOX_ACCOUNT_IDS`).

### Google: Real-time developer notifications

| Method | Path | Body |
|---|---|---|
| POST | `/api/v1/billing/store-notifications/google` | `{ "message": { "data": "<base64>", "messageId": "…" }, "subscription": "…" }`, pushed by a Pub/Sub push subscription, with `Authorization: Bearer <OIDC token>` |

Google Play publishes each notification to a Pub/Sub topic, and a push subscription delivers it here. Anyone can send
a request to this URL, so **the push's token is the credential.** Pub/Sub signs an OIDC token for the push
subscription's service account and sends it with every push. It is checked before the message is read
(`GooglePushVerifier`, `server/store-google.js`):

- signed RS256 by one of Google's published keys (`https://www.googleapis.com/oauth2/v3/certs`, kept for as long as
  Google's `Cache-Control` says, and read again early at most once a minute when a token names a key we don't hold);
- issued by `accounts.google.com`;
- for the audience in `GOOGLE_PLAY_NOTIFICATIONS_AUDIENCE`;
- naming the service account in `GOOGLE_PLAY_NOTIFICATIONS_SERVICE_ACCOUNT_EMAIL`, with a verified email;
- not expired.

With either setting empty, the endpoint accepts nothing.

**The message is never believed on its own.** Google's notification says only that something changed, and Google
says to read the purchase again. Each purchase it names is read again from the Play Developer API through
`server/store-google.js`: `purchases.subscriptionsv2.get` for a subscription, `purchases.voidedpurchases.list` for a
refund. Only what Google says there changes a room. A notification for any package other than
`com.togetherledger.ledger` (`GOOGLE_PLAY_PACKAGE_NAME`) is refused before anything is read. A notification is only
read again when it could change a room we granted; a test, an extra, a partial refund, a kind we don't act on, or a
purchase we never granted costs no call to Google.

| Notification | What it does to the room |
|---|---|
| `SUBSCRIPTION_RENEWED`, `SUBSCRIPTION_RECOVERED` | When Google says the subscription is active, the room runs to Google's new end, and the purchase records it, so the phone sending it later grants nothing more. `SUBSCRIPTION_RECOVERED` is a subscription paid again after account hold or a pause. While Google has the subscription in its grace period or account hold, nothing is extended. |
| `SUBSCRIPTION_CANCELED`, `SUBSCRIPTION_EXPIRED`, `SUBSCRIPTION_ON_HOLD`, `SUBSCRIPTION_IN_GRACE_PERIOD` | Nothing to write: the room ends on the date already paid for, and the usual grace starts there, as for a failed web payment. |
| `SUBSCRIPTION_REVOKED` | When Google says the subscription has expired, the room ends when Google ended it. Then the usual grace, then the people beyond two rest. |
| A voided purchase | Once Google lists it as voided, the room ends when Google voided it, and a pass that had not started never starts. For a subscription, only a void of the latest order paid ends it: each renewal is its own order under the same purchase token, and a void of an earlier order since paid again changes nothing. A quantity-based partial refund is logged as `not_acted_on`. |
| Google's test notification | Logged as `test`, and nothing changes. Google isn't asked anything. |
| `extra_photo`, `extra_place` | Logged as `extra_noted`, and nothing changes (see "Not built here"). |
| Any other | Logged as `not_acted_on`, and nothing changes. |

**When Google doesn't confirm a notification, nothing changes.** A renewal Google doesn't call active, a revocation of
a subscription Google still calls running, or a void Google doesn't list, is logged as `unchanged` with the line
`google did not confirm a notification`. When Google can't be reached, or refuses our credentials, the answer is
`503` and nothing is logged, so Pub/Sub sends the message again. It keeps trying for as long as the subscription
keeps messages (seven days by default).

**A refund that leaves the subscription running.** Google can refund a period without ending the subscription, and
then still calls that period active. The room ends at the refund all the same, as for Apple, and the purchase is
marked refunded. After that, only a renewal notification for a period that ends later brings room back; the phone
sending the same purchase again does not.

**Received twice, applied once.** Pub/Sub delivers at least once. Each message is one row in
`billing_store_notifications`, unique on store and Pub/Sub's `messageId`, written in the same transaction as its effect.
A message already logged is answered `200` without asking Google again. The log keeps what it keeps for Apple, with a
16-character hash of the purchase token as `transaction_ref` and Google's `eventTimeMillis` as when it was signed.
A Google notification names no environment, so it takes the environment of the purchase it is about, and none when
it is about no purchase we hold.

| Code | Status | Meaning |
|---|---|---|
| `store_notification_unauthenticated` | 401 | No token, or one that isn't Google's, for our audience and our push service account. Logged, never with the token. |
| `store_notification_unverified` | 400 | The body isn't a Pub/Sub message carrying a notification. Logged. |
| `store_notification_wrong_app` | 400 | Another package. Logged. |
| `store_unavailable` | 503 | The push settings or the Play Developer API aren't configured on this server, or Google can't be reached. Pub/Sub sends it again later. |

Pub/Sub treats any answer but a success as "send again", so a refused message comes back until the subscription
stops keeping it. A refusal is only ever logged; it changes nothing.

### One path for both stores

`StorePurchaseService.applyStoreEvent` is the one place a store's later word changes a journey's room: `renewed`,
`lapsed`, `refunded` or `revoked`, for a store, environment and the store's id for the room. `noteNotification` and
`settleNotification` keep the log. Apple's and Google's notifications both call the same three.

## Setting it up

Neither store is on until its trust is configured, and until then its purchases are answered `store_unavailable`
(retryable), so a phone keeps them.

### Apple: the root certificate

1. Download **Apple Root CA - G3** from <https://www.apple.com/certificateauthority/> (`AppleRootCA-G3.cer`).
2. Check its SHA-256 fingerprint against the one Apple lists on that page:
   `openssl x509 -inform der -in AppleRootCA-G3.cer -noout -fingerprint -sha256`.
3. Put it in the environment as one line of base64: `APPLE_ROOT_CERTIFICATES=$(base64 -w0 AppleRootCA-G3.cer)`.
   The server refuses to start if it is not a self-signed CA certificate.

It is public, and stays out of the repository only so that the trust the server runs on is something someone
chose and checked, alongside the other secrets. `APPLE_BUNDLE_ID` defaults to `com.togetherledger.ledger`.

### Apple: server notifications (after the release)

Once a release with migration 034 is live, in **App Store Connect → the app → App Information → App Store Server
Notifications**:

1. **Production Server URL**: `https://api.together-ledger.com/api/v1/billing/store-notifications/apple`
2. **Sandbox Server URL**: the same URL (owner, Oct 9, 2026). Sandbox testers' purchases (App Review, the owner's
   test accounts) are recorded on the live server, so their notifications have to reach it too. Only accounts listed
   in `STORE_SANDBOX_ACCOUNT_IDS` can make a sandbox purchase count there, and a sandbox notification only ever
   touches sandbox rows, so it can't change anyone else's room.
3. **Version 2** for both, then **Save**.
4. **Leave Billing Grace Period off** (the app's Subscriptions page in App Store Connect). Our own grace is the only
   grace, the same as for a failed web payment (owner, Oct 8, 2026).
5. **Request a test notification** (App Store Connect, or the App Store Server API's
   `POST /inApps/v1/notifications/test`). The server logs `store notification` with `"type":"TEST"`, and
   `billing_store_notifications` has a row with `outcome` `test`.

### Google: Real-time developer notifications (after the release)

Once a release with Google's endpoint is live (it needs no migration), in the **Google Cloud console**, project
**togetherledger-app**:

1. **The topic.** **Pub/Sub → Topics → Create topic.** Topic ID `play-notifications`. Leave "Add a default
   subscription" unticked, then **Create**. Its full name is `projects/togetherledger-app/topics/play-notifications`.
2. **Let Google Play publish to it.** **Pub/Sub → Topics →** `play-notifications` **→ Permissions** (in the info panel)
   **→ Add principal**: `google-play-developer-notifications@system.gserviceaccount.com`, role **Pub/Sub Publisher**,
   then **Save**.
3. **The account the push signs in as.** **IAM & Admin → Service accounts → Create service account.** A name such as
   `play-notifications-push`. It needs no roles. Its email,
   `play-notifications-push@togetherledger-app.iam.gserviceaccount.com`, is
   `GOOGLE_PLAY_NOTIFICATIONS_SERVICE_ACCOUNT_EMAIL`. It is not the Play service account above, and it has no key.
4. **The push subscription, with authentication.** **Pub/Sub → Subscriptions → Create subscription:**
   - Subscription ID `play-notifications-push`, topic `projects/togetherledger-app/topics/play-notifications`.
   - Delivery type **Push**. Endpoint URL `https://api.together-ledger.com/api/v1/billing/store-notifications/google`.
   - Tick **Enable authentication**, and choose the service account from step 3.
   - **Audience**: `https://api.together-ledger.com/api/v1/billing/store-notifications/google`. This is
     `GOOGLE_PLAY_NOTIFICATIONS_AUDIENCE`.
   - Leave **Enable payload unwrapping** off: the server reads the message as Pub/Sub wraps it.
   - Retry policy: **Retry after exponential backoff delay**. Leave message retention at 7 days.
   - **Create.**
5. **Set the two values** on the live server, with the other secrets, and restart:
   `GOOGLE_PLAY_NOTIFICATIONS_AUDIENCE` and `GOOGLE_PLAY_NOTIFICATIONS_SERVICE_ACCOUNT_EMAIL`, exactly as in step 4.
   Until both are set, every push is answered `503` and Pub/Sub keeps it.

Then in **Play Console → Together Ledger → Monetize with Play → Monetization setup → Real-time developer
notifications**:

6. Tick **Enable real-time notifications**, and set **Topic name** to
   `projects/togetherledger-app/topics/play-notifications`.
7. **Notification content**: **Get notifications for subscriptions and all voided purchases**. One-time purchase
   events aren't needed: the phone sends every pass and extra.
8. **Send test message**, then **Save changes**. The server logs `store notification` with `"type":"TEST"`, and
   `billing_store_notifications` has a `google` row with `outcome` `test`. If Play Console says the publish failed,
   step 2 is missing.

Refunds are read through `purchases.voidedpurchases.list`, which needs the Play service account's **View financial
data** permission. That is already granted in step 5 of "Google: the Play service account", below.

### Google: the Play service account

Checked against Google's [Getting started](https://developers.google.com/android-publisher/getting_started) on Oct 8,
2026:

1. In the **Google Cloud console**, choose the project Together Ledger's Google work lives in (or create one).
2. Open **APIs & Services → Library → Google Play Android Developer API** and **Enable** it.
3. **IAM & Admin → Service accounts → Create service account**. A name such as `play-purchases`. It needs no
   Cloud roles.
4. On the new account, **Keys → Add key → Create new key → JSON**. The file downloads once; it is a secret.
5. In **Play Console → Users and permissions → Invite new users**, enter the service account's email (it ends in
   `.iam.gserviceaccount.com`). Under app permissions for Together Ledger, grant **View financial data, orders, and
   cancellation survey responses** and **Manage orders and subscriptions**, then **Invite user**.
6. Store the JSON in Secrets Manager with the other secrets and inject it as `GOOGLE_PLAY_SERVICE_ACCOUNT`, either
   the JSON on one line or base64 of the file. The server refuses to start if it has no `client_email` or
   `private_key`.

`GOOGLE_PLAY_PACKAGE_NAME` defaults to `com.togetherledger.ledger`. If Google refuses the service account's calls
(a permission not granted yet, or not yet in effect), the log says `google play refused our credentials` and
purchases answer `store_unavailable`, so phones keep them until it is fixed. Products in Play Console can only be created after a build with the Play Billing Library is on a track, so
the Google side is tested end to end only once that build exists (#271).

### Turning capacity on

Paid room is read only when `JOURNEY_CAPACITY_MODE=billing`. That used to need Stripe billing on; it now needs Stripe
billing **or** at least one store configured, so the phones can sell while web billing is still off.

## Not built here

- **What a refunded extra photo or place does** (#273, 16C). Apple's or Google's refund of one is logged and changes
  nothing.
- **A partial refund of a Google pass bought several at once** (#273). Google can refund some of a multi-quantity
  purchase. It is logged as `not_acted_on` and the pass runs on; a refund of what is left ends it.
- **A reversed refund** (#273, 16C, with refunded extras). Apple's `REFUND_REVERSED` should bring the room back (owner, Oct 9,
  2026). For now it is logged as `not_acted_on` and changes nothing.
- **Alerting when refunds spike** (#273).
- **Restore on a new phone** (#275). The phone's Restore purchases sends what the store hands back; a
  subscription bought on the other platform is not seen from this one.
- **What a journey holding more than one entitlement means** (#274, #276), beyond "the most generous one counts".
- **Reconciliation against the stores** (#277).
- **The phone's delete-account dialog.** Deleting the account deletes the journey and its store entitlements, and
  keeps `billing_store_purchases`, but it does not cancel a store subscription: that carries on, and keeps
  charging, until the person cancels it with Apple or Google. **Decided by the owner, Oct 8, 2026: the phone's
  delete-account dialog must say that a store subscription is cancelled with Apple or Google**, not by deleting the
  account (App Store guideline 5.1.1(v) asks for this too). The phone's deletion screen and its confirmation
  dialog now say it (`STORE_SUBSCRIPTION_NOT_CANCELLED`); nothing on the server stands in for it.
