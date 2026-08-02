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

## Pull request checklist

- [ ] I used only synthetic data.
- [ ] I ran `npm run check`.
- [ ] I tested keyboard and narrow-screen behavior when the UI changed.
- [ ] I updated documentation when behavior or privacy changed.
- [ ] I did not add analytics, tracking, credentials, or private endpoints.
