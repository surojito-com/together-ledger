# Google Play store listing

Draft of the Play Console **Main store listing** for Together Ledger
(`com.togetherledger.ledger`), the "Store assets" part of Step 3 in the Google
Play guide. The wording follows `CLAUDE.md` ("Language", "Design system") and
`docs/PRODUCT_PRINCIPLES.md`. It describes **Together Ledger as one
product**, web and phone together, as the owner asked on Oct 6. The web has
the most features today, and they are being brought to the phone.

| Play Console field | File | Limit | Now |
|---|---|---|---|
| App name | `title.txt` | 30 | 15 |
| Short description | `short-description.txt` | 80 | 52 |
| Full description | `full-description.txt` | 4,000 | 2,010 |
| App icon (512 × 512 PNG, opaque) | `icon-512.png` | 1 MB | 11 KB |
| Feature graphic (1024 × 500 PNG) | `feature-graphic-1024x500.png` | 15 MB | 53 KB |

Store settings to enter alongside them:

- **Category:** Lifestyle is the suggestion; not decided anywhere yet.
- **Contact email:** ledger-support@together-ledger.com (the address
  `PRIVACY.md` and `TERMS.md` already publish).
- **Website:** https://together-ledger.com
- **Privacy policy:** https://app.together-ledger.com/privacy

Before pasting, run:

```
node store/google-play/check-listing.mjs
```

It checks the three lengths, emoji, superlatives and other brands' names, the
capacity words `CLAUDE.md` rules out (seats, licenses, slots, "removed"),
claims nothing in Together Ledger backs yet, and that "A journey of two is
free" and the agreement rule for adding people are still there.

## What every claim rests on

| Claim | Where it's true |
|---|---|
| Kinds of moment, a date, a place in your own words, a photo, detail, your own kind; edit or delete | `index.html` and `src/` (web), `apps/mobile/app/moment.tsx`, `src/model.js` |
| Private / Share later / Shared now, in shape, word and border | both clients; the privacy cue language in `CLAUDE.md` |
| A shared moment can't be made private again | `PRIVACY.md` |
| A check-in asks one question at a time and saves nothing written | `README.md` ("bounded one-prompt-at-a-time check-in with no saved written answers") |
| Recent moments and what wants care; return-to conversations | `apps/mobile/app/ledger.tsx`, `history.tsx`, and the web journey |
| Milestones mark shared actions, never relationship quality | `README.md` ("action milestones") |
| A history that is only ever added to | the Event Manager (web), `apps/mobile/app/history.tsx` (append-only, #184) |
| A journey of two is free; more people can be added, only when everyone agrees | `TERMS.md`; owner decision, Oct 6 |
| No ads, no analytics trackers, nothing sold | `PRIVACY.md` |
| No scores; money is context, never a score | `README.md`, `ROADMAP.md`, `moment.tsx` |
| Export all journeys | web Settings ("Export all journeys") |
| Delete your account | web Settings, `apps/mobile/app/delete-account.tsx` |
| Same account on the phone and the web | private sync for separate accounts (`README.md`) |
| Light, Dark, Green, Flexoki; your theme is only your view | both clients |
| 18 and over; not therapy, financial advice or professional support | `TERMS.md`, `PRIVACY.md`, `index.html` |

Left out on purpose, because nothing in Together Ledger does them yet:
**notifications** (#265), **offline** (#300), **encryption**, and
"seamless" sync (#186 is open and `TERMS.md` disclaims conflicts). A
**price** is left out too: only "a journey of two is free" is stated, since
live billing isn't on yet.

## Images

`icon-512.png` and `feature-graphic-1024x500.png` are rendered from
`source/*.html` by `source/render.mjs` (see its header for how to run it).
Edit the HTML, re-render, and commit both.

- **Icon:** the knot from `public/favicon.svg`, same geometry and same
  colours (#8C3A3A behind, #F3EFE6 for the knot). Full square with no
  corners or shadow, because Play adds its own. Opaque.
- **The installed icon matches it.** `scripts/render-app-icons.mjs` draws
  the phone's launcher icon (`apps/mobile/assets/icon.png`) and Android's
  three adaptive layers from the same knot, sized so it looks the same on
  the launcher as in the store, and `adaptiveIcon.backgroundColor` in
  `apps/mobile/app.json` is #8C3A3A. Change the knot in both places, or
  the two drift apart. A new icon reaches a phone only with a new build.
- **Feature graphic:** the site's social card
  (`public/social/together-ledger-card.svg`) at Play's size: "A private
  place for two people to hold what matters.", its line about moments and
  check-ins, and the moment card stack. Nothing within 48 px of an edge,
  because Play can crop.

The icon is one fixed image and doesn't follow the four in-app themes, so it
keeps the brand's original colours, as the owner chose on Oct 6. Paper and
ink are the Light theme's roles; the serif is Gelasio at weight 400 (#177)
and the rest is the system sans.

## Decided

- **Colour** (Oct 6): the knot keeps its original #8C3A3A, as on the
  website. The same hex is the in-app destructive role. That rule is about
  interface colour, and the brand mark sits outside it.
- **Two people** (Oct 6): "for two people" stays, with the line "A journey of
  two is free. You can add more people whenever you're ready" (#304).
- **Scope** (Oct 6): the listing describes the whole product, web and phone.

## Open calls for the owner

1. **Category.** Lifestyle is the suggestion; nothing decides it yet.
2. **Name.** Web search found no app called "Together Ledger" on Play (Oct 6).
   Play itself is blocked from the session that checked, so look once in
   Play Console before the first upload. There is an unrelated GitHub project
   called `together-ledger` (a shared expense tracker), not on Play.
3. **Screenshots** aren't taken yet. They must be of the real app, so they
   wait on a build. `SCREENSHOTS.md` is the shot list: seven shots of the
   review account's sample journey, what each must show and keep out, and
   the sizes Play and the App Store take.
