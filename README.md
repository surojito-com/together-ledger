# Together Ledger

**Travel money, without the tension.**

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
- Trip total, budget remaining, amount due, category mix, and payer context.
- Ledger filters for bookings, meals, transportation, and unpaid costs.
- Edit, remove, export, and import expenses.
- Day-by-day spending chart with day → category → entry drilldown.
- Data-informed five-minute check-in prompts.
- Synthetic demo data featuring Alex and Jordan—no household records.
- Local-first storage: data stays in the current browser unless the user exports it.
- Zero runtime dependencies and a built-in local development server.

## Try it locally

Requirements: Node.js 20 or newer.

```bash
git clone https://github.com/surojito-com/together-ledger.git
cd together-ledger
npm run check
npm run dev
```

Open `http://127.0.0.1:4173`.

No account, cloud database, environment variable, or API key is required.

## Privacy model

```text
browser UI
   │
   ├── localStorage (working ledger)
   ├── JSON export (user-created backup)
   └── JSON import (user-selected backup)

No analytics · No server · No account · No automatic sync
```

This makes the starter safe to explore publicly, but it also means two devices do not automatically share changes. A future encrypted sync adapter must be explicit, optional, and threat-modeled before it is added. Read [PRIVACY.md](PRIVACY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Relationship-resilience principles

1. **Facts before blame.** Show what happened without assigning moral meaning.
2. **Shared clarity over perfect accounting.** The goal is a usable common picture.
3. **Prompts, not scores.** Ask questions; never grade the relationship.
4. **Context over comparison.** Payment totals omit income, care work, planning, and preferences.
5. **Consent over surveillance.** No hidden tracking, notifications, or behavioral monitoring.
6. **Repair over punishment.** Make it easy to correct, revisit, and discuss.

The deeper rationale is in [docs/PRODUCT_PRINCIPLES.md](docs/PRODUCT_PRINCIPLES.md).

## Project status

Together Ledger is an early public prototype. The local-first expense flow is functional and tested. It is not yet a hosted multi-user service.

See [ROADMAP.md](ROADMAP.md) for the boundary between the current safe starter and possible future collaboration features.

## Contributing

Thoughtful contributions are welcome—especially accessibility fixes, privacy improvements, inclusive language, tests, and research-grounded conversation design.

Please read [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md) before opening a pull request.

## License

[MIT](LICENSE) © 2026 Surojit Ojha and contributors.
