# Architecture

## Current design

Together Ledger is a static web application with no runtime dependencies and no server.

- `index.html` contains semantic page and dialog structure.
- `src/styles.css` contains the responsive visual system.
- `src/themes.js` is the shared 16-theme registry and pre-paint theme bootstrap.
- `src/model.js` contains calculation and validation logic.
- `src/store.js` owns browser persistence, lossless schema migration, and JSON backup/restore.
- `src/app.js` renders the UI and binds interactions.
- `tests/` exercises data calculations and conversation guardrails.
- `scripts/check-public-safety.mjs` blocks known household identifiers, private endpoints, and credential-shaped values.
- `scripts/check-themes.mjs` keeps the theme registry, CSS token blocks, browser colors, and WCAG AA contrast in sync.

## Data flow

```text
synthetic demo or imported JSON
              │
              ▼
       validated state model
          │           │
          ▼           ▼
    browser UI     localStorage
          │
          ▼
 optional JSON export
```

## Local state version 2

The browser model supports multiple journeys. Each journey owns its dates, budget, two participant display names, action milestones, and related expenses. `activeTripId` selects the current journey without moving or duplicating entries.

On first load after PR#0002, `src/store.js` reads the original `together-ledger-v1` record, migrates it to schema version 2, writes the new `together-ledger-v2` record, and leaves the legacy value untouched as a rollback copy. Old JSON exports remain importable. New exports identify schema version 2 and contain every local journey.

Onboarding completion and the selected local actor are stored as product preferences. Guided check-ins never collect or persist written answers; only three boolean action milestones may be stored per journey.

### Browser-local Event Manager

Every material local mutation appends a per-journey event with a sequence number, timestamp, selected actor display name, action, entity ID, summary, before/after snapshots, and previous-event ID. Expense deletion and concern deletion remove the current record while retaining an event tombstone. Explicit concerns are separate first-class records with open/resolved status and their own add/edit/delete events.

Event history begins when this feature is present. Migration preserves all legacy journey and expense data but does not invent actors, timestamps, or changes that the earlier schema never recorded.

This history improves traceability on one browser but is not an authoritative audit log: anyone with browser storage access can alter it. PR#0003 must move event creation into the authorized server transaction that changes PostgreSQL data. Each journeyer must use a separate account. The server event stream must be append-only, monotonically sequenced per journey, synchronized to every authorized member, preserve deletion tombstones, and use a tamper-evident hash chain or equivalent database-enforced evidence. Sharing one account is prohibited because it destroys actor attribution.

## Why there is no backend

The public project must be useful without inheriting any private household service, credential, database, or deployment history. Local-first storage creates a clear safety boundary and keeps the starter easy to inspect.

## Adding a storage adapter

A future adapter should implement load, save, export, import, and delete semantics without changing calculation functions. A network adapter requires security and privacy design before implementation; “put it in a database” is not an adequate threat model.
