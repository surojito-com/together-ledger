CREATE OR REPLACE FUNCTION reject_event_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('together.allow_event_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'journey events are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journey_events_append_only ON journey_events;
CREATE TRIGGER journey_events_append_only
BEFORE UPDATE OR DELETE ON journey_events
FOR EACH ROW EXECUTE FUNCTION reject_event_mutation();
