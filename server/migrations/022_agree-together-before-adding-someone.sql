-- Adding a person is agreed by everyone already in the journey, not decided by the owner alone.
-- A proposal is held here while the people already here answer it. Nothing is sent to the
-- proposed person, and they learn nothing at all, unless every current journeyer agrees.
CREATE TABLE IF NOT EXISTS journey_invite_proposals (
  id uuid PRIMARY KEY,
  journey_id uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  proposed_by_user_id uuid NOT NULL REFERENCES users(id),
  email_normalized text NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 300),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'agreed', 'declined', 'withdrawn', 'lapsed')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  invitation_id uuid REFERENCES invitations(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS journey_invite_proposals_journey_idx ON journey_invite_proposals(journey_id, created_at, id);

-- One row per journeyer asked. Both times are kept, because a record that says only what was
-- decided cannot say how long someone was left waiting for an answer, or how long they waited
-- before giving one. Left null, a decision has not been made rather than made silently.
CREATE TABLE IF NOT EXISTS journey_invite_consents (
  proposal_id uuid NOT NULL REFERENCES journey_invite_proposals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision text CHECK (decision IS NULL OR decision IN ('agree', 'decline')),
  requested_at timestamptz NOT NULL,
  decided_at timestamptz,
  PRIMARY KEY (proposal_id, user_id)
);
CREATE INDEX IF NOT EXISTS journey_invite_consents_user_idx ON journey_invite_consents(user_id);
