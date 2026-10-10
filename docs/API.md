# First-party platform API

All endpoints are versioned under `/api/v1`. JSON responses use `{ "data": ... }` for success and `{ "error": { "code", "message" } }` for failure. Authenticated mutations require the `x-together-csrf` header returned by `GET /api/v1/session`.

A request may authenticate in one of two ways. A browser sends the `tl_session` cookie, which it attaches automatically, and proves the request came from our own page with the origin check and the `x-together-csrf` header. A client without a browser — the phone app — sends `Authorization: Bearer <token>` instead, which it attaches deliberately. Neither the origin check nor the CSRF header applies to a bearer request, because both exist to stop a hostile page from spending a cookie the browser attached on its own; a native app cannot be navigated to by a page, and a page cannot send an `Authorization` or `X-Together-Client` header cross-origin without a preflight this service grants only to its own origins. Presenting an `Authorization` header is never a way around the cookie path's requirements: a request that carries one is judged as a token, and a token this service did not issue is refused.

## Authentication and account lifecycle

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` | Create an account with a unique private username and opaque server session. |
| POST | `/auth/verify-email` | Consume the single-use email-verification token. |
| POST | `/auth/resend-verification` | Revoke an older unused verification token and send a replacement. |
| POST | `/auth/login` | Verify a private username or email plus Argon2id password, then rotate the session. |
| POST | `/auth/google`, `/auth/apple` | Verify a Google or Apple ID token and sign in, opening an account on the first sign-in. |
| POST | `/auth/link` | Link a Google or Apple sign-in to the password account that already uses its email, after that password is entered once. |
| GET | `/auth/providers` | Say which of Google and Apple the web, or a phone asking about itself, can offer, with the public identifiers it needs. No account data and no session. |
| POST | `/auth/refresh` | Spend a refresh token and return a rotated access and refresh pair. Bearer clients only. |
| POST | `/auth/logout` | Revoke the current session, or the presented bearer token and everything issued with it. |
| GET | `/session` | Return the current account, and the session CSRF token on the cookie path. The account says `hasPassword`, so a client knows whether deleting it asks for one. |
| POST | `/recovery/request` | Queue a single-use recovery link without account enumeration. |
| POST | `/recovery/confirm` | Consume the token, replace the password, and revoke every session and bearer token. |
| DELETE | `/account` | Reconfirm the password (an account opened with Google or Apple has none, so the typed `DELETE` is the whole confirmation) and permanently delete/pseudonymize the account. |

### Bearer tokens for a client without a browser

`POST /auth/register` and `POST /auth/login` return a bearer token when the client asks for one by sending `X-Together-Client: app`. The reply then carries `token`, `tokenExpiresAt`, `refreshToken`, and `refreshTokenExpiresAt` alongside the user, and no session cookie or CSRF token is issued. Without that header both endpoints behave exactly as they always have: a `tl_session` cookie plus a `csrfToken`, and no bearer token in the body. The web client does not send the header and its flow is unchanged.

The access token is short-lived (`ACCESS_TOKEN_MINUTES`, 30 by default). The refresh token lasts longer (`REFRESH_TOKEN_DAYS`, 30 by default) and is spent the first time it is used: `POST /auth/refresh` takes `{ "refreshToken": "…" }` and returns a new pair. Tokens issued together share a family. Signing out retires the whole family, so a copied access token cannot outlive the sign-out meant to end it.

A refresh token that was already spent is answered by what has happened to the pair it issued (#353, migration 031):

- **Nobody has used that pair** (neither its access token nor its refresh token has been presented to the server): the reply carrying it was most likely lost on the way back to the phone. That pair is retired and a fresh one is issued in its place, in the same family, as often as the reply is lost. Only hashes are kept, so the lost pair itself cannot be returned.
- **That pair has been used, or is gone** (renewed again, signed out, or retired): a copy is in circulation, and the whole family is retired — the safe reading is that neither holder should continue. A pair that a retry retired counts as used if it ever turns up.

Each token records when it was first presented (`used_at`) and each pair which refresh token issued it (`issued_by`). A refresh token spent before migration 031 has no pair recorded against it, so presenting it again retires its family, as before.

Only `401 invalid_token` means the refresh token was refused and the sign-in is over. A client keeps its tokens on anything else — no connection, a `5xx`, a `429` from the rate limit (120 per 15 minutes per address), or a reply that is not this API's JSON — and tries again later.

`DELETE /account` deletes every token the account holds, as it already deletes every session. Confirming a password recovery does the same. Only the SHA-256 hash of a token is stored, exactly as for verification, invitation, and recovery tokens; the raw value exists only in the reply that issued it. A token is read from the `Authorization` header and nowhere else, so it never reaches a URL, a proxy log, a browser history entry, or a referrer, and a refusal says only that the request was refused — it never repeats the token back.

### Signing in with Google or Apple

`POST /auth/google` and `POST /auth/apple` take `{ "idToken": "…", "displayName"?: "…" }`. The token's signature is checked against the provider's published keys, and its `iss`, `aud` and `exp` against what that provider documents. `aud` must be one of `GOOGLE_CLIENT_IDS` or `APPLE_CLIENT_IDS`; Apple's are the phone's App ID, `com.togetherledger.ledger`, and the web's Services ID, `com.togetherledger.ledger.web`. With no Google client ID configured, `POST /auth/google` answers `404 sign_in_unavailable`. A reply is exactly a password login's: a cookie plus `csrfToken`, or a bearer pair for `X-Together-Client: app`.

An account is found by the provider's stable user id (`sub`), never by email. The first sign-in opens an account with the private username `journeyer-` plus eight characters of its id (the same shape migration 003 gave older accounts), the provider's name or the `displayName` sent, and no password. When the email already belongs to an account, nothing is signed in or merged (decided on #214, Sep 30, 2026):

- If that account has a password, the answer is `409 link_required` with `details.email`. The client asks for that password once and sends `POST /auth/link` with `{ "provider", "idToken", "password" }`. A correct password links the provider to the account and signs in, and from then on the provider signs straight in. A wrong one is login's `401 invalid_credentials`.
- If that account has no password, the answer is `409 email_in_use`: sign in the way you did before.
- An Apple Hide My Email address never matches, so it always opens a new account.

An account without a password can't sign in with one, and asking to recover it sends nothing, exactly as for an address with no account.

`GET /auth/providers` answers `{ "google": { "clientId" } | null, "apple": { "clientId", "redirectUri" } | null }` with `Cache-Control: no-store` (#216). Google is offered once `GOOGLE_WEB_CLIENT_ID` is set: the web's own OAuth client, accepted as an audience without being repeated in `GOOGLE_CLIENT_IDS`. The phones' Google IDs never stand in for it. Apple is offered when `APPLE_SERVICES_ID` is among `APPLE_CLIENT_IDS`, `APPLE_WEB_REDIRECT_URI` is set, and both Apple secrets are set, since without them no new Apple account can open. The web shows both buttons, or neither.

A phone asks the same read about itself (#217): `GET /auth/providers?platform=ios|android&googleClientId=<client>`, where `googleClientId` is the client its Google tokens are issued to (the iOS client on an iPhone; on Android, the web client Google's library asks its token for). It answers `{ "google": { "clientId" } | null, "apple": { "clientId" } | null }`. Google is offered when that client is among the accepted audiences (`GOOGLE_CLIENT_IDS` or `GOOGLE_WEB_CLIENT_ID`). Apple is offered only to `ios`, when `APPLE_BUNDLE_ID` is among `APPLE_CLIENT_IDS` and both Apple secrets are set; Android is never offered Apple until the web flow has a Return URL that can finish there. Any other `platform` is `400 invalid_input`. Without `platform`, the answer is the web's, unchanged.

`POST /auth/apple` also takes Apple's one-time `authorizationCode`, and so does `POST /auth/link` for Apple (#218). The server exchanges it at `https://appleid.apple.com/auth/token` with a client secret signed ES256 by the Sign in with Apple key, and keeps the refresh token AES-256-GCM encrypted against the identity. A code from the web (`aud` = `APPLE_SERVICES_ID`) is exchanged with `APPLE_WEB_REDIRECT_URI` as well. A new Apple account opens only once its code has exchanged: `400` with no code, `401 invalid_token` for an expired or someone else's code, `503 sign_in_unavailable` while Apple can't be reached or the two Apple secrets aren't set. Deleting the account moves the token, still encrypted, into `apple_revocations` inside the deletion's transaction and revokes it straight after; if Apple can't be reached the server retries every ten minutes, with backoff, for up to a week.

