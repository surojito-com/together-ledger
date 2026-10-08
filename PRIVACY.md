# Privacy

Effective 8 October 2026.

Together Ledger is a relationship-resilience workspace. People may record memories, feelings, boundaries, repair requests, practical details, places, photos, and conversations they want to return to. This policy explains what stays in your browser, what our private service stores, who can see it, who else handles it, how long it is kept, and what you can ask of us.

## Who we are

Together Ledger is made by Together Ledger Digital LLC, registered in Macon, Georgia, United States. We decide how the information described here is used. For anything about your privacy or your data, write to legal@together-ledger.com. For help using the product, write to ledger-support@together-ledger.com.

## Who Together Ledger is for

Together Ledger is for adults aged 18 and over. We do not knowingly collect information from anyone younger. If we learn that an account belongs to someone under 18, we delete it.

## Browser-only mode

Without an account, the browser stores journey details and participant display names; moments and their visibility labels; places, including any device location you choose to add; optional written and money context; conversations to return to; action milestones; preserved legacy trip and expense records; and local event history, all in `localStorage`. Guided check-ins do not save written answers. Nothing is uploaded to us. Export and import happen only when you choose them. Anyone who can use that browser can see what it holds, and clearing the browser's site data deletes it.

## Private-sync mode

After you create an account and start a private journey, that journey is stored in our PostgreSQL service and synchronized to the people in it. The service stores:

- your email address, username, display name, an Argon2id hash of your password, whether your email is verified, and, after deletion, the pseudonymized state described under Deletion;
- if you sign in with Apple or Google, the identifier that company gives us for you, as described under Signing in with Apple or Google;
- hashed session, sign-in, verification, recovery, and invitation tokens, each with an expiry;
- journey membership and moments, including who created each one, its visibility, optional details, and money context;
- places attached to moments. A place is either words you type or, only when you press Use my device location, the latitude, longitude, and accuracy your device reports at that moment. We never read your location in the background;
- photos you attach to moments, up to 25 MB each, with their original file name and type. When you remove a photo, the most recently removed one for that moment is kept until another is removed or the moment is deleted;
- conversations to return to, action milestones, preserved expense records, and the journey's event history;
- invitation history, including the destination email, sender, sent time, expiry, and accepted, pending, revoked, or expired state;
- proposals to add someone, including the proposed email address, any note, and each journeyer's answer. A proposal lapses after 30 days if it is not agreed. Nothing is sent to the proposed person unless everyone already in the journey agrees;
- membership and billing records if you pay for another person, another place, or an extra photo, as described under Payments;
- technical timestamps and record versions.

Raw passwords and raw tokens are never stored. On the web, session cookies are HTTP-only, secure, same-site, and paired with an origin-bound CSRF value, and a signed-in session lasts up to 7 days. The phone app keeps its sign-in keys in the phone's secure keychain; its access key lasts 30 minutes and is renewed with a key that lasts up to 30 days. Email links for verification and recovery expire after 30 minutes. A signed-in browser may keep a local copy of what it last loaded; anyone with access to an unlocked signed-in device may see it.

## Who can see what

In private sync, a `private` or `share later` moment is returned only to the account that created it. A `share later` moment becomes visible to the other people in the journey only after its creator deliberately changes it to `shared now`. A moment that has been shared cannot be made private again, because access that has already happened cannot be undone. Places and photos follow the visibility of the moment they belong to. Invitation history and proposals are visible to the people in the journey. In browser-only mode, `private` and `share later` are reminders on one device, not separate-account access controls.

The Event Manager is shared journey data. Private and share-later moments do not enter that shared stream or reveal their existence to anyone else. Their creator-only visibility changes are recorded separately without moment text. When a moment is deliberately shared, the shared stream records the change without copying its title or detail. After that, each time a shared moment is added, changed, or deleted, the stream records its title, kind, date, places (with any coordinates), and money context as they were, but never its written detail. Those records stay in the journey's history even after the moment is deleted. Practical or preserved expense events omit notes, payment-account labels, and references, and return-to events do not duplicate the conversation. The people in a journey can still read the underlying shared records.

We do not sell your information, share it for advertising, or use it to build profiles. We add no advertising or analytics trackers to Together Ledger.

## Email

Verification, invitation, proposal, and recovery messages are sent through Resend. Verification, invitation, and recovery messages contain a short-lived, single-use link. Sending email necessarily shows the destination address, message content, and routing details to Resend and to the receiving mail system. Open and click tracking are turned off for the Together Ledger sending domain; messages carry no tracking pixel and no tracking-rewritten links.

## Signing in with Apple or Google

If you choose to sign in with Apple or Google, that company tells us an identifier it keeps for you, your email address and whether it has been verified, and, from Google, your name. If you use Apple's Hide My Email, we receive the relay address Apple makes for you instead of your own. We store the identifier, so we can recognise you next time. With Apple, we also keep a token Apple gives us, encrypted, so we can tell Apple to end the link when you delete your account. Apple or Google learns that you are signing in to Together Ledger; their own privacy policies apply to what they do with that, at [apple.com/legal/privacy](https://www.apple.com/legal/privacy/) and [policies.google.com/privacy](https://policies.google.com/privacy).

