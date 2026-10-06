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

- **Another person.** Sam owns the sample journey, so Sam can reach the purchase for room for another person.
- **Another photo or another place on a moment.** These come one moment at a time, so the sample moments are where they are offered.
- **Paid capacity already held.** The entitlement ledger accepts a `promotion` source as well as `apple`, `google` and `stripe` (`008_stripe_web_billing.sql`). So the sample journey can hold paid capacity honestly, granted by us rather than through a faked store receipt, and the paid screens have something to show before a reviewer buys anything. How many people a journey has room for already counts an entitlement from any source (`capacityFor()` in `server/platform.js`). The billing panel and Stripe reconciliation have not yet been checked against a `promotion` grant; do that when it is built.

**Not built yet, and it blocks the first submission.** The phone has no store purchase today. It shows capacity
read only, because the work that adds it (TL-P-02 to TL-P-08 under #267, and the tier decision in #203) has not
landed. When it does, this script grows with it:

1. It grants the sample journey some `promotion` capacity, so a reviewer sees a paid state without buying.
2. It leaves room for a sandbox purchase to succeed, so a reviewer can also buy and restore.

What is granted, and how much, is decided then, against the products as they are created in both consoles (TL-P-04).

Two store rules shape this:

- **Apple 3.1.3(b).** The app may honour capacity bought on the web only if the same capacity can also be bought in the app. That is why store purchase ships before web billing goes live.
- **Restore Purchases.** It must be easy to find. A restore that finds a purchase tied to a different Together Ledger account refuses and explains, rather than moving capacity (#275).

## Notes for the reviewer

Paste this into the review notes field of each store:

> Together Ledger is a private journal that two or more people keep together. Each person holds "moments" (a
> promise, a memory, a feeling, a repair request) and chooses who sees each one: **Private** stays with them,
> **Shared now** opens it to everyone in the journey, and **Share later** waits until they deliberately share it.
> Each moment's privacy is shown by its shape, its word and its border.
>
> The account provided (Sam) is already in a sample journey with a second sample account (Alex), so the shared
> ledger has content from both people. To see the other side, sign in with Alex's email and the same password.
> Sam's private moment will not be there. Journey settings shows who is in the journey and how someone new is
> added: everyone already in it has to agree first. History and conversations holds the journey's record.
>
> *In-app purchases (to be written once the products exist, TL-P-04):* what each one adds (room for another
> person, another photo, another place), that it belongs to the journey and works on every device, where to
> find each purchase starting from Sam's account, and where Restore Purchases is.
