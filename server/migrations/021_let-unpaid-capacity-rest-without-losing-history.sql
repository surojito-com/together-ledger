-- When paid capacity lapses, the journeyers beyond the included two rest rather than being
-- removed. The owner chooses how resting behaves and, when it matters, who rests.
ALTER TABLE journeys ADD COLUMN IF NOT EXISTS unpaid_capacity_mode text NOT NULL DEFAULT 'read-only';
ALTER TABLE journeys DROP CONSTRAINT IF EXISTS journeys_unpaid_capacity_mode_check;
ALTER TABLE journeys ADD CONSTRAINT journeys_unpaid_capacity_mode_check CHECK (unpaid_capacity_mode IN ('read-only', 'paused'));

-- Lower rests first. Left null, a member falls back to having joined most recently, so the
-- default is the last person in rather than a choice nobody made.
ALTER TABLE journey_members ADD COLUMN IF NOT EXISTS rest_order integer;
