-- What the App Store and Google Play tell us about a purchase after it was made (#273): a renewal,
-- a refund, a revocation, a subscription lapsing. One row per notification received, whether or
-- not it changed anything, because this log is how "why did our room change?" gets answered.
--
-- UNIQUE (store, notification_id) is what makes a notification safe to receive twice. Both stores
-- send again until they hear success, and a second delivery finds the first row and changes
-- nothing. notification_id is Apple's notificationUUID, or Google's Pub/Sub message id.
--
-- purchase_id names the billing_store_purchases row the notification is about. It goes with that
-- row (ON DELETE CASCADE), so the log is never kept longer than the purchase it explains. A
-- notification about no purchase we hold (a TEST notification, or a purchase never sent to us)
-- has no purchase_id, and is deleted 30 days after it arrived (StorePurchaseService).
--
-- transaction_ref is Apple's transactionId, or a short hash of Google's purchase token, which is a
-- credential and never stored here. Nothing else from the signed payload is kept: not the payload,
-- not the account value it carries.
--
-- outcome is what the notification did. It is written 'received' and settled in the same transaction
-- as the change it makes, so a committed row never stays 'received'.
--   test              Apple's or Google's test notification; nothing changed
--   renewed           the room now runs to the store's new end
--   refunded, revoked the room's end moved to the refund; the usual grace follows, then rest
--   lapsed            the room ends on its own date; the usual grace follows, then rest
--   unchanged         nothing to change: already known, a period since paid again, or the room is gone
--   extra_noted       an extra photo or place; noted only, until what a refunded extra does is decided
--   unknown_purchase  a purchase we never granted
--   not_acted_on      a kind of notification this server doesn't act on
CREATE TABLE IF NOT EXISTS billing_store_notifications (
  id uuid PRIMARY KEY,
  store text NOT NULL CHECK (store IN ('apple','google')),
  notification_id text NOT NULL,
  environment text CHECK (environment IN ('sandbox','live')),
  notification_type text NOT NULL,
  subtype text,
  purchase_id uuid REFERENCES billing_store_purchases(id) ON DELETE CASCADE,
  transaction_ref text,
  signed_at timestamptz,
  received_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('received','test','renewed','refunded','revoked','lapsed','unchanged','extra_noted','unknown_purchase','not_acted_on')),
  UNIQUE (store, notification_id)
);
CREATE INDEX IF NOT EXISTS billing_store_notifications_purchase_idx ON billing_store_notifications(purchase_id);
CREATE INDEX IF NOT EXISTS billing_store_notifications_received_idx ON billing_store_notifications(received_at);

-- A purchase the store has since refunded or revoked. Set once, never cleared. A refunded
-- transaction sent again by a phone (StoreKit can hand back a copy signed before the refund) then
-- extends nothing, and a refunded renewal we had never seen is recorded with it, so sending it
-- later grants nothing either.
ALTER TABLE billing_store_purchases ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE billing_store_purchases ADD COLUMN IF NOT EXISTS revocation text;
ALTER TABLE billing_store_purchases DROP CONSTRAINT IF EXISTS billing_store_purchases_revocation_check;
ALTER TABLE billing_store_purchases ADD CONSTRAINT billing_store_purchases_revocation_check CHECK (revocation IS NULL OR revocation IN ('refunded','revoked'));