## Payments

Payments for another person, another place, or an extra photo are processed by Stripe. Stripe receives your email address, the payment details and any billing details you enter on Stripe's own page, and internal reference numbers for your account, the journey, and the moment the payment is for. We never see or store your full card number. We store the Stripe customer and subscription references, what was bought, and its status, so the capacity you paid for works and so billing can be reconciled. Stripe keeps its own payment records as the law requires of it; its privacy policy is at [stripe.com/privacy](https://stripe.com/privacy).

Purchases made in the iPhone or Android app are processed by Apple or Google. Apple or Google receives the payment; we receive their record of what was bought, which we keep with your account and the journey or moment it was for, so the room or extra you paid for works. We never see your card or store account details. Their privacy policies are at [apple.com/legal/privacy](https://www.apple.com/legal/privacy/) and [policies.google.com/privacy](https://policies.google.com/privacy).

## Server logs

When your browser or phone talks to our service, our servers record the time, the request method and address, the response status and time taken, and the network address the request came from. We use these logs only to run, debug, and secure the service, and to re-apply account deletions if we ever restore from a backup. Passwords, cookies, and sign-in headers are removed from logs, and so are the one-time codes in invitation, verification and recovery links. Logs rotate automatically on the server and older entries are overwritten; they are not sent to any analytics or logging company.

## Service providers

These companies handle information for us, only to provide Together Ledger:

- Amazon Web Services hosts the private service and its PostgreSQL database, in the United States.
- Google Cloud stores separately encrypted disaster-recovery backups. The key that decrypts them is kept outside Google Cloud.
- Cloudflare runs our domain names and serves the public application at `app.together-ledger.com`, and receives the standard request details any website receives, such as your network address and browser.
- Resend delivers email, as described above.
- Stripe processes payments, as described above.
- Apple and Google, if you choose to sign in with them, as described above.

If you use Together Ledger from outside the United States, your information is transferred to and processed in the United States, where these providers operate.

## How long we keep it

We keep your account and your private journeys for as long as your account exists. Email links expire after 30 minutes, web sessions after 7 days, and invitation proposals lapse after 30 days. Browser-only data stays in your browser until you clear it.

Encrypted backups are made daily and each is deleted 30 days after it is made; deletion from storage can take up to a further day. Backups are for disaster recovery only and are never searched or used for anything else. If we ever have to restore from a backup, we first re-apply every account deletion made after that backup was taken, so a deleted account does not come back.

## Deletion

You can delete your account in Settings after confirming your password. If you own a journey that other people are still in, you first hand it to one of them; the product will not strand it. If you pay for capacity, that payment must end first.

Deleting your account revokes your sessions and tokens, removes any link to Apple or Google sign-in and asks Apple to end its token, and deletes: journeys only you were in; your private and share-later moments, with their places and photos; your private visibility history; and invitations you sent. Pending invitations to your email are revoked. Your account is pseudonymized: your email, username, and name are replaced, your password hash is removed, and the account shows as Deleted account.

What stays, because it already belongs to a shared journey: moments you had shared, with their places and photos, stay with the other people in that journey, and the journey's history records that a member deleted their account. The history also keeps what it recorded about the moments you shared, including their titles and places, as described under Who can see what, even for a moment you deleted first. The email address you were invited at stays in the journey's invitation history, and in any proposal to add you, where the people in the journey can still see it. Expenses you paid for show Deleted account as the payer. Proposals and billing records stay as part of the journey's history. Stripe keeps its own records of past payments.

Deleted data leaves our backups within the backup period above.

## Your choices and rights

You can see, correct, and download your information in the product: edit your moments and profile, and use Export all journeys in Settings to download a file of the journeys open in that browser. You can delete your account at any time. You can also write to us to ask for a copy of the information we hold about you, to correct or delete it, to object to or limit how we use it, or to ask any question about this policy. We will answer within 30 days, and we will not treat you differently for asking. If you are in the European Union, the United Kingdom, or another place with a data-protection authority, you can also complain to that authority.

## Changes to this policy

When this policy changes, we update the date at the top of this page and keep the earlier versions in the public history of this policy at [github.com/together-ledger-digital-llc/together-ledger](https://github.com/together-ledger-digital-llc/together-ledger/commits/main/PRIVACY.md).

## Never place in this public repository

- Real journey, relationship, or practical records
- Passwords, session values, API keys, database URLs, or SMTP credentials
- Production backup files
- Personal email addresses
- Private service endpoints

Use synthetic records in tests, issues, screenshots, and pull requests. Read [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md) before deploying private sync. Before changing what this policy says, check it against the code: server/platform.js, server/billing.js, server/identity.js, server/apple.js, server/config.js, server/start.js, and scripts/backup-postgres.sh.

## An honest boundary

This policy has not been reviewed by a lawyer. It describes what the product actually does, checked against its code, and it will be corrected wherever it falls short.
