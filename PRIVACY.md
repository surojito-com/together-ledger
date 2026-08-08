# Privacy

Together Ledger exposes its storage boundary instead of making a hidden choice for the user.

## Browser-only mode

The browser stores journeys, participant display names, budgets, expenses, milestones, explicit concerns, and local change events in `localStorage`. Guided check-ins never provide a written-answer field. Nothing is automatically uploaded. Export and import happen only after an explicit user action.

## Private-sync mode

After a person creates or signs into a separate account, newly created private journeys are stored in the owner's PostgreSQL service and synchronized to authorized journey members. The service stores:

- normalized email, display name, Argon2id password hash, verification state, and pseudonymized deletion state;
- hashed session, verification, recovery, and invitation tokens with expirations;
- journey membership, budget, expenses, milestones, explicit concerns, and server-authoritative events;
- bounded technical timestamps and optimistic record versions.

Raw passwords and raw database tokens are never stored. Session cookies are HTTP-only, secure in production, same-site, and paired with an origin-bound CSRF value. The authenticated browser may retain a local snapshot cache; anyone with access to an unlocked signed-in device may see it.

## Event privacy

The Event Manager is shared journey data. Expense event evidence excludes notes, payment-account labels, and references. Concern event evidence does not duplicate the concern context text. Current authorized members can still read the live expense and concern records themselves.

## Email

Verification, invitation, and recovery require an owner-configured SMTP relay. Messages contain a short-lived, single-use link. Application logs must never contain raw link tokens. Email delivery necessarily exposes the destination address and message routing metadata to the relay and receiving mail system.

## Deletion

Account deletion verifies the current password and revokes active sessions and tokens. Sole-owner journeys are deleted. A shared journey remains with the other journeyer, and ownership transfers if needed. The departing account is pseudonymized; a bounded event records that a member deleted their account without retaining their email.

Encrypted backups may retain deleted data until their documented retention window expires. Backups are for disaster recovery, not live querying, and restored systems must reapply deletions according to the operations procedure.

## Never place in this public repository

- Real household trip or relationship records
- Passwords, session values, API keys, database URLs, or SMTP credentials
- Production backup files
- Personal email addresses
- Private service endpoints

Use synthetic records in tests, issues, screenshots, and pull requests. Read [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md) before deploying private sync.
