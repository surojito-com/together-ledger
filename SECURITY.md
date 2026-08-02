# Security policy

## Supported versions

Security fixes currently target the latest commit on `main`.

## Reporting a vulnerability

Do not open a public issue containing a credential, private ledger export, personal screenshot, or exploit details. Use GitHub's private vulnerability reporting feature for this repository when available.

Include:

- A concise description of the risk
- Reproduction steps using synthetic data
- The affected file or commit
- Suggested mitigation, if known

## Repository rules

- Never commit credentials, private endpoints, `.env` files, or real trip data.
- Never copy source history from a private household deployment.
- Run `npm run check` before every pull request.
- Treat exported ledger JSON as sensitive personal data.
- Keep any future network sync optional and documented.
