-- A moment held on a phone without a connection waits there and sends itself once the connection
-- returns (owner, Oct 8, 2026, #352). A send whose reply never arrived is sent again, so holding a
-- moment has to be safe to send twice. The phone chooses a key for each moment it holds and sends
-- it with the moment; this table remembers which moment each key made.
--
-- A key belongs to one person in one journey. It is only ever looked up with both, so the same
-- key sent by someone else, or into another journey, simply holds their own moment, and nobody can
-- learn whether anyone else ever used it. The moment's id is still chosen by the server.
--
-- content_hash is a keyed hash (AUDIT_HMAC_KEY) of the moment as it was first held, so the same
-- key arriving with different content is refused rather than taken for the first. moment_id is
-- emptied when that moment is deleted, and the row stays, so a late resend says the moment was
-- deleted instead of holding it again. The rows go with the journey, and with the person when they
-- leave it or delete their account (server/platform.js, removeMember and eraseAccount).
--
-- Additive: a new table, empty, which nothing already deployed reads.
CREATE TABLE IF NOT EXISTS moment_hold_keys (
  journey_id uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hold_key text NOT NULL CHECK (char_length(hold_key) BETWEEN 16 AND 64),
  moment_id uuid REFERENCES journey_moments(id) ON DELETE SET NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (journey_id, author_user_id, hold_key)
);
CREATE INDEX IF NOT EXISTS moment_hold_keys_author_idx ON moment_hold_keys(author_user_id);
CREATE INDEX IF NOT EXISTS moment_hold_keys_moment_idx ON moment_hold_keys(moment_id);
