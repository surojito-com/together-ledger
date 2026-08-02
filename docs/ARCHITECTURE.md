# Architecture

## Current design

Together Ledger is a static web application with no runtime dependencies and no server.

- `index.html` contains semantic page and dialog structure.
- `src/styles.css` contains the responsive visual system.
- `src/model.js` contains calculation and validation logic.
- `src/store.js` owns browser persistence and JSON backup/restore.
- `src/app.js` renders the UI and binds interactions.
- `tests/` exercises data calculations and conversation guardrails.
- `scripts/check-public-safety.mjs` blocks known household identifiers, private endpoints, and credential-shaped values.

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

## Why there is no backend

The public project must be useful without inheriting any private household service, credential, database, or deployment history. Local-first storage creates a clear safety boundary and keeps the starter easy to inspect.

## Adding a storage adapter

A future adapter should implement load, save, export, import, and delete semantics without changing calculation functions. A network adapter requires security and privacy design before implementation; “put it in a database” is not an adequate threat model.
