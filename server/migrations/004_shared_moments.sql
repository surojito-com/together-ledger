CREATE TABLE IF NOT EXISTS journey_moments (
  id uuid PRIMARY KEY,
  journey_id uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('promise','acknowledgment','trigger','missed-chance','heart-to-heart','memory','feeling','boundary','repair-request','practical-matter','other')),
  kind_label text NOT NULL DEFAULT '' CHECK (char_length(kind_label) <= 60),
  occurred_on date NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  detail text NOT NULL DEFAULT '' CHECK (char_length(detail) <= 1200),
  visibility text NOT NULL DEFAULT 'shared-now' CHECK (visibility = 'shared-now'),
  money_cents integer CHECK (money_cents IS NULL OR money_cents BETWEEN 0 AND 100000000),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'other' AND char_length(kind_label) BETWEEN 1 AND 60) OR (kind <> 'other' AND kind_label = ''))
);
CREATE INDEX IF NOT EXISTS journey_moments_journey_idx ON journey_moments(journey_id, occurred_on, created_at);
