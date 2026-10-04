-- An account can now be opened with Google or Apple as well as with a password (#214).
--
-- Such an account has no password, so the column that held one for everybody may now be empty.
-- Signing in with a password treats an empty one as "no password here", and never as a match.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- One row per way in through a provider. An account is found by the provider's own stable id
-- for the person (`sub`), never by matching an email: Apple lets people hide theirs behind a
-- relay address, and an email match is the most common way social sign-in ends up handing one
-- person's account to someone else.
--
-- A password account can gain a row here too, but only after the person enters that password
-- once (decided on #214, Sep 30, 2026). Nothing is linked because two emails happen to match.
CREATE TABLE IF NOT EXISTS user_identities (
  provider text NOT NULL CHECK (provider IN ('google', 'apple')),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS user_identities_user_idx ON user_identities(user_id);
