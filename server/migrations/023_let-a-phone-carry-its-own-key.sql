-- A browser is handed a cookie it never has to think about. A phone has no browser, so it
-- carries a token it attaches deliberately instead. The two live side by side: sessions stay
-- exactly as they are, and nothing here changes how the web signs in.
--
-- Only the SHA-256 hash is kept, as with every other token in this schema. A stolen database
-- row cannot be presented to the API, and the raw value exists only in the reply that issued it.
CREATE TABLE IF NOT EXISTS api_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Access and refresh tokens issued together share a family. Signing out, or presenting a
  -- refresh token that was already spent, retires the whole family rather than one row, so a
  -- copied token cannot outlive the sign-out that was meant to end it.
  family_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('access', 'refresh')),
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS api_tokens_family_idx ON api_tokens(family_id);
