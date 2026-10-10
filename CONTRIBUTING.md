# Contributing

Thank you for helping make travel-money conversations calmer and safer.

## Before you begin

1. Read the [product principles](docs/PRODUCT_PRINCIPLES.md) and [privacy model](PRIVACY.md).
2. Use synthetic names, trips, dates, receipts, and payment details.
3. Search existing issues before opening a new one.
4. For a substantial behavioral change, open an issue before writing the implementation.

## Local workflow

```bash
npm run check
npm run dev
```

Create a focused branch, make the smallest coherent change, add or update tests, and explain the user impact in the pull request.

## Product language checklist

Contributions should:

- Describe payment totals as context, not fairness or affection.
- Avoid diagnosing a relationship or assigning blame.
- Avoid assuming marriage, gender, income equality, or two-person heterosexual couples.
- Keep prompts optional and non-coercive.
- Explain data storage and network behavior plainly.

## What the app collects lives in one file

[`docs/STORE_READINESS.md`](docs/STORE_READINESS.md) holds what Together Ledger collects, where it goes, how long it is kept, and the answers to Google Play's Data Safety form and Apple's privacy labels. The privacy policy and both store forms are written from it.

**A pull request that adds a dependency that makes a network request, a permission, or a new data field updates that file in the same pull request.** That includes a new field the phone sends, a new processor, a new Android permission or iOS usage description, and any change to what deletion removes or keeps. `tests/store-readiness.test.js` fails when `package.json` or `apps/mobile/package.json` gains a dependency the file doesn't account for.

That file says what the code does; [`docs/OUTBOUND_CAPTURE.md`](docs/OUTBOUND_CAPTURE.md) checks it against what actually leaves the browser and the phone. Run it again (`scripts/capture-outbound.mjs`, both modes) on any release that adds a dependency, and the by-hand phone capture before a store submission.

## Pull request checklist

- [ ] I used only synthetic data.
- [ ] I ran `npm run check`.
- [ ] I tested keyboard and narrow-screen behavior when the UI changed.
- [ ] I updated documentation when behavior or privacy changed.
- [ ] I updated `docs/STORE_READINESS.md` if this adds a network dependency, a permission, or a data field.
- [ ] I did not add analytics, tracking, credentials, or private endpoints.