`POST /auth/apple/notifications` takes Apple's server-to-server events, `{ "payload": "<JWT>" }` signed with Apple's ID-token keys. It needs no origin, cookie or token; an unverifiable payload is a `400`. `consent-revoked` signs the person out everywhere and drops the token. `account-deleted` deletes an account only Apple could open, through the same function and billing check as `DELETE /account`. That includes its refusals: while the person still owns a journey someone else is in, or has billing to settle, nothing changes and the refusal is logged, exactly as `DELETE /account` would refuse. The refusal is also kept on the Apple identity (`apple_account_deleted_at`, migration 026), because the container's log goes at the next release. The owner finishes it within 30 days with `server/finish-apple-account-deletion.js`, run in the app container. With no arguments it lists what is waiting. With `<accountId> --hand <journeyId>=<newOwnerId>` it hands each journey over through `transferOwnership`, then deletes through the billing check and `deleteAccount`. An account that also has a password or Google only loses its Apple identity and its sessions. `email-disabled` and `email-enabled` are acknowledged.

## Journeys, members, and sync

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/journeys` | List authorized journeys or create one. A person can be in at most 101 journeys, owned or joined; starting a 102nd answers `409 journey_limit_reached`, and nobody already past the limit loses one. |
| PATCH | `/journeys/:journeyId` | Version-check and update journey details. |
| POST | `/journeys/:journeyId/invitations` | Any journeyer proposes someone by email, `{ "email", "note" }`. Proposing is agreeing. Nothing is sent to them until everyone already in the journey agrees; in a journey of one there is nobody to ask, so the invitation goes out at once. Answers `202` with `{ proposalId, invitationSent }`. A proposal lapses after 30 days. |
| POST | `/journeys/:journeyId/invite-proposals/:proposalId/decision` | A journeyer answers, `{ "decision": "agree" \| "decline" }`. One decline settles it. The last agreement sends the invitation, which holds a place. `409 proposal_lapsed`, `proposal_closed`, `already_decided` or `journey_full` otherwise. |
| POST | `/journeys/:journeyId/invite-proposals/:proposalId/send` | Sends an agreed invitation whose mail failed, without asking anyone again. |
| DELETE | `/journeys/:journeyId/invite-proposals/:proposalId` | Whoever proposed, or the owner, withdraws an open proposal. |
| DELETE | `/journeys/:journeyId/invitations/:invitationId` | Whoever asked, or the owner, withdraws a sent invitation that is still waiting. Its link stops working and the place it held is free at once. `403` for anyone else, `409 invitation_closed` once it has been accepted, run out or been withdrawn. |
| POST | `/journeys/:journeyId/invitations/:invitationId/send-again` | Whoever asked sends an invitation that ran out again, in one step and without asking anyone again, while the proposal's 30 days last. The new link lasts `INVITATION_DAYS` from now and holds a place again. Only the newest invitation for a proposal can be sent again. `403` for anyone else; `409 invitation_waiting`, `invitation_closed`, `agreement_lapsed`, `already_member`, `invitation_exists` or `journey_full` otherwise. |
| POST | `/invitations/preview` | Reads an invitation before it is answered, `{ "token" }`, and changes nothing (#266). Answers `{ "invitation": { "state" } }`: `already_member` (with `journeyId`, `journeyName`) to anyone already in the journey; `another_account` or `verify_email`, with nothing else, unless the signed-in account is the invited address and verified; otherwise `open`, `used`, `expired`, `withdrawn` or `closed`, with `journeyName`, `invitedByDisplayName` and `expiresAt`. A code that matches nothing is `not_found`. 30 per 15 minutes. |
| POST | `/invitations/accept` | Authenticated matching account accepts one reserved place, `{ "token" }`. The path form `/invitations/:token/accept` stays for older clients. |
| DELETE | `/journeys/:journeyId/members/:userId` | Owner removes a member; the removed member cannot be the owner. |
| POST | `/journeys/:journeyId/leave` | The person signed in leaves the journey, and nobody else; the body must be `{ "confirmation": "LEAVE" }`. Their private and share-later moments here go, with their places and photos, their moment keys and the private record of those moments' visibility; their shared moments stay, still held by them. Open proposals they made and invitations they sent that are still waiting are withdrawn, and History records `member_left` with their name. The owner is refused while anyone else is here (`ownership_transfer_required`: hand it over first), a journey of one is refused (`journey_of_one`), and a web payment for this journey's room by the person, or while they own it, must end first (`billing_subscription_active`). A store subscription neither blocks it nor is cancelled by it. Someone not in the journey, including after leaving, gets `404 not_found`. |
| POST | `/journeys/:journeyId/ownership` | Owner deliberately transfers the journey to another active member. A non-terminal web subscription blocks transfer until its billing relationship is resolved. |
| GET | `/journeys/:journeyId/snapshot?after=0` | Return authorized state, membership join times, invitation history without tokens, current capacity availability, and ordered events after a sequence cursor. A full snapshot includes `eventChainValid`. Capacity reports people, live reservations, whether another invitation is allowed, and the active mode; it does not expose the internal ceiling. It also lists who is resting (`restingMemberIds`), the whole resting order for the owner only (`restOrder`, first to rest first), and `grace` whenever the journey waits on a payment: who pays, the time left, the extra weeks asked for this calendar year (at most 6), whether another can be asked for, and who can still add if it isn't paid (`keepAdding`). `grace` is told to everyone in the journey. |
| PATCH | `/journeys/:journeyId/unpaid-capacity` | Owner sets the resting order (`restOrder`, a list of journeyer ids, each once). The last person in it keeps adding with the owner if the journey stays unpaid. Resting is always read-only; `mode: 'paused'` is refused. |
| POST | `/journeys/:journeyId/grace-requests` | During any grace, the automatic 7 days included, the person who pays asks for another 7 days, starting where the grace ends, once 7 days or fewer are left, up to 6 times per journey per calendar year (UTC). A grace begins whenever paid room ends without being renewed: a web payment that fails, a web subscription the payer cancels, a store pass that runs out, or a store subscription that lapses. It lasts 7 days from the end; a subscription Stripe ends after a failed payment gets no second one. Once a grace has run out the journey rests and nothing can be asked for. Each request is in the journey's history. `403 not_payer`, `409 not_in_grace`, `409 grace_request_early`, `409 grace_requests_used` or `409 grace_request_conflict` otherwise. |

An invitation lasts `INVITATION_DAYS`, 14 by default, set apart from `TOKEN_MINUTES` (30), which verification and recovery links keep. An invitation already waiting when the lifetime changes keeps the expiry it was sent with. Only the invited email, signed in and verified, can accept one, so a longer window lets nobody else in.

Everyone in the journey sees an invited person's email masked, in invitations and proposals alike: the first letter, two `•` (U+2022), the last letter, and the whole domain, as in `s••d@gmail.com`. A name of one or two letters keeps only its first letter, as in `a••@gmail.com`. The whole address never leaves the server. Once the person joins, `joinedDisplayName` carries their name. The journeyers in a proposal are given by name only: neither `decisions` nor the proposer carries an email address. Each invitation also says `viewerMayWithdraw`, `viewerMaySendAgain` and, when it can be sent again, `sendAgainUntil`. `capacity.heldForInvitations` is true when the journey is full only because places are held for people invited.

Every step is written into the journey's history on the same hash chain, with the email masked the same way and never in full: `invite_proposed`, `invite_agreed`, `invite_declined`, `invite_proposal_withdrawn`, `invite_proposal_lapsed`, `invitation_sent`, `invitation_withdrawn`, `invitation_lapsed`, `invitation_sent_again`, then `member_joined`, which names the person as before. `invitation_sent` and `invitation_sent_again` are written once the mail has gone. Running out is worked out when an invitation or proposal is read; nothing runs at the moment it happens. The first request that notices writes the `_lapsed` entry, once, carrying the real expiry as `after.expiredAt`, with the asker as its actor. A conditional update decides which request that is: a proposal turning from `open` to `lapsed`, or an invitation's `lapse_recorded_at` being set while still empty (migration 032), so two requests noticing together never write it twice.

An unexpired invitation reserves its own place. Creating or accepting an invitation takes the journey lock so concurrent requests cannot exceed capacity. Accepting one that would be a person's 102nd journey answers `409 journey_limit_reached` and leaves the invitation waiting, as it does for a full journey. The default and production-safe mode remains two-person. `test-groups` permits synthetic 3–99 person verification outside production only; `billing` requires billing to be explicitly enabled and derives additional capacity from the current journey entitlement.

## Journey records

| Method | Path | Purpose |
|---|---|---|
| POST/PATCH/DELETE | `/journeys/:journeyId/expenses[/expenseId]` | Create, version-check, edit, or tombstone an expense. |
| POST/PATCH/DELETE | `/journeys/:journeyId/concerns[/concernId]` | Create, version-check, edit, or tombstone a concern. |
| POST/PATCH/DELETE | `/journeys/:journeyId/moments[/momentId]` | Create or mutate a private, shared-now, or share-later moment with creator-aware authorization. |
| PATCH | `/journeys/:journeyId/milestones/:key` | Set a bounded action milestone. |
| GET | `/journeys/:journeyId/events?after=0` | Read the authoritative event stream. |

## Billing: the web and the stores

Stripe billing is disabled unless the server has an explicit, mode-matched configuration. Checkout and Customer Portal Session creation require an authenticated, verified journey owner, an allowed browser origin, and the session CSRF token. Portal Sessions also require a separately enabled, allow-listed Stripe configuration that passes the approved-policy check on every request.

| Method | Path | Purpose |
|---|---|---|
| GET | `/journeys/:journeyId/billing` | For the journey owner, return the approved additional-person offer, current paid-capacity entitlement, subscription state, and recent journey invoices. Provider Customer and Price IDs are never returned. |
| POST | `/journeys/:journeyId/billing/checkout-sessions` | Create Stripe-hosted subscription Checkout for the allow-listed $1 USD monthly additional-person Price. This candidate accepts only `paidCapacity: 1`; browser-supplied amounts, other quantities, and Price IDs are rejected. |
| POST | `/journeys/:journeyId/billing/portal-sessions` | For the verified journey owner with the mapped Customer and non-terminal journey subscription, create a Stripe-hosted Portal Session. The server first verifies that the allow-listed configuration permits invoice history, payment-method updates, and cancel-at-renewal only. |
| POST | `/journeys/:journeyId/billing/store-identity` | For a signed-in, verified journeyer, return the values the phone must send to Apple (`appAccountToken`) or Google (`obfuscatedAccountId`, `obfuscatedProfileId`) when it starts a purchase, so the purchase comes back tied to this account and journey. Created once and the same ever after. See [STORE_PURCHASES.md](STORE_PURCHASES.md). |
| POST | `/billing/store-purchases/apple` | Verify a StoreKit 2 signed transaction (`signedTransaction`) on this server against Apple's root certificate, and turn it into room in its journey, or an extra photo or place on `momentId`. `201` when this request granted it, `200` when it had been granted already. See [STORE_PURCHASES.md](STORE_PURCHASES.md). |
| POST | `/billing/store-purchases/google` | Look up a Google Play purchase (`productId`, `purchaseToken`) with the Play Developer API, grant it the same way, then acknowledge it with Google. Same answers as Apple's. |
| POST | `/billing/store-notifications/apple` | App Store Server Notifications V2 (`signedPayload`), sent by Apple's servers. No origin, cookie or token: the signed payload is checked against Apple's root certificate like a purchase, and must name our bundle ID. Renewals, refunds, revocations and lapses change a journey's room through the usual grace and rest, and a reversed refund brings back what the refund took. A refunded extra photo or place keeps what was already added with it. Everything is logged once per notification, and a second delivery changes nothing. `200` when received, `400` when it does not verify or is another app's, `503` when Apple isn't configured. See [STORE_PURCHASES.md](STORE_PURCHASES.md). |
| POST | `/billing/store-notifications/google` | Google Play Real-time developer notifications, pushed by a Pub/Sub push subscription. No origin or cookie: the OIDC token Pub/Sub signs is checked for Google's signature, our audience and our push service account, and the notification must name our package. The purchase is then read again from the Play Developer API, and only Google's answer there changes a room, through the same grace and rest as Apple's. Logged once per Pub/Sub message; a second delivery changes nothing. `200` when received, `401` without our push's token, `400` when unreadable or another app's, `503` when not configured, when Google can't be reached, or when Google doesn't show a refund or revocation yet (Pub/Sub sends it again). See [STORE_PURCHASES.md](STORE_PURCHASES.md). |
| POST | `/billing/webhooks/stripe` | Verify Stripe's signature over the raw body, reject the wrong environment, and idempotently project supported events into billing records and entitlements. This route uses Stripe authentication rather than a browser session. |

Every route that opens Stripe (journey Checkout, the Portal, and the image and place Checkouts under `/moments/:momentId/`) refuses the phone app's credential with `403 not_from_the_app`, before any Stripe session is made. The app reads where capacity stands from `GET /journeys/:journeyId/billing` and never starts a web purchase; phones pay through Apple and Google instead (#267, #268). A browser session is unaffected.

The Checkout success redirect never grants access. Verified provider events update the entitlement ledger. See [STRIPE.md](STRIPE.md) for setup, event coverage, and remaining release boundaries.

`GET /journeys/:journeyId/moments/:momentId/image-slots` lists the extra photos the signed-in person has paid for on that moment, whether on the web or in a store (#272), and an upload spends one with `?paidSlotId=`.

Account deletion returns `409 billing_subscription_active` while the person pays for, or owns a journey with, a non-terminal web subscription. The billing relationship must be resolved before deletion; the service never silently leaves a recurring charge behind. Portal cancellation takes effect at renewal and does not remove an existing person, shared history, or a valid invitation reservation.

## Conflict contract

Mutable resources carry an integer `version`. A client PATCH or DELETE supplies the version it last read. A mismatch returns `409 conflict`. The client refreshes the authoritative snapshot before a person retries; silent last-write-wins is prohibited.

Moment visibility accepts `private`, `shared-now`, or `share-later`. Private and share-later records are returned and mutable only for their creator. Either creator-only state may become shared now; shared-now cannot return to a private state because access already granted cannot be revoked retroactively.

## Email adapter

Automated tests use an in-memory outbox. The deployed provider is Resend SMTP, supplied through the provider-neutral Nodemailer SMTP adapter so another relay can be adopted only after independent testing. Raw verification, invitation, and recovery tokens may appear only in the mail adapter invocation and destination message; only their SHA-256 hashes are stored and application logs must never contain them.
