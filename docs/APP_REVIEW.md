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

The phones launch with no purchase screen (#203, option A, decided 1 October 2026). Later they will take payment
through Apple and Google, never Stripe (#267). Until then the app shows where a journey's capacity stands, read
only, with no price and no link to pay elsewhere (#268). The sample journey has two people, which every journey
includes, so it holds no paid capacity and there is no sandbox purchase to make.

This holds only while web billing is not live. Apple 3.1.3(b) lets the app honour capacity bought on the web only
if the same capacity can also be bought in the app. That is why in-app purchase has to ship before web billing
does (#267).

When in-app purchase arrives (TL-P-05 onward), this section, the reviewer notes below and the sample journey all
change with it. Reviewers test the purchase and Restore Purchases paths (#275), so the sample journey will need a
way to show both, through a sandbox account.

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
> This version contains no purchase, subscription or payment link. Capacity is shown read only.
