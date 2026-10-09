-- Two more things a store notification can do (#273, the third part). Only the list of outcomes in
-- billing_store_notifications widens; nothing is dropped, renamed or narrowed, so the release
-- before this one runs against it unchanged.
--
--   reinstated  Apple reversed a refund (REFUND_REVERSED). The room comes back to the end it had
--               before the refund, and a refunded extra's withdrawn slots come back (owner, Oct 9,
--               2026, decision 67).
--   waiting     Google pushed a voided purchase or a revocation that Google's own API doesn't show
--               yet. Nothing changed, and the push was answered 503 so Pub/Sub sends it again, for up
--               to seven days (owner, Oct 9, 2026, decision 78). The row is written once, on the
--               first delivery, so a retry is told apart from a new notification without a log line
--               per retry; when Google confirms it, the same row is settled with what it did. A row
--               still waiting after seven days is one Google never confirmed.
--
-- 'extra_noted' stays allowed for the rows 16A and 16B wrote. A refunded extra is now 'refunded'
-- or 'revoked', like room.
--
-- On real Postgres the column check 034 declared is named billing_store_notifications_outcome_check.
-- billing_store_purchases.revoked_at was "set once, never cleared" in 034; a reversed refund now
-- clears it, because the purchase stands again.
ALTER TABLE billing_store_notifications DROP CONSTRAINT IF EXISTS billing_store_notifications_outcome_check;
ALTER TABLE billing_store_notifications ADD CONSTRAINT billing_store_notifications_outcome_check
  CHECK (outcome IN ('received','test','renewed','refunded','revoked','reinstated','lapsed','unchanged','waiting','extra_noted','unknown_purchase','not_acted_on'));
