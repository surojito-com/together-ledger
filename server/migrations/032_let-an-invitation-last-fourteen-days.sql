-- An invitation now lasts 14 days, can be withdrawn by whoever asked or the owner, and can be sent
-- again by whoever asked while the agreement's 30 days last (owner, Oct 8, 2026, #347). Every step
-- of it is written into the journey's history (#348). The lifetime itself is a setting
-- (INVITATION_DAYS), so nothing here changes an invitation already waiting: it keeps the expiry it
-- was sent with.

-- Which agreement an invitation came from, so it can be sent again without asking everyone again.
-- journey_invite_proposals.invitation_id keeps pointing at the newest one.
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS proposal_id uuid REFERENCES journey_invite_proposals(id) ON DELETE SET NULL;
UPDATE invitations SET proposal_id = p.id FROM journey_invite_proposals p
WHERE p.invitation_id = invitations.id AND invitations.proposal_id IS NULL;

-- Withdrawn by a person, as opposed to revoked because the mail never went out or because the
-- invited person deleted their account.
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS withdrawn_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

-- Who accepted, so the journey sees their name once they have joined and never needs the address.
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS accepted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
UPDATE invitations SET accepted_by_user_id = u.id FROM users u
WHERE u.email_normalized = invitations.email_normalized AND invitations.accepted_at IS NOT NULL AND invitations.accepted_by_user_id IS NULL;

-- Running out is worked out when an invitation is read; nothing runs at the moment it happens. The
-- server writes the history entry the first time it notices, and this records that it has, so two
-- requests noticing at once cannot both write it: only the one whose update finds it still null
-- does (server/platform.js, recordRunOuts).
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS lapse_recorded_at timestamptz;

-- Whatever had already run out before this release counts as noticed. History never recorded the
-- steps before it, so a lone "ran out" entry for it would be the only trace, and a misleading one.
UPDATE invitations SET lapse_recorded_at = expires_at
WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now() AND lapse_recorded_at IS NULL;
UPDATE journey_invite_proposals SET status = 'lapsed', closed_at = expires_at
WHERE status = 'open' AND expires_at <= now();
