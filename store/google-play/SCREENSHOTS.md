# Phone screenshots: shot list

The store screenshots for Together Ledger, so they are taken once and taken
right. The same seven shots serve Google Play and the App Store. They tell the
story in the order someone meets it: the journey, who can see each moment,
holding one, both people's moments, who is in the journey, its history, and
where privacy and help live.

Every shot is the **real phone app** (`apps/mobile`), signed in as the review
account. No web version, no mock-ups, nothing drawn on top. Both stores ask
for the app as it is actually used: Play says screenshots "must demonstrate
the actual in-app or in-game experience", and Apple's guideline 2.3.3 asks
for the app in use rather than title art or a sign-in screen.

## Before you start

- **Rebuild the sample journey first.** Run `server/seed-review-journey.js`
  as `docs/APP_REVIEW.md` describes ("Sample journey: Sam and Alex"). Its
  dates are counted back from the day it runs, so the journey looks recent,
  and every shot below expects exactly what it makes.
- **Sign in as Sam**, the reviewer account. Everything below is Sam's view.
  Sam sees seven of the nine moments: the five shared now, and Sam's own
  private and share-later ones. Alex's private and share-later moments are
  never on Sam's screen, which is the point.
- **Nobody real in frame.** The only names on screen should be
  **Sam (sample)**, **Alex (sample)** and **Sample journey: Sam and Alex**.
  The sample accounts' email addresses must not appear: keep the Account
  screen and Journey sharing's **Invitation history** (it reads "Invitation
  sent to" Alex's address) out of every shot. The two company addresses under
  Settings → Privacy and help are public (`PRIVACY.md` publishes them) and
  may show.
