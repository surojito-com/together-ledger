# App review: the sample journey

Together Ledger is a journey shared between people. An app reviewer signs in alone, to a fresh account, and an
empty ledger with nobody to share it with looks like an app that does nothing. So the review account arrives
already in a journey with a second sample account, with moments, places, a money note and conversations in it
(#260).

`server/seed-review-journey.js` builds that journey. Run it before every submission and every resubmission. The
account is only its output, so nobody has to remember how it was made.

## What it makes

| | Reviewer account | Partner account |
|---|---|---|
| Name journeyers see | Sam (sample) | Alex (sample) |
| Private username | `app-review-sam` | `app-review-alex` |
| In the journey | Owner | Journeyer, joined by invitation |

Both accounts are in **Sample journey: Sam and Alex**, with nine moments:

- five **shared now**, from both people, with two themes, two places and one money note;
- one **private** and one **share later** from each person, so whoever signs in sees the privacy cue on moments only they can see, and does not see the other person's;
- two conversations, one open and one resolved, under History and conversations.

Dates are counted back from the day it runs, so the journey always looks recent.

Each run first deletes both sample accounts the way a person deletes theirs, then makes them again. The journey
goes with them. The service's own calls do all of it: register, verify, propose, invite, accept, hold a moment.
So the journey's history is the one the product itself writes. No mail is sent. The verification and invitation
links stay in memory and are used straight away.

## It cannot reach anyone else

Before deleting anything, the script checks that each account is one of the two sample accounts: the email it
was given, holding the sample's fixed private username. It also checks that every journey either account is in
holds nobody else. If either check fails, it stops and changes nothing:

- if the address given for a sample already belongs to someone else's account, that account is left alone;
- if a real person has proposed or added a sample account to their journey, or been added to the sample journey, nothing is deleted. Look at that journey before running it again.

Use two addresses on the company's own domain, never a personal address. Then any recovery mail a reviewer
triggers comes to us, and nobody else's inbox is involved.

## Running it

The credentials never go in this repository, which is public. Keep them in a root-owned file on the host, mode
0600, `/etc/together-ledger/app-review.env`:

```
REVIEW_EMAIL=…
REVIEW_PARTNER_EMAIL=…
REVIEW_PASSWORD=…
```

The password is 12 to 128 characters, and both accounts use it. Then, from the production checkout:

```bash
set -a; . /etc/together-ledger/app-review.env; set +a
docker compose --env-file /etc/together-ledger/production.env -f compose.production.yaml run --rm \
  -e REVIEW_EMAIL -e REVIEW_PARTNER_EMAIL -e REVIEW_PASSWORD \
  app node server/seed-review-journey.js
```

`-e NAME` with no value passes the variable through from the shell, so the password stays out of the command line
and the shell history. The script prints the ids, names and counts it made, and never the password. It exits
non-zero, having changed nothing, if a check above fails.

It also prints a `STORE_SANDBOX_ACCOUNT_IDS=…` line. App Review buys in the sandbox against the live app, and the live
server honours that only for the accounts in that setting (#272, docs/STORE_PURCHASES.md). The reviewer's account id
is new after every run, so set that line in `/etc/together-ledger/production.env` and restart the app before the
review, or the reviewer's test purchases will be refused.

The same email and password go in App Store Connect (App Review Information, Sign-in required) and in Play
Console (App content, App access). The credentials do not expire. Rebuilding with the same file leaves them
unchanged, so a review re-run months later still signs in.

## Before submitting

Sign in on a clean device with nothing but the email and password from the store form, and no team knowledge.
Check that the journey opens with its moments, that a private moment shows its cue, and that Journey sharing
shows both people. Then sign in as the partner and check that the reviewer's private moment is not there. Only
then does the submission count as checked.

## Paying, for a reviewer

The app is free to download, and **the first version offers in-app purchase**, through the App Store and Google
Play. Stripe is the web's alone and never appears in the app (#267, #268). Both stores test purchases directly:
Apple's reviewers buy with a sandbox account, Google's with a licence-tester account. Both press Restore
Purchases (#275). So the sample journey has to let a reviewer reach every purchase the app offers, and see what
paid capacity looks like once it is held:

- **Room for more people.** Sam owns the sample journey, so Sam can reach it: Settings → Journey sharing → Room for more people. It is shown only while production runs `JOURNEY_CAPACITY_MODE=billing` (`apps/mobile/app/journey-settings.tsx`).
- **An extra place on a moment.** It is offered on a saved moment that already holds its free first place, and only while production counts paid places (`MOMENT_LOCATION_BILLING_ENABLED`, `docs/STORE_PURCHASES.md`). Sam's moment "The walk along the canal" has one. **No extra photo** is sold on the phone until it can add photos (#187).
- **Paid capacity already held.** The entitlement ledger accepts a `promotion` source as well as `apple`, `google` and `stripe` (`008_stripe_web_billing.sql`). So the sample journey can hold paid capacity honestly, granted by us rather than through a faked store receipt, and the paid screens have something to show before a reviewer buys anything. How many people a journey has room for already counts an entitlement from any source (`capacityFor()` in `server/platform.js`). The billing panel and Stripe reconciliation have not yet been checked against a `promotion` grant; do that when it is built. This script doesn't grant one yet (below).

**What is built, and what isn't.** The phone's store purchase landed in `977f365`: room for more people, an
extra place, and Restore purchases in Settings (`apps/mobile/src/components/store-offers.tsx`,
`docs/STORE_PURCHASES.md`). A reviewer's sandbox purchase is honoured because Sam's account id is in
`STORE_SANDBOX_ACCOUNT_IDS` (above). Alex's isn't, so test purchases are made as Sam.

This script hasn't grown with it yet. It grants the sample journey no `promotion` capacity, so a reviewer sees the
unpaid state until they buy. Whether to add that grant, and how much, is still open, decided against the products
as they are created in both consoles (TL-P-04, #271).

Two store rules shape this:

- **Apple 3.1.3(b).** The app may honour capacity bought on the web only if the same capacity can also be bought in the app. That is why store purchase ships before web billing goes live.
- **Restore Purchases.** It must be easy to find. A restore that finds a purchase tied to a different Together Ledger account refuses and explains, rather than moving capacity (#275).

## Notes for the reviewer

**App Store:** paste `store/app-store/review-notes.txt`. While production counts paid places, paste
`store/app-store/review-notes-extra-place.txt` after it. `store/app-store/README.md` lists what must be true before
each submission, and `npm run check` holds the notes to the code.

**Google Play:** paste this. Its paragraph about purchases isn't written yet:

> Together Ledger is a private journal that two or more people keep together. Each person holds "moments" (a
> promise, a memory, a feeling, a repair request) and chooses who sees each one: **Private** stays with them,
> **Shared now** opens it to everyone in the journey, and **Share later** waits until they deliberately share it.
> Each moment's privacy is shown by its shape, its word and its border.
>
> The account provided (Sam) is already in a sample journey with a second sample account (Alex), so the shared
> ledger has content from both people. To see the other side, sign in with the username app-review-alex and the
> same password. Sam's private moment will not be there. Settings > Journey sharing shows who is in the journey and
> how someone new is added: everyone already in it has to agree first. Settings > History and conversations holds
> the journey's record.
>
> *In-app purchases (still to be written for Google Play):* what each one adds (room for more people, an extra
> place), that it belongs to the journey and works on every device, where to find each purchase starting from
> Sam's account (Settings > Journey sharing > Room for more people), that test purchases count only for Sam's
> account, and where Restore purchases is (Settings).
