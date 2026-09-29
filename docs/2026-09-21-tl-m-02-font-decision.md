# Font decision — #177 (TL-M-02)

**Status: decided.** The owner delegated the choice rather than making it at the comparison, so it was
made on the reasoning below. **It was not made by looking** — nobody has yet seen Georgia and Gelasio side
by side on a device that has Georgia. That was the acceptance criteria's preferred route and this decision
did not take it, which is recorded here rather than glossed.

That makes the decision deliberately cheap to revisit. Until TL-M-03 ships the swap, reversing it is a
one-token change; the comparison page is checked in beside this file for exactly that purpose. If it looks
wrong on a real screen, say so and it changes.

## Decision

**Bundle Gelasio** (SIL OFL 1.1) as the heading/moment-title/brand serif across web, iOS, and Android,
replacing Georgia everywhere rather than per-platform. This is option 1 from the issue: a bundled font
file, not a webfont in the sense the old "no webfont" rule meant.

## Why

### The argument that settled it

This is a product for two people sharing one journey. They read the same moments, on whatever phones they
each happen to own, and then talk to each other about them. A brand that renders one way on an iPhone and
another way on an Android is not an inconsistency in this product — it is a seam running down the middle
of the thing two people are meant to be sharing. That is a stronger objection here than it would be in a
single-user app, and it is what rules out accepting the platform serif per OS, whatever that option saves.

Once cross-platform consistency is the requirement, one face has to be bundled everywhere, and the
question becomes only *which*.

### Why Gelasio, among the faces that could be bundled

Georgia does not exist on Android and silently falls back to Roboto there today, losing the one
typographic choice the product actually makes. Of the candidates compared (Gelasio, Charter/Charis SIL,
Source Serif 4, Literata, Noto Serif, Tinos, PT Serif, Bitter, Crimson Pro — see the full research below),
Gelasio is the only one that:

- **Is claimed to be metric-compatible with Georgia** for Regular/Bold/Italic/Bold Italic, by both Google's
  own font description and the designer's (SorkinType) README — which also explains the mechanism ("to
  remain a functional match to Georgia, Gelasio will not include kerning"), and scopes the claim to those
  four styles only. **This claim was not independently verified and could not be**: confirming it means
  diffing per-glyph advance widths against Georgia's own binary, and Georgia is proprietary Microsoft
  software with no legal source available in this environment. What was checked directly is that Gelasio's
  `unitsPerEm` is 2048, matching the value Georgia is documented as using. Treat metric compatibility as a
  well-sourced claim with an explained mechanism, not as a measured fact — and see "If the metric claim is
  wrong" below for what it would cost if it doesn't hold. (Metric compatibility would not make glyph
  outlines identical in any case — see "What this does not fix" below.)
- **Reproduces Georgia's old-style (text) figures by default.** This was verified directly by extracting
  digit glyph bounding boxes from the font: 0/1/2 sit at x-height, 6/8 rise to ascender height, and
  3/4/5/7/9 dip below the baseline — the same pattern documented for Georgia. Every other candidate tested
  ships lining figures by default (old-style only as an opt-in `onum` feature, where available at all).
  Georgia's numerals are part of its character, especially for dates and money in this product, so this
  matters more than it sounds.
- **Is the smallest or tied-smallest file of every candidate tested.** A static instance is ~107 KB;
  Regular + Bold + Italic as three static TTFs for Expo/`expo-font` comes to ~315 KB total. The web build
  (Latin-only WOFF2, regular + bold + italic) is ~75 KB total. Every non-Gelasio candidate that could carry
  the old-style option at all was 2×–15× larger, mostly because they carry Cyrillic/Greek/extended-Latin
  coverage this product doesn't need.
- **Is free to bundle.** SIL OFL 1.1, confirmed from `google/fonts`' own `OFL.txt` for Gelasio. Bundling in
  a commercial iOS/Android app is permitted; OFL only forbids selling the font file by itself and reserves
  the name "Gelasio" for the original project. No runtime attribution is required — keeping the license
  file alongside the bundled font is the standard OFL practice.