- **Theme per shot,** as listed below. Change it in Settings → Appearance and
  pick the theme by name, never "Match this phone", so a shot doesn't change
  with the phone's own setting. A theme changes only your view; the moments
  that carry their own theme (Alex's Green and Flexoki cards) look the same
  in all four.
- **Clean status bar:** full battery, Wi-Fi on, no carrier name, no other
  apps' notifications. Play asks for exactly this.
  - Android: System UI demo mode, or clear the shade and charge first.
  - iPhone Simulator: `xcrun simctl status_bar booted override --time 9:41
    --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4
    --operatorName ""`.
- **Keyboard down, no toast, nothing half-scrolled.** Wait for a toast such
  as "Dark applied." to fade before shooting.
- **Change nothing in the journey.** Shot 3 is taken from a form that is
  then cancelled. If anything is saved by accident, rerun the seed script.

## The seven shots

### 1. The journey

- **Screen:** the ledger (title "Ledger").
- **How to reach it:** sign in; the ledger opens. Scroll to the very top.
- **On screen:** "Your shared space", **Sample journey: Sam and Alex** in the
  serif with its dates under it, "Our shared journey", **Recent moments**,
  "Hold what happened in words that feel true.", the **＋ Hold a moment**
  button, and the top of the first moment card. "Settings" in the header.
- **Theme:** Light.
- **Caption:** A private place for two people to hold what matters.

### 2. The privacy cue

- **Screen:** the ledger, scrolled.
- **How to reach it:** from shot 1, scroll down until the three recent cards
  fill the screen.
- **On screen:** the three cards, newest first, each with its cue in shape,
  word and border:
  - ◐ **Share later**: "What I want to say about Sunday", with its **Share
    now** and **Edit** buttons;
  - ○ **Private**: "Tired more than angry";
  - ● **Shared now**: "Splitting the boiler repair", with its practical money
    context folded shut.
  
  All three cues must be fully in frame, and all three read "Held by Sam
  (sample)".
- **Theme:** Light.
- **Caption:** Every moment shows who can see it: private, share later, or shared now.

### 3. Holding a moment

- **Screen:** Hold a moment (opens as a sheet).
- **How to reach it:** from the ledger, tap **＋ Hold a moment**. Choose
  **Promise**, leave **When** as today, and type the short name **Sunday
  mornings are ours** and the detail **No plans before ten. Coffee, and
  whatever the day turns into.** Under Visibility, choose **◐ Share later**.
  Dismiss the keyboard and scroll so **Visibility** is at the top of the
  screen.
- **On screen:** the three visibility choices with Share later marked
  "Chosen", the line "Private stays with you. Shared now opens it to everyone
  in this journey…", and, below, the **Live preview** card showing the moment
  with its Share later cue. If the preview doesn't fit beneath Visibility on
  the phone you use, Visibility wins: keep all three choices and their help
  line whole.
- **Afterwards:** tap **Cancel**. Do not hold it.
- **Theme:** Light.
- **Caption:** Choose whether it stays with you, is shared now, or waits until you are ready.

### 4. Both people's moments

- **Screen:** the ledger, every moment.
- **How to reach it:** switch to Dark in Settings → Appearance, go back to
  the ledger and tap **See all 7 moments**. Scroll past the moment-type
  choices to Alex's two cards.
- **On screen:** **Talking about my dad's visit** (Alex's, in its own Green
  card, "⌖ Kitchen table") and **Thank you for driving to the station**
  (Alex's, in its own Flexoki card), both "● Shared now" and "Held by Alex
  (sample)", with Sam's "Call before the late shift" between them. The page
  around them is Dark; the cards keep the themes Alex
  chose for them.
- **Theme:** Dark.
- **Caption:** Moments from both of you, in the words that felt true. Your theme is only your view.

### 5. Journey sharing

- **Screen:** Journey sharing.
- **How to reach it:** Settings → This journey → **Journey sharing**. Stay at
  the top.
- **On screen:** the line under the title ("2 people are here. … Each person
  signs in separately."), then the **Journey record**: **Created by Sam
  (sample)**, tagged Owner · You, and **Alex (sample) joined the journey**,
  tagged Journeyer. If the journey has room for another person, "Propose a
  journeyer" shows above it with "Everyone already in this journey has to
  agree before anything is sent"; keep that line in frame if it is there.
- **Keep out:** **Invitation history**, further down. It shows Alex's email
  address. Stop scrolling before it.
- **Theme:** Light.
- **Caption:** Someone new joins only when everyone already in the journey agrees.

### 6. History and conversations

- **Screen:** "Sample journey: Sam and Alex history".
- **How to reach it:** Settings → This journey → **History and
  conversations**.
- **On screen:** **Return-to conversations** with **How we split the
  weekends** (Open) and **Dishes left overnight** (Resolved), and the start of
  **Recorded changes** below them, rows showing "#… · …" with who made each
  change and when.
- **Keep out:** an opened change row. Opening one shows event ids and hashes,
  which mean nothing in a store image. Leave every row folded.
- **Theme:** Flexoki.
- **Caption:** Conversations to come back to, and a history that is only ever added to.

### 7. Settings: Privacy and help

- **Screen:** Settings.
- **How to reach it:** tap **Settings** in the ledger's header, choose
  Green under Appearance, then scroll to the bottom.
- **On screen:** **Privacy and help** with the **Privacy policy** button and
  the line naming ledger-support@together-ledger.com and
  legal@together-ledger.com. Above it, **Account** with **Delete account**,
  and as much of **This journey** (Journey sharing, History and
  conversations) as fits.
- **Theme:** Green.
- **Caption:** The privacy policy is in the app, and your account is yours to delete.

Optional 8th, for Play only (Play takes up to 8, Apple up to 10): the
**Privacy policy** screen itself, opened from shot 7, at its first heading.
Caption: No ads, no analytics trackers, and nothing sold.

## Keep out of every shot

- **Email addresses of the sample accounts**: the Account screen,
  Invitation history, and "Who was asked, and when" under a proposal.
- **Any sign-in, registration or recovery screen.** It shows an address
  being typed, and neither store wants a login screen as a screenshot.
- **Opened history rows** (ids and hashes), and the **Delete account**
  confirmation.
- **Any system dialog**: permission prompts, the photo picker, the share
  sheet. A dialog from the system or another app would read as ours.
- **Capacity and payment screens.** In-app purchase isn't built yet
  (`docs/APP_REVIEW.md`, "Paying, for a reviewer"), and the listing states no
  price. If "This journey's capacity" or "If the payment lapses" shows on
  Journey sharing, keep it below the frame.
- **Error or "could not" states,** "Loading…", and an empty ledger.

## Sizes

### Google Play: phone

Checked 8 Oct 2026 against Play Console Help, [Add preview assets to
showcase your app](https://support.google.com/googleplay/android-developer/answer/9866151):

- 2 to 8 screenshots, JPEG or 24-bit PNG with no alpha.
- Each side 320 to 3,840 px, and the long side no more than twice the short
  one.
- For promotion in Play's recommendation formats: at least four app
  screenshots, 9:16 portrait, at least 1080 × 1920.
- Alt text up to 140 characters per screenshot. The captions above are
  written to be it.

So the set is **1080 × 1920 PNG**, as #324 says. Take them on an **Android
phone**, from a build of the app. Most phones shoot taller than 9:16 (1080 ×
2400 is 20:9, which Play refuses), so send the raw files and they're cropped
to 1080 × 1920 here, nothing added. The crop loses about a fifth of the
height, so keep what each shot must show out of the bottom fifth of the
screen.

### App Store: iPhone

Checked 8 Oct 2026 against App Store Connect Help, [Screenshot
specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications):

- 1 to 10 screenshots per display size, `.jpeg`, `.jpg` or `.png`, no alpha
  or transparency.
- **Required:** "At least one screenshot for iPhone with Dynamic Island
  (medium display)." Accepted portrait sizes: **1206 × 2622** (iPhone 17,
  17 Pro, 16 Pro, 18 Pro) or **1179 × 2556** (iPhone 16, 15, 15 Pro, 14 Pro).
- Smaller iPhone sizes are scaled down from it by App Store Connect.
- The same page's row for **iPhone with Face ID (large display)** still says
  "Required if app runs on iPhone and screenshots for iPhone with Dynamic
  Island (large display) aren't provided". The page's own "Required device
  sizes" list doesn't include it, so the two disagree. If App Store Connect
  asks for the large display at upload, take the same set at **1320 × 2868**
  (iPhone 17 Pro Max, 16 Pro Max) and upload that too.

So the set is **1206 × 2622 PNG**, taken on an iPhone 17 or 17 Pro, or in
the Simulator for one, from a build of the app. Both give the exact size
with no cropping or scaling; upload them as they come. iPad isn't needed:
v1 is iPhone only (`supportsTablet: false` in `apps/mobile/app.json`).

Android and iPhone shots are taken separately, each on its own platform.
Neither set is resized from the other.

## After

Send the raw files over, or drop them in `store/google-play/screenshots/`
and `store/app-store/screenshots/`. They'll be cropped where Play needs it,
checked against this list (sample names only, no email address, every cue
fully in frame), committed, and added to the Book.
