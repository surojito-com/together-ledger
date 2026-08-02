# Privacy

Together Ledger is local-first by default.

## What the current app stores

The browser stores journey names, locations, dates, budgets, two participant display names, expense entries, onboarding completion, the selected local actor, three action-milestone checkboxes, explicitly logged concerns, and local change events in `localStorage` on that device. Guided check-ins do not provide a field for written answers, so private reflections are not collected. The app does not send this information to a server.

## What leaves the browser

Nothing leaves automatically. **Export all journeys** creates a JSON file only after the user clicks it. That export includes concerns and event history. Import reads only the file the user selects.

## What this repository never needs

- Real household trip records
- Passwords, passcodes, API keys, or service tokens
- Private service URLs
- Analytics identifiers
- Personal email addresses

Use synthetic data in screenshots, issues, tests, and pull requests. Before sharing a bug report, check browser screenshots and exported JSON for names, dates, locations, confirmation numbers, and payment-account details.

## Hosting caveat

Anyone can host the static app, but the resulting site is public software—not a private shared database. Browser storage remains tied to the site origin and device. Do not imply that a public deployment creates secure cross-device sync.

## Future sync

An optional sync service would require a separate threat model covering authentication, encryption, access revocation, backups, deletion, abuse, metadata leakage, and incident response. It must not be added as an invisible default.