Rejected the other two options in the issue:

- **Platform serif per OS** (Georgia on iOS, `serif`/Noto Serif on Android) costs nothing, but it locks in
  a permanent, visible mismatch between platforms — different x-height, different numeral style — rather
  than fixing the actual problem, which is that the brand currently has no real answer on Android at all.
- **Change the face everywhere to something not tied to Georgia** (Source Serif 4, Literata, etc.) pays the
  full cost of a typeface swap — new metrics, full Playwright visual-snapshot regeneration, a genuinely
  different personality — without Gelasio's layout-safety property, for a face that measured no closer to
  Georgia's proportions than Gelasio did. There's no candidate in the set that's a better visual match to
  Georgia than the one purpose-built to be a match.

## What this does not fix

Metric compatibility protects layout, not pixels. Gelasio and Georgia share advance widths and line
height, but they are different outlines — SorkinType's own description: "Georgia is simpler and warmer,
Gelasio is a bit stricter and more sophisticated." Every existing Playwright visual-snapshot baseline that
includes serif text will still show a diff once Gelasio is wired up, and will need regenerating. Gelasio
removes the reflow/truncation risk a non-compatible swap would carry; it does not make the snapshot
regeneration free. TL-M-03 should budget for that pass explicitly.

## License

SIL Open Font License 1.1. Copyright 2022 The Gelasio Project Authors
(https://github.com/SorkinType/Gelasio). Verified against `ofl/gelasio/OFL.txt` and `METADATA.pb` in
`google/fonts`. Permits bundling in a commercial app; forbids selling the font file on its own and reserves
the "Gelasio" name. No runtime attribution required.

## File size

- Web (self-hosted WOFF2, Latin subset): Regular ≈ 34.8 KB, Italic ≈ 40.1 KB — **≈ 75 KB** for the weight
  range 400–700 plus italic in two files.
- Mobile (`expo-font`, static TTF instances — React Native does not reliably honor a variable font's `wght`
  axis on `<Text>` today): Regular (400) ≈ 107.6 KB, Bold (700) ≈ 107.9 KB, Italic (400) ≈ 107.9 KB —
  **≈ 315 KB** total for the three weights this product actually uses.
- A genuine variable font (`wght` 400–700) also exists as a single file per style, ≈ 165–170 KB, if a
  future platform target can use variable fonts directly.

## Rendered comparison

[`2026-09-21-tl-m-02-font-comparison.html`](./2026-09-21-tl-m-02-font-comparison.html) — Georgia against
all five candidates (Gelasio, Lora, Source Serif 4, Noto Serif, Charis SIL), set in the product's own
strings at the real sizes, weights and letter-spacing from `src/styles.css`: brand mark, heading, section
heading, moment title, and numerals. One self-contained file, no network, no build step. Weight and
tracking toggles, per the findings above.

Georgia is proprietary and cannot be embedded, so it is the one face on the page that depends on your
device. **The page measures whether Georgia is actually present and says so before you start comparing** —
open it on a Mac or an iPhone and it will confirm you are seeing real Georgia; open it on Android and the
banner will tell you you are looking at the fallback, which is the bug this issue is about, demonstrated
rather than described. The checked-in preview PNG
([`2026-09-21-tl-m-02-font-comparison-preview.png`](./2026-09-21-tl-m-02-font-comparison-preview.png)) was
rendered on Linux and shows that warning state — it is **not** evidence of Georgia's look.

The other candidates are embedded as subsets covering only the specimen characters — 13–33 KB each, which
says nothing about a shipped bundle size. Measure the real file before recording a number.

## Two things the comparison turned up that change the question

Both were found by a parallel session on this issue and then measured here directly. Neither was known
when the choice above was made, and both affect how the candidates read.

**The stylesheet asks for a weight Georgia does not have.** `src/styles.css` sets `font-weight: 500` in
14 places, 10 of them on Georgia rules. Georgia ships Regular and Bold only, so the browser rounds down
and **every heading has been rendering at 400 all along**. Measured in Chromium against the embedded
subsets: Georgia and Charis SIL do not move between `font-weight: 400` and `500` (identical advance
widths); Gelasio, Lora, Source Serif 4 and Noto Serif all do, because all four are variable fonts with a
real 500. So adopting any variable candidate makes every heading *slightly heavier than today* unless
`font-weight` moves to 400 in the same change. Some of what looks like "this face is heavier" is that,
not the typeface — the comparison page now defaults to 400 and lets you toggle, so the two effects can be
told apart.

This also means **the first version of this comparison was unfair to Gelasio**: it embedded a true
500-weight Gelasio instance against Georgia rounding to 400, so Gelasio looked heavier for a reason that
had nothing to do with its design. That page has been replaced.

**The tracking is tuned to Georgia.** `h1, h2` carries `letter-spacing: -0.035em`, which suits Georgia's
wide proportions and reads tight on a narrower face. It needs re-testing per candidate, not carrying
over. The comparison page has a toggle for this too.

## What was verified, and what was not

Georgia itself could not be obtained — it is proprietary Microsoft software, absent from this Linux
environment, with no legal download. **Every statement below about Georgia's own metrics comes from
secondary typography sources, not from a file anyone here inspected.** That shapes what can honestly be
claimed:

| Claim | Status |
|---|---|
| Gelasio's default numerals are old-style (0/1/2 at x-height, 6/8 ascending, 3/4/5/7/9 descending) | **Measured** — digit glyph bounding boxes extracted from the binary with `fontTools` |
| Every other candidate ships lining figures by default | **Measured** — same method, each binary downloaded and checked |
| Licences (all candidates OFL 1.1; Gelasio © 2022 The Gelasio Project Authors) | **Verified** — `OFL.txt` and `METADATA.pb` read from `google/fonts` |
| File sizes, variable-font axes, x-height/cap-height ratios | **Measured** — from the downloaded binaries |
| Gelasio is metric-compatible with Georgia | **Not verified** — two aligned primary claims (Google's description, SorkinType's README) plus a matching `unitsPerEm` of 2048. No advance-width diff was possible without Georgia's binary |
| Georgia's own numeral pattern, x-height and `unitsPerEm` | **Secondary sources only** — FontLab documentation, typography references. Not inspected directly |
| Noto Serif ships as stock Android's `serif` | **Secondary sources only** — AOSP's `fonts.xml` was unreachable from this environment. Also an AOSP-default statement, not a guarantee across OEM skins |
| Charis SIL's metrics and numerals | **Secondary sources only** — its binary was unreachable (SIL's host blocked); licence was verified from its repo |

