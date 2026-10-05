-- Apple requires an app that offers Sign in with Apple to revoke the person's Apple tokens when
-- they delete their account (#218). Revoking needs the refresh token Apple issues when the server
-- exchanges a sign-in's authorization code, so each Apple identity now keeps one, encrypted
-- (server/apple.js), never in plaintext, and never in an export.
--
-- apple_client_id is which client the token was issued to (the App ID for the phone, the Services
-- ID for the web). Revoking must use the same one.
ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS apple_client_id text;
ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS apple_refresh_token text;

-- Revocations still owed to Apple. A row is written in the same transaction that deletes the
-- account, then tried straight after it commits; if Apple can't be reached the server retries it
-- with backoff for up to a week. There is deliberately no user_id: the account is gone, and this
-- row must not be a way to tell whose it was. The token stays encrypted here too.
CREATE TABLE IF NOT EXISTS apple_revocations (
  id uuid PRIMARY KEY,
  client_id text NOT NULL,
  refresh_token text NOT NULL,
  created_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error text
);
CREATE INDEX IF NOT EXISTS apple_revocations_due_idx ON apple_revocations(next_attempt_at);
