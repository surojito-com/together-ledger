# Domain migration runbook

Together Ledger is moving from the legacy Surojito subdomain to its own domain:

| Surface | Canonical address |
| --- | --- |
| Company site | `https://together-ledger.com` |
| Running web app | `https://app.together-ledger.com` |
| Company site alias | `https://www.together-ledger.com` |
| Protected API | `https://api.together-ledger.com` |
| Journey invitations | `Together Ledger - 010 Journey Invite <journey-invitation@together-ledger.com>` |
| Email verification | `Together Ledger - 020 Email Verification <account-verification@together-ledger.com>` |
| Password recovery | `Together Ledger - 030 Password Reset <account-recovery@together-ledger.com>` |
| Legacy sender fallback | `Together Ledger <no-reply@together-ledger.com>` |

`https://together.surojito.com` is a legacy address. Do not redirect it until the canonical public app and protected API have separately passed the synthetic-account release checks.

During the hostname rollout, the legacy app address and `https://app.together-ledger.com` may serve the same frontend build at the same time. `APP_ORIGINS` is the explicit comma-separated allowlist for that temporary dual-host phase.

## Safe order of work

1. Claim `together-ledger.com` in the account that will actually serve it before creating any DNS record. This prevents an unclaimed-domain takeover. The apex is served by the company site from the separate `together-ledger.com` repository, so the claim belongs there and not to this repository.
2. In Cloudflare, add the `app` record for `app.together-ledger.com` to the same frontend deployment that serves the current app. Do not add a wildcard record.
3. Wait for the new certificate, enable HTTPS enforcement, and verify the app loads at both the legacy app address and `app.together-ledger.com`.
4. Set `PUBLIC_ORIGIN` and `ACCOUNT_ORIGIN` to `https://app.together-ledger.com`, and set `APP_ORIGINS` to the legacy app origin during the parallel phase. Verify the API accepts both exact origins with credentials.
5. Configure the sending domain in Resend. Production uses authenticated SMTPS at `smtp.resend.com:465`. Keep Resend's isolated `send` return-path subdomain separate from human root-domain inbox routing, and publish the exact DNS-only return-path MX, SPF, and DKIM records shown for the domain in Resend; never copy account-specific values from an example. A Resend return-path MX may point to an Amazon SES hostname and its SPF may include `amazonses.com`. Those are provider infrastructure details and do not mean Together Ledger directly uses SES. Open and click tracking are currently disabled. Add a tracking-subdomain CNAME only after tracking is deliberately enabled and the privacy policy is updated. Do not claim Proton inbound mail is live until the root-domain MX is independently verified.
6. Wait for Resend to verify every required sending-domain record, then test delivery of an invitation, verification message, and recovery message with synthetic accounts from both app origins.
7. After the private PostgreSQL and application checks pass, create a DNS-only `api` record pointing to the stable AWS address. Configure Caddy for `api.together-ledger.com`, open only TCP 80 and 443, and verify TLS plus `/healthz` and `/readyz`.
8. Set the public build's `together-api-origin` meta value to `https://api.together-ledger.com` only after the complete synthetic lifecycle passes: registration, email verification, invitation, recovery, deletion, and restore.
9. Finally, deploy the company site at the apex and use a Cloudflare redirect rule for the legacy app address that preserves the path and query string while sending visitors to `https://app.together-ledger.com`. Use a permanent redirect only after checks on both addresses pass.

## Checks with care

- The apex and `www` addresses resolve to the company site with HTTPS, and the content served on the public DNS path is the company site's own — an HTTP 200 alone does not show which origin answered.
- The old Surojito address continues to work until the new public address is confirmed.
- API DNS is not created until private service readiness and synthetic account checks succeed.
- PostgreSQL and the application port remain unpublished; only Caddy receives public web traffic.
- Resend's return-path, SPF, and DKIM records remain DNS-only; human root-domain mail routing is checked separately.
- The three purpose-specific senders deliver successfully through Resend before real invitations are enabled.
- No credential value enters Git, shell history, or chat.
- A backup and isolated restore with synthetic data succeeds before real invitations are enabled.

## Boundary

This runbook records the intended names, provider, and sequence. Changing it does not deploy application code, alter live DNS or Resend settings, complete Proton inbound mail, issue a certificate, redirect the former domain, create email credentials, or authorize real accounts.
