ALTER TABLE journey_moments DROP CONSTRAINT IF EXISTS journey_moments_visibility_check;
ALTER TABLE journey_moments DROP CONSTRAINT IF EXISTS journey_moments_constraint_5;

UPDATE journey_moments
SET created_by_user_id = journeys.owner_user_id
FROM journeys
WHERE journey_moments.journey_id = journeys.id
  AND journey_moments.created_by_user_id IS NULL;

ALTER TABLE journey_moments ALTER COLUMN created_by_user_id SET NOT NULL;
ALTER TABLE journey_moments ADD CONSTRAINT journey_moments_visibility_check
  CHECK (visibility IN ('private', 'shared-now', 'share-later'));

CREATE INDEX IF NOT EXISTS journey_moments_viewer_idx
  ON journey_moments(journey_id, visibility, created_by_user_id, occurred_on, created_at);

CREATE TABLE IF NOT EXISTS private_moment_events (
  id uuid PRIMARY KEY,
  journey_id uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  moment_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('moment_added','moment_updated','visibility_changed','moment_deleted')),
  before_visibility text CHECK (before_visibility IS NULL OR before_visibility IN ('private','share-later')),
  after_visibility text CHECK (after_visibility IS NULL OR after_visibility IN ('private','share-later')),
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS private_moment_events_owner_idx
  ON private_moment_events(journey_id, owner_user_id, created_at, id);
