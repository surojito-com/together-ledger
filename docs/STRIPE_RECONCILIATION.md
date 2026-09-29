# Stripe billing reconciliation

This runbook repairs Together Ledger's private billing projections from current Stripe objects when a webhook is missed, delayed, or cannot be processed. It does not accept browser input, change a Stripe subscription, remove a person, or alter shared history.

## Safe operating boundary

- Run only from the reviewed private service checkout with its protected environment and database access.
- `BILLING_ENABLED=true`, the Stripe key environment, the configured Price, and the database environment must agree. The command fails closed on a wrong environment, Price, customer, journey owner, or quantity.
- The command reads current Stripe Customers, subscriptions, and invoices. It writes only Together Ledger's billing projections and reconciliation ledger.
- A PostgreSQL advisory lock allows one reconciliation per Stripe environment at a time.
- Output contains aggregate counts only. Never paste private reconciliation rows, provider errors, credentials, Customer IDs, subscription IDs, invoice links, or account identifiers into GitHub.

Run manually:

```sh
npm run reconcile:stripe
```

For the scheduler invocation:

```sh
npm run reconcile:stripe -- --scheduled
```

Exit status `0` means the run completed with no known duplicate tagged Customers or failed webhook rows. Status `2` means reconciliation completed but an operator must inspect those private conditions. Status `1` means the run failed and its private ledger row holds a bounded error summary.

## Schedule and ownership

The primary platform operator runs reconciliation every six hours and once after any webhook outage or Stripe incident, via the systemd timers in `ops/together-ledger-stripe-reconciliation*`. Install them on the production host with:

```sh
sudo ./scripts/install-production-stripe-reconciliation-timers.sh
```

That installs two independent timers, each wired to alert through `together-ledger-alert@.service`:

- `together-ledger-stripe-reconciliation.timer` runs the reconciliation itself every six hours (`ops/together-ledger-stripe-reconciliation.service`, wrapping `scripts/run-production-stripe-reconciliation.sh`). A non-zero exit — status `1` or `2` — triggers an alert.
- `together-ledger-stripe-reconciliation-freshness.timer` checks every hour, independent of whether reconciliation itself is currently succeeding, that a run has completed successfully within the last eight hours (`scripts/check-stripe-reconciliation-freshness.mjs`, wrapped by `scripts/check-production-stripe-reconciliation-freshness.sh`). This is what catches the timer having stopped firing entirely, not just a run that failed.
- Overlapping-run refusal is already an exit-status-`1` failure (the advisory lock), so it alerts through the same path with no separate wiring.

The installer writes a placeholder `/etc/together-ledger/alert-webhook.env` (root-owned, mode 600) the first time it runs. Set `ALERT_WEBHOOK_URL` there to your team's actual on-call endpoint (a Slack incoming webhook, PagerDuty Events API URL, or any endpoint accepting a JSON POST) before relying on the alerts — `together-ledger-alert@.service` only sends the failed unit's name and a timestamp, never error text, credentials, or provider identifiers. Run one manual `npm run reconcile:stripe` pass and confirm it succeeds before enabling the timers.

The scheduler must inject protected environment values (`TOGETHER_ENV_FILE`) through the same secret path as the private service. Do not place credentials in a unit file, crontab, shell history, GitHub Action, or repository environment file.

## What a run does

1. Verifies the configured recurring Price is the approved environment-matched $1 monthly licensed offer.
2. Counts duplicate Together Ledger-tagged Customers without printing their identities.
3. Lists every subscription for each locally mapped Stripe Customer and selects only the Together Ledger offer.
4. Revalidates the Customer-to-payer and payer-to-owner relationships before projecting current subscription state.
5. Lists invoices for the mapped Customer and records only subscription invoices. Historical invoice state never overrides the current reconciled subscription state.
6. Preserves event-time ordering by recording the reconciliation snapshot as the newest provider observation. Later Stripe activity can still supersede it; older delayed events cannot.
7. Records aggregate counts, repaired entitlement drift, webhook failures, completion state, and timing in `billing_reconciliation_runs`.

Stripe may retry production webhook delivery for a limited period, and its Event list is limited to recent history. Current-object reconciliation is therefore the durable repair source; Event replay remains a narrow incident tool. Stripe also does not guarantee event delivery order. See [process undelivered events](https://docs.stripe.com/webhooks/process-undelivered-events) and [webhook event ordering](https://docs.stripe.com/webhooks#event-ordering).

## Verification before scheduling

- Drop a synthetic subscription webhook, run reconciliation, and confirm the subscription, paid invoice, and one-person entitlement are repaired.
- Run it again and confirm zero new entitlement drift.
- Reverse and duplicate synthetic event order; the newest current Stripe state must remain authoritative.
- Hold the advisory lock and confirm a second operator run refuses to start.
- Introduce a synthetic wrong Price, Customer mapping, environment, and quantity one at a time; each must fail closed without granting capacity.
- Create a failed webhook ledger row and a duplicate tagged Customer; the command must finish with aggregate attention and exit status `2`.
- Verify no command output or application log contains a credential or private provider/account identifier.

This runbook is independent of frontend hostname work. It does not change `PUBLIC_ORIGIN`, `APP_ORIGINS`, CORS, cookies, email-return origins, DNS, TLS, the public app origin, or the issue 48 domain-cutover sequence.
