# Privacy

Together Ledger is a relationship-resilience workspace. People may record memories, feelings, boundaries, repair requests, practical details, and conversations they want to return to. This policy explains what remains in the browser, what private sync stores, and who can see it.

## Browser-only mode

The browser stores journey details and participant display names; moments and their visibility labels; optional written and money context; conversations to return to; action milestones; preserved legacy trip and expense records; and local event history in `localStorage`. Guided check-ins do not save written answers. Nothing is automatically uploaded. Export and import happen only after an explicit user action.

## Private-sync mode

After a person creates or signs into a separate account, newly created private journeys are stored in the owner's PostgreSQL service and synchronized to authorized journey members. The service stores:

- normalized email, display name, Argon2id password hash, verification state, and pseudonymized deletion state;
- hashed session, verification, recovery, and invitation tokens with expirations;
- journey membership and shared moments, including optional details and money context;
- conversations to return to, action milestones, preserved expense records, and server-authoritative events;
- journey invitation history, including the destination email, sender identity, sent time, expiry, and accepted, pending, revoked, or expired state, visible only to authorized journey members;
- bounded technical timestamps and optimistic record versions.

Raw passwords and raw database tokens are never stored. Session cookies are HTTP-only, secure in production, same-site, and paired with an origin-bound CSRF value. The authenticated browser may retain a local snapshot cache; anyone with access to an unlocked signed-in device may see it.

Private-sync moments are visible to every authorized member of the journey. Browser-only `private` and `share later` labels are local visibility cues; they are not yet separate-account access controls.

## Event privacy

The Event Manager is shared journey data. It records bounded evidence of who acted, what kind of action occurred, and when it happened while minimizing repeated free text. Practical or preserved expense event evidence omits notes, payment-account labels, and references, and return-to event evidence does not duplicate the conversation context. Current authorized members can still read the underlying shared records.

## Email

Verification, invitation, and recovery messages are delivered through Resend using the provider-neutral SMTP adapter. Messages contain a short-lived, single-use link. Application logs must never contain raw link tokens. Email delivery necessarily exposes the destination address, message content, and routing metadata to Resend and the receiving mail system. Open and click tracking are disabled for the Together Ledger sending domain; messages are not intentionally given an open-tracking pixel or tracking-rewritten links.

## Service providers

- Resend processes transactional messages and the routing information required to deliver them.
- AWS hosts the primary private application and PostgreSQL service and processes the private-sync data handled there.
- GCP stores separately encrypted disaster-recovery backups. The backup encryption identity remains outside GCP, but restored data becomes readable to the controlled recovery environment after authorized decryption.
- GitHub Pages serves the static public application. Browser-only journey content remains in `localStorage` unless a person explicitly exports it; ordinary web hosting may still receive standard request metadata when the public files are requested.

## Deletion

Account deletion verifies the current password and revokes active sessions and tokens. Sole-owner journeys are deleted. A shared journey remains with the other journeyer, and ownership transfers if needed. The departing account is pseudonymized; a bounded event records that a member deleted their account without retaining their email.

Encrypted backups may retain deleted data until their documented retention window expires. Backups are for disaster recovery, not live querying, and restored systems must reapply deletions according to the operations procedure.

## Never place in this public repository

- Real journey, relationship, or practical records
- Passwords, session values, API keys, database URLs, or SMTP credentials
- Production backup files
- Personal email addresses
- Private service endpoints

Use synthetic records in tests, issues, screenshots, and pull requests. Read [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md) before deploying private sync.

## An honest boundary

This policy improves factual disclosure, but it does not claim attorney review or complete compliance with every jurisdiction. Retention periods, user-access and deletion rights, age and children boundaries, international processing, and the privacy contact require later legal review before they are treated as complete.
