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
- **A moment → More on this moment**, once it holds its free first photo or place: an extra photo or place,
  naming the moment. An extra the phone paid for but whose moment it no longer knows (the app closed before the
  store answered) waits, and can be put on any moment from there.
- **Restore purchases**, in Settings and beside the room offers (#275).
- Every price is the store's `displayPrice`. A product the store does not list says it isn't offered yet.

Each transaction goes to `/billing/store-purchases/apple` or `/google`. It is finished on success; on a refusal
with `retryable: false`, an Apple transaction is finished, and a Google one is left unacknowledged so Google
refunds it within three days; anything else (`retryable: true`, offline, a refusal that doesn't say) is kept for
the store to hand back. A purchase Google still reports as pending is not sent.

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
    invitations wait, and when grace ends the people beyond two rest. Nobody is removed.
  - Both journeys' records get an event, `paid_room_moved_out` and `paid_room_moved_in`, without naming the other
    journey.
  - A move needs a strictly newer payment, so an older transaction from the first journey arriving late moves
    nothing back.
- **A replaced Google subscription never comes back.** An upgrade, downgrade or resubscription on Google is a new
  token naming the one it replaces (`linkedPurchaseToken`).
  - The old token's room ends when the new purchase starts. For a deferred downgrade from 101 to 51, that is the end
    of the 101 period already paid for, not the moment of the downgrade.
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

- **Server notifications, refunds and revocations** (#273). A refund through Apple or Google does not take room back
  yet; nothing listens for it. A Google subscription's renewal is recorded when the phone sends it again, not on
  Google's word.
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
