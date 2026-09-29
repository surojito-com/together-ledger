# PR#0003 threat model

## Security objective

Together Ledger must let separately authenticated people share only the journeys they are authorized to access. A journey mutation and its authoritative event must commit in the same PostgreSQL transaction. Sharing a journey never means sharing a password or session.

## Protected assets

- Account email, password verifier, sessions, recovery tokens, and deletion state.
- Journey membership, invitations, budgets, expenses, concerns, milestones, and exports.
- The ordered event history used to explain who changed what and when.
- Encrypted database and backup material in AWS and GCP.
- Stripe Customer mappings, subscription and invoice state, webhook signing material, and normalized entitlements.

## Trust boundaries

```text
browser / mobile shell
        │ TLS + opaque HttpOnly session + session CSRF token
        ▼
first-party Fastify service
        │ parameterized SQL + transaction-scoped authorization
        ▼
authoritative PostgreSQL writer
        │ encrypted logical backups
        ├──────── AWS object copy
        └──────── GCP object copy
```

Payment credentials remain isolated in Stripe-hosted Checkout and Customer Portal. The service accepts signed Stripe event payloads and stores bounded billing state; it never accepts or stores raw card details. Apple or Google purchases remain separate, gated surfaces.

## Required controls

1. Passwords use Argon2id through the vetted `argon2` package. Passwords are never logged or stored.
2. Sessions are opaque 256-bit random values. PostgreSQL stores only SHA-256 token hashes. Cookies are `HttpOnly`, `Secure` in production, `SameSite=Lax`, and scoped to `/`.
3. Every state-changing request requires the session CSRF token and an allowed `Origin`.
4. Authentication and recovery endpoints are rate limited. Recovery requests return the same response whether an account exists or not.
5. Verification, invitation, and recovery tokens are random, single-use, expiration-bound, and stored only as hashes. Their email links may use only the configured public or API origin that already passed request-origin validation; arbitrary host and forwarding headers never choose a link destination.
6. Authorization is checked inside the same transaction as every read or mutation. A journey ID alone grants nothing.
7. The production-safe default allows two people. Synthetic group mode is rejected in production, and every mode enforces the unadvertised internal ceiling by counting active members plus live invitation reservations under a per-journey database lock. A shared login is prohibited.
8. Event sequence allocation is serialized per journey. The event HMAC includes the previous hash, canonical mutation data, actor ID, and timestamp.
9. PostgreSQL rejects event updates and deletes. Corrections append a new event; deletion creates a tombstone.
10. Account deletion revokes sessions/tokens, removes memberships, deletes sole-member journeys, requires deliberate ownership transfer for shared journeys, and pseudonymizes identity without rewriting immutable events.
11. Production logs exclude passwords, raw tokens, cookies, expense notes, concern text, and database URLs.
12. Production refuses to boot with development secrets, a non-TLS public origin, insecure cookies, missing audit/session secrets, or missing SMTP delivery.
13. Billing defaults off. When enabled, startup rejects a key whose test/live prefix does not match the explicit Stripe environment, and the webhook rejects an event whose `livemode` flag does not match before writing it.
14. Checkout accepts only internal offer names resolved to server-controlled Price IDs. Customer and Price IDs are not browser authority.
15. Stripe webhook signatures are verified over the raw request bytes. Event IDs are idempotency boundaries, and the success redirect never grants an entitlement.
16. Portal Session creation rechecks the named Stripe configuration against a fail-closed feature allowlist. It requires the verified journey owner, their mapped Stripe Customer, and that journey's non-terminal subscription; browser-supplied Customer, subscription, or configuration IDs are never accepted.

## Explicit limitations

- HMAC chaining is tamper-evident, not magical immutability. An attacker controlling both the database and application secrets can forge history. Secret rotation, restricted database roles, encrypted backups, restore drills, and external backup copies reduce this risk.
- Email delivery proves control of an inbox, not a person’s legal identity.
- Downloaded exports are plaintext private backups. Internal account IDs are replaced with per-export aliases, but journey content, display names, invitation metadata, and timestamps remain and require careful storage.
- The static public app origin remains browser-only; account requests cannot succeed until DNS is intentionally routed to the private service.
- No clinical, relationship-health, fairness, or financial-outcome inference is made from event history.
- Refund, dispute, tax, store-policy, and cross-provider reconciliation rules are not complete enough for live billing.

## Abuse and failure cases to test

- Account enumeration, credential stuffing, session fixation, token replay, CSRF, and origin spoofing.
- Journey-ID guessing, cross-journey expense access, role escalation, invitation reuse, and capacity races.
- Concurrent edits, duplicate event sequences, partial transaction failure, and stale optimistic versions.
- Deleted-account access, revoked-session reuse, recovery-token reuse, and export after deletion.
- Database outage, email outage, backup corruption, failed restore, and AWS-to-GCP recovery.
- Forged or replayed Stripe events, test/live crossover, arbitrary browser Price IDs, duplicate Checkout requests, missed billing events, and stale entitlements.
