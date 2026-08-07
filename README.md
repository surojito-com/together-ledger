# Together Ledger

**A shared trip ledger for two people to see every cost, discuss surprises, and decide what happens next.**

Together Ledger is a local-first travel expense tracker designed as a relationship-resilience tool. It turns spending into a shared picture and offers calm conversation prompts before ambiguity becomes resentment.

> A ledger cannot measure love. Who paid more is context for planning—not a score of effort, care, or commitment.

## Why this exists

Many expense trackers answer “where did the money go?” Together Ledger also asks:

- Do both people have the same information?
- Is anything still due or unexpectedly over budget?
- What question would help us talk about this without blame?
- Which expense created the most joy, ease, or connection?

This is not couples therapy, financial advice, surveillance software, or a relationship score. It is a neutral surface for a better conversation.

## What works today

- One unified **Add expense** flow for flights, hotels, meals, rides, activities, shopping, and other costs.
- Multiple browser-local journeys with creation and switching that never mixes trip records.
- Lossless migration from the original single-journey browser schema.
- Trip total, budget remaining, amount due, category mix, and payer context.
- Ledger filters for bookings, meals, transportation, and unpaid costs.
- Edit, remove, export, and import expenses.
- Day-by-day spending chart with day → category → entry drilldown.
- Skippable onboarding and a bounded, one-prompt-at-a-time check-in with no saved written answers.
- Per-journey action milestones that describe shared actions—not relationship quality.
- Honest local settings for themes, full backup/restore, and demo reset.
- A visible Event Manager under every journey for locally attributable expense, budget, milestone, and concern changes, including deletion tombstones.
- All 16 Surojito brand themes, with a global switcher that persists the user’s choice.
- Synthetic demo data featuring Alex and Jordan—no household records.
- An explicit browser-only mode that never uploads an existing local ledger.
- PR#0003 private-sync foundation: separate accounts, verified-email invitations, PostgreSQL journeys, recovery, deletion, conflict protection, and server-authoritative HMAC-chained events.
- A portable container and active/passive AWS-primary/GCP-standby operations plan.

## Try it locally

Requirements: Node.js 20 or newer.

```bash
git clone https://github.com/surojito-com/together-ledger.git
cd together-ledger
npm run check
npm run dev
```

Open `http://127.0.0.1:4173` for browser-only mode.

No account, cloud database, environment variable, or API key is required for browser-only mode. To exercise private sync, use the container procedure in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Brand themes

Every current surface—navigation, hero, cards, charts, ledger, dialogs, forms, footer, and mobile action bar—uses the same theme tokens as `surojito.com`.

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

The public static deployment remains safe to explore without an account. Signing in never uploads the existing browser ledger. Private sync is an explicit mode for newly created hosted journeys and is not production-ready until the operational release gate passes. Read [PRIVACY.md](PRIVACY.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

The PR#0002 Event Manager remains browser-local in browser-only mode. PR#0003 creates events inside the authorized PostgreSQL mutation transaction and chains them with HMAC evidence. HMAC chaining is tamper-evident, not magically immutable; deployment secret isolation and backup controls still matter.

## Relationship-resilience principles

1. **Facts before blame.** Show what happened without assigning moral meaning.
2. **Shared clarity over perfect accounting.** The goal is a usable common picture.
3. **Prompts, not scores.** Ask questions; never grade the relationship.
4. **Context over comparison.** Payment totals omit income, care work, planning, and preferences.
5. **Consent over surveillance.** No hidden tracking, notifications, or behavioral monitoring.
6. **Repair over punishment.** Make it easy to correct, revisit, and discuss.

The deeper rationale is in [docs/PRODUCT_PRINCIPLES.md](docs/PRODUCT_PRINCIPLES.md).

## Project status

Together Ledger is an early public prototype. Browser-only journeys are live. The PR#0003 branch contains a tested private-service candidate, but it is not a production multi-user claim until SMTP, cloud PostgreSQL, cross-cloud backup restoration, independent review, and DNS cutover pass.

See [ROADMAP.md](ROADMAP.md) for the boundary between the current safe starter and possible future collaboration features.

## Contributing

Thoughtful contributions are welcome—especially accessibility fixes, privacy improvements, inclusive language, tests, and research-grounded conversation design.

Please read [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md) before opening a pull request.

## License

[MIT](LICENSE) © 2026 Surojit Ojha and contributors.