## If the metric claim is wrong

Worth stating plainly, because the decision leans on it. If Gelasio turns out not to be
advance-width-identical to Georgia, nothing breaks silently — the failure is visible and bounded: text
reflows, line counts shift, and any truncation or overflow tuned to Georgia's widths needs a look. That is
the same cost as picking any other candidate in the table, all of which make no compatibility claim at all.
So the claim being wrong would cost the *advantage* Gelasio is being recommended for, not add a new risk on
top. The cheapest way to settle it before committing: set a paragraph in both faces at the same size on a
machine that has Georgia and compare where the lines break.

## Why the runners-up lost

- **Noto Serif** is the only candidate already present on stock Android, which looks like its whole
  argument — until consistency requires bundling a single face everywhere anyway, at which point its
  513 KB static weight is the largest of the set and the advantage has evaporated entirely.
- **Charis SIL** has the best pedigree argument in the list: Matthew Carter drew both it and Georgia. But
  it is 800 KB–1.7 MB for a single weight, carrying linguistics-grade diacritic coverage this product will
  never use. That is disqualifying in a mobile bundle. It is also the only candidate besides Georgia with
  no real 500, which is either a neat inheritance of Georgia's behaviour or an irrelevance, and either way
  does not outweigh the size.
- **Lora, Source Serif 4, Literata** are good screen serifs and would be defensible in a product that had
  never used Georgia. Here they pay the full cost of a typeface change — new metrics, full snapshot
  regeneration, a visibly different personality — while landing no closer to Georgia than the face
  purpose-built to match it, and losing the old-style figures on the way.
