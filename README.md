# Together Ledger

**A private shared journey workspace for two people to hold what happened, return to what matters, and make room for repair.**

Together Ledger is a local-first relationship-resilience tool. It offers a gentle timeline for promises, acknowledgments, triggers, missed chances, heart-to-heart talks, memories, feelings, boundaries, repair requests, and the practical things people navigate together.

> A shared journey cannot measure love. No moment, practical detail, or open thread becomes a score of effort, care, or commitment.

## Why this exists

Together Ledger makes a different set of questions possible:

- What happened, in words that feel true?
- What would feel good to acknowledge?
- Is there an open thread worth returning to with care?
- What practical context belongs inside this moment, if any?

This is not couples therapy, financial advice, surveillance software, or a relationship score. It is a neutral surface for a better conversation.

## What works today

- A gentle **Our shared journey** timeline for moments, current check-ins, recent memories, and open threads.
- Moment types for promises, acknowledgments, triggers, missed chances, heart-to-heart talks, memories, feelings, boundaries, repair requests, and practical matters.
- Per-moment visibility cues: **private**, **shared now**, or **share later**.
- Optional practical money context inside a moment; no money totals, budgets, balances, cash-flow view, or spending dashboard.
- Multiple browser-local journeys with creation and switching that never mixes records.
- Lossless migration of original trip and expense records into preserved practical-context moments.
- Edit, remove, export, and import local journey records.
- Skippable onboarding and a bounded, one-prompt-at-a-time check-in with no saved written answers.
- Per-journey action milestones that describe shared actions—not relationship quality.
- Honest local settings for themes, full backup/restore, and demo reset.
- A visible Event Manager under every journey for locally attributable moment, thread, milestone, and practical-detail changes, including deletion tombstones.
- All 16 Surojito brand themes, with a global switcher that persists the user’s choice.
- Synthetic demo data featuring Alex and Jordan—no household records.
- An explicit browser-only mode that never uploads existing local journey data.
- PR#0003 private-sync foundation: separate accounts, verified-email invitations, PostgreSQL journeys, recovery, deletion, conflict protection, and server-authoritative HMAC-chained events.
- A portable container and active/passive AWS-primary/GCP-standby operations plan.

## Try it locally

Requirements: Node.js 22 or newer.

```bash
git clone https://github.com/surojito-com/together-ledger.git
cd together-ledger
npm run check
npm run dev
```

Open `http://127.0.0.1:4173` for browser-only mode.

No account, cloud database, environment variable, or API key is required for browser-only mode. To exercise private sync, use the container procedure in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Brand themes

Every current surface—navigation, hero, cards, timeline, dialogs, forms, footer, and mobile action bar—uses the same theme tokens as `surojito.com`.

| Light themes | Dark themes |
|---|---|
| Light | Dark |
| Catppuccin Latte | Solar Red |
| Flexoki | Green |
| Rosé Pine Dawn | Catppuccin Mocha |
| Kanagawa Lotus | Tokyo Night |
| Primer Light (GitHub) | Kanagawa Wave |
| Ayu Light | Amber |
| Tokyo Night Day | Rosé Pine |

The selected theme is saved in the browser and restored before the page paints.

## Privacy model

```text
browser-only                         private sync
────────────                         ────────────
UI → localStorage                    UI → same-origin API
   → explicit JSON export               → PostgreSQL
                                          → append-only event chain
```

The public static deployment remains safe to explore without an account. Its account screen states plainly when the protected service is unavailable; it never sends a name, email, or password to GitHub Pages. Signing in never uploads existing browser journey data. Private sync is an explicit mode for newly created hosted journeys and is not production-ready until the operational release gate passes. **Browser-only visibility is a local cue, not separate-account privacy.** Per-moment visibility authorization will be added to the private service before it is presented as private cloud sharing. Read [PRIVACY.md](PRIVACY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

The Event Manager remains browser-local in browser-only mode. The private-service candidate creates events inside the authorized PostgreSQL mutation transaction and chains them with HMAC evidence. HMAC chaining is tamper-evident, not magically immutable; deployment secret isolation and backup controls still matter.

## Relationship-resilience principles

1. **Facts before blame.** Hold what happened without assigning moral meaning.
2. **Shared clarity over perfect accounting.** The goal is a usable shared journey.
3. **Prompts, not scores.** Ask questions; never grade the relationship.
4. **Context over comparison.** Practical context can matter without becoming a total, ranking, or debt.
5. **Consent over surveillance.** No hidden tracking, notifications, or behavioral monitoring.
6. **Repair over punishment.** Make it easy to correct, revisit, and discuss.

The deeper rationale is in [docs/PRODUCT_PRINCIPLES.md](docs/PRODUCT_PRINCIPLES.md).

## Project status

Together Ledger is an early public prototype. Browser-only journeys are live. The PR#0003 branch contains a tested private-service candidate, but it is not a production multi-user claim until SMTP, cloud PostgreSQL, cross-cloud backup restoration, independent review, and DNS cutover pass.

The next public home is planned as `together-ledger.com`; the present Surojito address remains live until that migration is checked with care. See [docs/DOMAIN_MIGRATION.md](docs/DOMAIN_MIGRATION.md) for the safe cutover sequence and [ROADMAP.md](ROADMAP.md) for the boundary between the current safe starter and possible future collaboration features.

## Contributing

Thoughtful contributions are welcome—especially accessibility fixes, privacy improvements, inclusive language, tests, and research-grounded conversation design.

Please read [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md) before opening a pull request.

## License

[MIT](LICENSE) © 2026 Surojit Ojha and contributors.
