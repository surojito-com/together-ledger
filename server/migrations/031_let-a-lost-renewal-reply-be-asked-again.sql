-- A phone renews its sign-in by spending its refresh token for a new pair. If the reply is lost on
-- the way back (airplane mode at the wrong moment, a dropped connection), the phone still holds the
-- spent token, and presenting it again used to retire the whole family as if it had been copied
-- (#353). Only hashes are kept, so the server cannot hand the lost pair back. Instead it may issue
-- another pair in its place, but only while the lost one has never been presented by anyone.
--
-- Two columns, both additive and empty for every row already written:
--
-- - used_at: when this token was first presented to the server. An access token is marked the
--   first time it is accepted; a refresh token when it is spent.
-- - issued_by: the refresh token whose spending issued this pair. A pair issued at sign-in has none.
--
-- A refresh token spent before this migration has no pair pointing back at it, so presenting it
-- again still retires its family, exactly as before.
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS used_at timestamptz;
ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS issued_by uuid;
CREATE INDEX IF NOT EXISTS api_tokens_issued_by_idx ON api_tokens(issued_by);