- **Tinos, PT Serif, Bitter, Crimson Pro** were measured and ruled out on the evidence in the table below:
  Tinos clones Times rather than Georgia, Bitter is a near-monoweight slab with a visibly heavier colour,
  Crimson Pro's x-height is the smallest of the set, and PT Serif carries Cyrillic bulk for no benefit.

## What TL-M-03 needs to do with this

**Set the serif rules to `font-weight: 400`, not 500.** This is the one that will be got wrong by doing
the obvious thing. `font-weight: 500` appears fourteen times in `src/styles.css`, ten of them on serif
rules, and Georgia has always rounded those down to 400 — so 400 is what the design was drawn against and
what every committed snapshot records. Gelasio is variable with a real 500, so a faithful-looking
port that preserves the `500` would silently make every heading in the product heavier than it has ever
been, and the diff would look like it changed nothing. Change them to 400.

**Re-check `letter-spacing: -0.035em` on `h1, h2`** against Gelasio instead of carrying it over. It was
tuned to Georgia's wide proportions.

**Expect the visual snapshots to need regenerating regardless.** There are 11 under
`tests/browser-welcome.spec.js-snapshots` and `tests/browser-moment-visual-matrix.spec.js-snapshots`.
Metric compatibility protects layout, not pixels — see "What this does not fix" above.

Out of scope here, but for the record: Georgia is currently hardcoded as `font-family: Georgia, "Times New
Roman", serif` (or `Georgia, serif`) in ~15 places in `src/styles.css` plus the SVG social card — there is
no font-family custom property today. TL-M-03 should introduce one (e.g. `--font-serif: "Gelasio", Georgia,
"Times New Roman", serif` — Georgia stays in the fallback chain, harmless, and is still what an old
browser/OS without the bundled font loaded would show), self-host the WOFF2 files for web rather than
hot-linking `fonts.gstatic.com`, and regenerate the Playwright visual snapshots.

## Research

Full candidate-by-candidate research (metric compatibility, x-height/contrast, numerals, license, file
size, platform availability — each verified against primary sources: `METADATA.pb`/`OFL.txt` from
`google/fonts`, and `fontTools` run directly against the downloaded binaries) is recorded in this issue's
resolving discussion. Summary table:

| Candidate | Metric-compat. w/ Georgia | Default numerals | License | Variable font | Static weight ≈size | Stock on Android/iOS |
|---|---|---|---|---|---|---|
| **Gelasio** | **Claimed** (not verified — see above) | **Old-style** (measured) | OFL 1.1 | Yes, 400–700 | ~107 KB | No / No |
| Charis SIL | No | Lining | OFL 1.1 | No | 800 KB–1.7 MB | No / No |
| Source Serif 4 | No | Lining | OFL 1.1 | Yes, wght+opsz | ~330 KB | No / No |
| Literata | No | Lining | OFL 1.1 | Yes, wght+opsz | ~271 KB | No / No |
| Noto Serif | No | Lining | OFL 1.1 | Yes, wght+wdth | ~513 KB | Android (secondary source) / No |
| Tinos | No (clones Times, not Georgia) | Lining only | OFL 1.1 | No | ~520–600 KB | No / No |
| PT Serif | No | Lining only | OFL 1.1 | No | ~340–360 KB | No / No |
| Bitter | No | Lining | OFL 1.1 | Yes, wght | ~202 KB | No / No |
| Crimson Pro | No | Lining | OFL 1.1 | Yes, wght | ~108 KB | No / No |
