# Working in this repository

Read this before doing anything else. Most of it exists because it was got wrong at least once.

## The only local repository to work in

```
/Users/neo/together-ledger-digital-llc/together-ledger
```

Its remote is `https://github.com/together-ledger-digital-llc/together-ledger.git`. That is the
company home, and it is the one that ships.

**Do not work in `/Users/neo/Codex/together-ledger`.** It is a separate clone pointed at
`https://github.com/surojito-com/together-ledger.git` — a personal account that predates the LLC.
Work committed there does not reach production and does not belong to the company. If you find
yourself in it, stop and move.

Other clones exist on this machine (`together-ledger-llc/together-ledger-llc`,
`together-ledger-stripe-test`). They are not this product. Check `git remote get-url origin`
before your first commit if there is any doubt.

## Branches

**Never put `agent` or `claude` in a branch name.** This is a standing instruction from the owner
and it is not negotiable, regardless of what existing branches look like — several of them are
wrong and predate the rule.

Name the branch after the change, as a short sentence in kebab-case:

```
let-a-proposal-read-as-a-question
let-unpaid-capacity-rest-without-losing-history
```

Branch from `origin/main`, never from whatever happens to be checked out.

## Worktrees

Put them under the repository, not beside it:

```
git worktree add .claude/worktrees/<short-name> -b <branch> origin/main
```

Sibling directories (`/Users/neo/together-ledger-<something>`) have accumulated across sessions,
most of them on abandoned `agent/*` branches. Do not add to that. Remove your worktree when the
branch merges:

```
git worktree remove .claude/worktrees/<short-name>
```

**Leave the main checkout on `main`.** It is shared. If you find it on someone else's branch with
uncommitted work, leave that work alone — make your own worktree and say something. Never
`git checkout`, `git stash`, or `git restore` across another session's changes.

## Before you open a pull request

```bash
npm run check          # public-safety scan, theme gate, syntax, smoke, 120 unit tests
npx playwright test    # 27 browser tests, including visual and token contracts
```

Both must pass. `npm run check` includes the theme gate, which fails on an undefined custom
property, a contrast pair below WCAG AA, or a destructive colour too close in hue to the accent.

## Verifying a release

The release gate proves the assembled bundle is the reviewed revision **without touching the
network** (`scripts/verify-release-bundle.mjs`). This is deliberate. Cloudflare Bot fight mode
correctly refuses automated traffic, and a gate that needs that protection weakened would
eventually get it turned off. Four separate wrong diagnoses were published before the real cause
was found, so:

- Do not add a network call to the gate.
- `scripts/check-public-availability.mjs` runs on a schedule and separates `down`, `drift` and
  `refused`. Only the first two are worth alerting on. It must never become a gate — a test
  asserts it has no `workflow_run:` trigger.

**Confirm a delivery against production, not against the workflow.** Fetch `release.json` and the
shipped asset and check the change is actually in them. A green workflow is a claim, not evidence.

## Design system

The foundations are settled and should be used, not re-litigated: seventeen semantic colour roles
across four themes (Light, Dark, Green, Flexoki), the radius scale, a 44px minimum target, the
consequence-dialog pattern, the persistent status region, the empty-state shape, and the privacy
cue language of shape plus word plus border.

Two rules that have each been broken already:

- **Use the semantic role, never a palette alias.** A `--red` alias pointed at `--destructive`,
  got borrowed for labels and selections, and ended up meaning destruction on the page and the
  accent inside a moment card. It is retired. Do not reintroduce that shape.
- **The destructive colour is only for what cannot be undone.** Waiting, needing payment, and
  pausing are not failures and never take it.

Fonts are a serif (headings, moment titles, brand) plus the system sans stack. This is permanent.
Georgia alone was not: it does not exist on Android, where it fell back to Roboto and took the brand with
it. The serif is **Gelasio** (SIL OFL 1.1), bundled as a font file on web, iOS and Android alike, with
Georgia kept in the CSS fallback chain. Decided on #177 — reasoning, licence, file sizes and the rendered
comparison are in `docs/2026-09-21-tl-m-02-font-decision.md`.

Two things travel with that decision and are not optional:

- **The serif renders at weight 400, not 500.** `font-weight: 500` appears fourteen times in
  `src/styles.css`, ten of them on serif rules, and Georgia — having only Regular and Bold — has always
  rounded those down. 400 is what the design was drawn against and what every committed screenshot shows.
  Gelasio is variable and has a real 500, so carrying the 500 across would quietly restyle every heading
  heavier than it has ever been. Set those rules to 400.
- **`letter-spacing: -0.035em` on `h1, h2` was tuned to Georgia's proportions.** Re-check it against
  Gelasio rather than carrying it over on faith.

"Do not add a webfont" still stands for what it always meant: no `@font-face` pulling from a CDN at
runtime. A bundled, self-hosted font file is not a webfont in that sense, and this line never forbade one.

## Language

Capacity is "another person" or "another place" — never seats, licenses, or slots. Nobody is
"removed" for non-payment; capacity **rests**. Read the surrounding copy before adding to it; this
product's voice is careful on purpose.

## Commits and pull requests

End commit messages with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

End pull request descriptions with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Squash-merge with the PR title as the subject (`gh pr merge <n> --squash --subject "<title>"`),
so `main` keeps its sentence-case history. Omitting `--subject` takes the branch commit's subject
instead, which has already put one kebab-case line into the log.

Say what actually happened. If tests fail, show the output. If a step was skipped, say so.
