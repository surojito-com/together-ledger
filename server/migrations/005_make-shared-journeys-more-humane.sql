ALTER TABLE journeys DROP CONSTRAINT IF EXISTS journeys_location_check;
ALTER TABLE journeys ADD CONSTRAINT journeys_location_check CHECK (char_length(location) <= 80);
ALTER TABLE journeys ALTER COLUMN location SET DEFAULT '';

ALTER TABLE journeys ADD COLUMN IF NOT EXISTS start_date_status text NOT NULL DEFAULT 'exact' CHECK (start_date_status IN ('exact','unknown'));
ALTER TABLE journeys ADD COLUMN IF NOT EXISTS end_date_status text NOT NULL DEFAULT 'date' CHECK (end_date_status IN ('date','unsure','forever'));
ALTER TABLE journeys ALTER COLUMN start_date DROP NOT NULL;
ALTER TABLE journeys ALTER COLUMN end_date DROP NOT NULL;
ALTER TABLE journeys DROP CONSTRAINT IF EXISTS journeys_end_date_check;
-- pg-mem assigns anonymous CHECK names while PostgreSQL derives the name above.
-- Dropping both keeps the test schema faithful to the production migration.
ALTER TABLE journeys DROP CONSTRAINT IF EXISTS journeys_constraint_2;
ALTER TABLE journeys ADD CONSTRAINT journeys_date_intent_check CHECK (
  (start_date_status = 'exact' AND start_date IS NOT NULL) OR
  (start_date_status = 'unknown' AND start_date IS NULL)
);
ALTER TABLE journeys ADD CONSTRAINT journeys_end_date_intent_check CHECK (
  (end_date_status = 'date' AND end_date IS NOT NULL AND (start_date IS NULL OR end_date >= start_date)) OR
  (end_date_status IN ('unsure','forever') AND end_date IS NULL)
);

ALTER TABLE journey_moments ADD COLUMN IF NOT EXISTS money_currency text NOT NULL DEFAULT '' CHECK (money_currency IN ('','USD','EUR','GBP','CAD','AUD','JPY','INR'));
ALTER TABLE journey_moments ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES users(id);
ALTER TABLE journey_moments ADD COLUMN IF NOT EXISTS updated_by_user_id uuid REFERENCES users(id);
