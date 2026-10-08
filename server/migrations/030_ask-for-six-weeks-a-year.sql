-- The weeks the person who pays can ask for, on top of the automatic 7 days of grace, are now at
-- most 6 per journey per calendar year, not 7 (owner, Oct 8, 2026; the Book, 4.7): 7 weeks of
-- grace in all, the first automatic. The server holds the limit (GRACE_REQUESTS_PER_YEAR in
-- server/platform.js); this holds it in the database too, so two requests racing cannot both
-- become the seventh.
--
-- Migration 029 is left as it was released. NOT VALID applies the new limit to every request
-- from here on without re-checking rows already written: a seventh week someone was given under
-- the old limit stays, and is honoured until it runs out.
ALTER TABLE journey_grace_requests DROP CONSTRAINT IF EXISTS journey_grace_requests_request_number_check;
ALTER TABLE journey_grace_requests ADD CONSTRAINT journey_grace_requests_request_number_check
  CHECK (request_number BETWEEN 1 AND 6) NOT VALID;
