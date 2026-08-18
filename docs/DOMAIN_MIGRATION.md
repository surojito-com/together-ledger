# Domain migration runbook

Together Ledger is moving from the legacy Surojito subdomain to its own domain:

| Surface | Canonical address |
| --- | --- |
| Public application | `https://together-ledger.com` |
| Public application alias | `https://www.together-ledger.com` |
| Protected API | `https://api.together-ledger.com` |
| Transactional sender | `Together Ledger <no-reply@together-ledger.com>` |

`https://together.surojito.com` is a legacy address. Do not redirect it until the canonical public app and protected API have separately passed the synthetic-account release checks.

## Safe order of work

1. In GitHub Pages, assign and verify `together-ledger.com` as the custom domain before creating any DNS record. This prevents an unclaimed-domain takeover.
2. In Cloudflare, point the apex (`@`) to `surojito-com.github.io` with a DNS-only CNAME using apex CNAME flattening. Add a DNS-only `www` CNAME to `surojito-com.github.io`. Do not add wildcard records.
3. Wait for GitHub Pages to issue its certificate, enable HTTPS enforcement, and verify that the apex, `www`, and the repository's Pages fallback serve the same public build. The public site must still keep private accounts unavailable at this point.
4. Publish the required Amazon SES verification and DKIM records for `together-ledger.com` as DNS-only records. Do not enable production sending or create SMTP credentials until SES approves the account and the verified sender is ready.
5. After the private PostgreSQL and application checks pass, create a DNS-only `api` record pointing to the stable AWS address. Configure Caddy for `api.together-ledger.com`, open only TCP 80 and 443, and verify TLS plus `/healthz` and `/readyz`.
6. Set the public build's `together-api-origin` meta value to `https://api.together-ledger.com` only after the complete synthetic lifecycle passes: registration, email verification, invitation, recovery, deletion, and restore.
7. Finally, use a Cloudflare redirect rule for `together.surojito.com` that preserves the path and query string while sending visitors to `https://together-ledger.com`. Use a permanent redirect only after checks on both addresses pass.

## Checks with care

- The apex and `www` addresses resolve to the intended GitHub Pages site with HTTPS.
- The old Surojito address continues to work until the new public address is confirmed.
- API DNS is not created until private service readiness and synthetic account checks succeed.
- PostgreSQL and the application port remain unpublished; only Caddy receives public web traffic.
- Email DNS verification records remain DNS-only, and no credential value enters Git, shell history, or chat.
- A backup and isolated restore with synthetic data succeeds before real invitations are enabled.

## Boundary

This runbook changes the intended names and sequence. It does not make the protected service live, change DNS, issue a certificate, redirect the former domain, create email credentials, or authorize real accounts.
