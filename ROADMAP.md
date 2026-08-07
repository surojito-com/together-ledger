# Roadmap

## Now — safe public starter

- Local-first expense ledger
- Synthetic demo data
- Unified expense form
- Category and payer context
- Daily spending drilldown
- Conversation prompts
- JSON backup and restore
- Automated tests and public-safety scan
- Multiple local journeys and switching
- Lossless v1 → v2 browser-data migration
- Skippable onboarding and bounded guided check-ins
- Local journey-action milestones
- Honest browser-local settings
- Browser-local per-journey Event Manager with change history and concern lifecycle

## PR#0003 — private collaboration candidate

- Separate registration and login accounts with Argon2id password hashing
- Email verification, bounded sessions, recovery, logout, and deletion
- Email-bound invitations and maximum-two-member enforcement
- Private PostgreSQL journeys with version-conflict responses
- Cloud-backed expenses, concerns, and action milestones
- Server-authoritative, append-only, actor-attributed, HMAC-chained events
- One portable container for an AWS primary and GCP cold standby
- Threat model, API contract, and operations/restore gates

PR#0003 remains a candidate until production secrets, SMTP, PostgreSQL, backup restore, security review, and the full release gate pass. GitHub Pages is still browser-only.

## Next — hardening and launch

- Optional custom categories and currencies
- Recoverable archive instead of immediate deletion
- Better print and export formats
- Expanded accessibility testing
- Installable PWA metadata and icons
- Durable offline sync and explicit merge UX
- Independent security review and disaster-recovery exercise

## Later — subscription and native apps

- iOS packaging and App Store release gate
- Android packaging after the web/iOS launch exception
- Five journeys free; each additional journey requires $0.99/year
- Two journeyers included; a third-person concept remains priced at $0.49/journey but is intentionally not implemented while the product enforces the safer two-person model
- External payment processor only; accounts and journey data stay in the owner-controlled platform

## Not planned

- Relationship scores
- Hidden monitoring or notifications
- Advertising or sale of expense data
- Public leaderboards
- Using payment contribution as a proxy for love, fairness, or commitment
