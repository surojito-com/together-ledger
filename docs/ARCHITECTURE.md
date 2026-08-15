# Architecture

## Two explicit operating modes

Together Ledger preserves the inspected browser-local starter while adding an authenticated private-sync service. The UI always identifies the active boundary as **Browser only**, **Account ready**, or **Private sync**.

```text
Browser-only mode                         Private-sync mode
─────────────────                         ─────────────────
UI ──► validated state ──► localStorage    UI ──► same-origin Fastify API
                  └──────► JSON export              │
                                                     ├──► PostgreSQL
                                                     ├──► SMTP relay
                                                     └──► HMAC event chain
```

Signing in never uploads an existing browser ledger. A signed-in person deliberately creates a new private journey. Cloud snapshots remain in memory and are never written into browser-only ledger storage; signing out restores the untouched local ledger. Server authorization remains the source of truth.

## Components

- `index.html` contains semantic application and account dialogs.
- `src/styles.css` contains the responsive, 16-theme visual system.
- `src/model.js` contains calculations and local validation.
- `src/store.js` owns browser persistence, migration, and JSON backup/restore.
- `src/api.js` is a configurable-origin, cookie-authenticated API client. It remains same-origin by default for the public demo and switches to `api.together.surojito.com` only when the deployment meta configuration is set.
- `src/app.js` renders both modes and maps authoritative snapshots into the established UI model.
- `server/app.js` applies origin, session, CSRF, rate-limit, cookie, and HTTP security boundaries.
- `server/platform.js` owns authorization and transactional domain operations.
- `server/migrations/` defines PostgreSQL records and append-only event protection.
- `server/security.js` owns Argon2id password hashing, opaque token hashes, CSRF derivation, and canonical HMAC events.
- `server/mailer.js` sends verification, invitation, and recovery links through an owner-configured SMTP relay.

## Account and sharing boundary

Each journeyer has a separate email/password account and a unique private username. A display name is for the shared journey; a username is for sign-in and is not shown to the other journeyer by default. Usernames are normalized, validated in the application, and unique in PostgreSQL so web, mobile, AWS, and GCP clients all receive the same answer. A journey owner sends an email-bound, hashed, expiring invitation. Acceptance requires a signed-in account with that verified email. Database authorization is repeated inside every mutation transaction; journey IDs are never treated as authority.

The application enforces a maximum of two active members per journey. Removing a member requires the owner. Sharing a login is unsupported because it destroys actor attribution.

## Concurrency and synchronization

Journeys, expenses, and concerns carry integer versions. Edits submit the version last read. A stale write receives `409 conflict`; the UI must refresh instead of silently overwriting another journeyer’s work. The snapshot endpoint returns the current journey, members, expenses, concerns, milestones, and event stream.

PR#0003 is online-first. Durable offline mutation queues and merge semantics are not claimed.

## Server-authoritative Event Manager

The same PostgreSQL transaction that changes a journey record appends its event. Per-journey advisory locking produces one monotonic sequence. Every event includes the authenticated actor, action, entity, bounded before/after evidence, previous hash, and HMAC hash. PostgreSQL rejects event update and deletion; the only exception is a transaction-local flag used to purge a sole-owner journey during required account deletion.

Expense event snapshots intentionally omit notes, payment-account labels, and references. Concern event snapshots record whether context existed, not its text. This retains an undebatable change trail without duplicating the most sensitive free text indefinitely.

HMAC chaining is tamper-evident, not absolute immutability. A party controlling the database and HMAC secret could forge a chain. Secret isolation, encrypted cross-cloud backups, restricted roles, restore drills, and external evidence are still required.

## Deletion behavior

Deletion verifies the password and revokes sessions and account tokens. A sole-member journey is purged. For a shared journey, ownership passes to the remaining member, the departing membership is removed, and a privacy-bounded deletion event remains. The deleted user row is pseudonymized so historical actor identifiers do not become dangling personal email records.

## Deployment

The application is one portable container backed by standard PostgreSQL. AWS is the low-volume primary writer; GCP is a cold standby restored from separately encrypted cross-cloud backups. This avoids unsafe dual writes and keeps the system operable by one owner. See [OPERATIONS.md](OPERATIONS.md).

The existing GitHub Pages build remains a static browser-only deployment until DNS is intentionally moved to the authenticated service. A PR merge alone must never be represented as activating private sync.
