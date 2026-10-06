# Google Play store listing

Draft of the Play Console **Main store listing** for Together Ledger
(`com.togetherledger.ledger`), the "Store assets" part of Step 3 in the Google
Play guide. The wording follows `CLAUDE.md` ("Language", "Design system") and
`docs/PRODUCT_PRINCIPLES.md`, and describes the **phone app** as it is on
`main`, not the web app.

| Play Console field | File | Limit | Now |
|---|---|---|---|
| App name | `title.txt` | 30 | 15 |
| Short description | `short-description.txt` | 80 | 66 |
| Full description | `full-description.txt` | 4,000 | 2,052 |
| App icon (512 × 512 PNG, opaque) | `icon-512.png` | 1 MB | 11 KB |
| Feature graphic (1024 × 500 PNG) | `feature-graphic-1024x500.png` | 15 MB | 52 KB |

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
claims the phone can't back yet, and that the lines keeping the listing
honest are still there.

## What every claim rests on

| Claim | Where it's true |
|---|---|
| Kinds of moment, a date, a name, detail, your own kind; edit or delete | `apps/mobile/app/moment.tsx`, `src/model.js` |
| Private / Share later / Shared now, in shape, word and border | `apps/mobile/app/moment.tsx`, the privacy cue language in `CLAUDE.md` |
| A shared moment can't be made private again | `PRIVACY.md` |
| Recent moments and what wants care | `apps/mobile/app/ledger.tsx` |
| Return-to conversations; a history that is only ever added to | `apps/mobile/app/history.tsx` (append-only, #184) |
| Two people to begin with; someone new joins only when everyone agrees | `TERMS.md`, `apps/mobile/app/journey-settings.tsx` |
| No ads, no analytics, no crash reporting, nothing sold | `PRIVACY.md`, `README.md`, no SDK in `apps/mobile/package.json` |
| Doesn't ask for location, contacts, camera, microphone or photos | No such module in `apps/mobile/package.json` |
| Sign-in kept in the phone's secure storage | `PRIVACY.md`, `expo-secure-store` |
| No scores; money is context, never a score | `apps/mobile/app/moment.tsx` ("never counted as a score"), `ROADMAP.md` |
| Delete your account in the app | `apps/mobile/app/delete-account.tsx` |
| Light, Dark, Green, Flexoki; your theme is only your view | the welcome screen, `apps/mobile/src/theme/` |
| A journey is started on the web for now | `apps/mobile/app/ledger.tsx` empty state |
| Photos and export are on the web for now | #187; `PRIVACY.md` (export is in browser Settings) |
| 18 and over; not therapy, financial advice or professional support | `TERMS.md`, `PRIVACY.md`, `index.html` |

Left out on purpose:

- **"For two people" as a fixed promise.** #304 is still open. The listing
  uses `TERMS.md`'s form, which is accurate either way.
- **Check-ins.** They're web-only.
- **Notifications** (#265), **offline** (#300), **invite links** (#266),
  **phone sign-in with Google or Apple** (#217), **sync** (#186) and
  **encryption**.
- **Any price or purchase.** The phone has none (#318, #320), and Play
  doesn't allow pointing to payment elsewhere.

## Images

`icon-512.png` and `feature-graphic-1024x500.png` are rendered from
`source/*.html` by `source/render.mjs` (see its header for how to run it).
Edit the HTML, re-render, and commit both.

- **Icon:** the knot from `public/favicon.svg`, same geometry, on the accent.
  Full square with no corners or shadow, because Play adds its own. Opaque.
- **Feature graphic:**
  - Left: the app's welcome headline, "Keep what matters, together.", with
    its line underneath minus "for two people".
  - Right: a moment card stack echoing the site's social card.
  - Nothing within 48 px of an edge, because Play can crop.

Colours are the Light theme's roles (`src/styles.css`,
`apps/mobile/src/theme/tokens.json`). The serif is Gelasio at weight 400
(#177) and the rest is the system sans.

## Open calls for the owner

1. **The icon's colour.** The knot on the website (`public/favicon.svg`,
   `public/social/together-ledger-card.svg`) is still filled with `#8C3A3A`.
   That hex is now the **destructive** role, and `CLAUDE.md` keeps it for
   what can't be undone, so this icon uses the accent `#1F5257` instead. If
   that's right, the favicon and social card should follow, as a separate
   change.
2. **"Two people" or "people"** (#304). Once decided, the headline line and
   "A journey holds two people to begin with" may change.
3. **Category.** Lifestyle is suggested and not decided.
4. **The app's own icon is still Expo's placeholder.**
   `apps/mobile/assets/icon.png`, the adaptive icon layers and
   `adaptiveIcon.backgroundColor` (`#E6F4FE`) are Expo's defaults. Play
   expects the store icon to match the launcher icon, so they need this
   design before the first upload. That's a separate change.
5. **Screenshots** (at least two phone screenshots) aren't part of this
   draft. They must be of the real app, so they wait on a build. The reviewer
   account (#319) holds a journey already lived in, which would make good
   ones.
