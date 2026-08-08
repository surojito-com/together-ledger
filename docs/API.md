# First-party platform API

All endpoints are versioned under `/api/v1`. JSON responses use `{ "data": ... }` for success and `{ "error": { "code", "message" } }` for failure. Authenticated mutations require the `x-together-csrf` header returned by `GET /api/v1/session`.

## Authentication and account lifecycle

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` | Create an account and opaque server session. |
| POST | `/auth/verify-email` | Consume the single-use email-verification token. |
| POST | `/auth/resend-verification` | Revoke an older unused verification token and send a replacement. |
| POST | `/auth/login` | Verify Argon2id password and rotate the session. |
| POST | `/auth/logout` | Revoke the current session. |
| GET | `/session` | Return the current account and session CSRF token. |
| POST | `/recovery/request` | Queue a single-use recovery link without account enumeration. |
| POST | `/recovery/confirm` | Consume the token, replace the password, and revoke every session. |
| DELETE | `/account` | Reconfirm the password and permanently delete/pseudonymize the account. |

## Journeys, members, and sync

| Method | Path | Purpose |
|---|---|---|
| GET/POST | `/journeys` | List authorized journeys or create one. |
| PATCH | `/journeys/:journeyId` | Version-check and update journey details. |
| POST | `/journeys/:journeyId/invitations` | Owner creates a hashed, expiring invitation token. |
| POST | `/invitations/:token/accept` | Authenticated matching account accepts one seat. |
| DELETE | `/journeys/:journeyId/members/:userId` | Owner removes a member; the removed member cannot be the owner. |
| GET | `/journeys/:journeyId/snapshot?after=0` | Return authorized state and ordered events after a sequence cursor. A full snapshot includes `eventChainValid`. |

## Journey records

| Method | Path | Purpose |
|---|---|---|
| POST/PATCH/DELETE | `/journeys/:journeyId/expenses[/expenseId]` | Create, version-check, edit, or tombstone an expense. |
| POST/PATCH/DELETE | `/journeys/:journeyId/concerns[/concernId]` | Create, version-check, edit, or tombstone a concern. |
| PATCH | `/journeys/:journeyId/milestones/:key` | Set a bounded action milestone. |
| GET | `/journeys/:journeyId/events?after=0` | Read the authoritative event stream. |

## Conflict contract

Mutable resources carry an integer `version`. A client PATCH or DELETE supplies the version it last read. A mismatch returns `409 conflict`. The client refreshes the authoritative snapshot before a person retries; silent last-write-wins is prohibited.

## Email adapter

Automated tests use an in-memory outbox. Production must provide an authenticated SMTP URL; AWS SES SMTP is one compatible primary option. Raw verification, invitation, and recovery tokens may appear only in the mail adapter invocation and destination message; only their SHA-256 hashes are stored and application logs must never contain them.
