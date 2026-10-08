-- How Together Ledger is paid for, decided by the owner on Oct 7, 2026 (the Book, Decision guide
-- 4.7; #203). Two parts of it live in the schema.

-- Resting is always read-only. Owners could choose to fully pause resting journeyers, so they
-- could not even read; that choice is gone. Any journey left on it reads again from here on. The
-- column stays, pinned to the one value, so the release before this one can still be rolled back
-- to without a schema change, and nothing can write the old choice back.
UPDATE journeys SET unpaid_capacity_mode='read-only' WHERE unpaid_capacity_mode<>'read-only';
ALTER TABLE journeys DROP CONSTRAINT IF EXISTS journeys_unpaid_capacity_mode_check;
ALTER TABLE journeys ADD CONSTRAINT journeys_unpaid_capacity_mode_check CHECK (unpaid_capacity_mode = 'read-only');

-- After the automatic 7 days of grace, the person who pays can ask for another 7 days, up to 7
-- times per journey per calendar year. The count starts again each January 1 (UTC).
--
-- request_number is what holds the limit: the eighth request in a year has no number to take,
-- so two taps racing each other cannot both become the seventh.
--
-- grace_basis is when the automatic grace ended for the lapse this request belongs to. A request
-- only extends the grace whose automatic end it names, so time asked for during one lapse is never
-- carried into the next.
--
-- Each request is also written into the journey's append-only history (journey_events), which is
-- the record people see. This table is how the server counts and adds up the time.
CREATE TABLE IF NOT EXISTS journey_grace_requests (
  id uuid PRIMARY KEY,
  journey_id uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  requested_by_user_id uuid NOT NULL REFERENCES users(id),
  calendar_year integer NOT NULL,
  request_number integer NOT NULL CHECK (request_number BETWEEN 1 AND 7),
  grace_basis timestamptz NOT NULL,
  grace_until timestamptz NOT NULL,
  requested_at timestamptz NOT NULL,
  UNIQUE (journey_id, calendar_year, request_number)
);
