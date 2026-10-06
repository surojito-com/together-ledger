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
`requestSubscription`, `launchBillingFlow`, and the like) without going through it. There is no purchase screen
yet; the work that adds one (TL-P-05 onward) builds on this rather than around it.

## When a purchase comes back (TL-P-05, not built yet)

- Read the value from the **verified** transaction, never from the client.
- Resolve it through these tables to an account and a journey. A value we never issued is refused.
- A value that resolves to a deleted account, or to a different account from the one asking (a phone that changed hands), is explained and refused. Capacity is never moved silently (#275).
