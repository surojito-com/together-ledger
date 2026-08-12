# Production readiness gate

This checklist records what must be true before Together Ledger's private-sync API receives public traffic. It is designed for the single-owner AWS-primary, GCP-standby posture. Do not check an item merely because a console page exists.

## Foundation

- [ ] The reviewed `main` commit is reproducibly built and its container digest is recorded.
- [ ] The AWS instance has a stable attached static IP and its operating system is patched.
- [ ] SSH access is proven from the owner's terminal; the private key is mode `0600` and never committed.
- [ ] The Lightsail network firewall permits SSH only from the owner's current trusted network. It does not expose `5432` or `4174`.
- [ ] The host firewall is active and permits SSH. Web ports remain closed until the release step.
- [ ] Docker and Docker Compose are installed; `./scripts/verify-production-host.sh` passes from the repository checkout.

## Deployment

- [ ] The root-owned production environment file exists outside the repository with mode `0600`.
- [ ] Secrets are generated uniquely, stored in AWS Secrets Manager, and their values never enter Git, screenshots, shell history, or chat.
- [ ] The PostgreSQL role is application-only and the database has no public port.
- [ ] Caddy receives only ports `80` and `443`; it proxies privately to the application.
- [ ] A Caddy domain and Cloudflare DNS record are configured only after private health checks pass.
- [ ] `PUBLIC_ORIGIN` is exactly `https://together.surojito.com`, cookies are secure, and proxy trust is enabled.

## Recoverability

- [ ] An encrypted logical PostgreSQL backup completes and its SHA-256 sidecar is retained.
- [ ] One encrypted backup is copied to GCP storage using a separately reviewed transfer procedure.
- [ ] A synthetic-data restore succeeds into an isolated PostgreSQL database.
- [ ] Registration, verification, invitation, recovery, deletion, conflict protection, two-person limit, and Event Manager integrity pass using synthetic accounts.
- [ ] The rollback procedure in `docs/OPERATIONS.md` has been rehearsed without production user data.

## Public release decision

Only after every applicable item is checked may the owner open Lightsail ports `80` and `443`, direct `api.together.surojito.com` to AWS, and configure the Pages frontend to use that exact API origin. A budget alert is monitoring—not an automatic spending stop.
