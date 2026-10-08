-- A store purchase, once our server has verified it with Apple or Google, and what it was turned
-- into (#272). One row per store transaction, which is what makes a purchase idempotent: the same
-- transaction sent twice, by a retry, a network blip or a replay, finds its row and grants nothing
-- more.
--
-- `transaction_id` is Apple's transactionId, or Google's purchase token. `entitlement_record_id`
-- is the `source_record_id` of the billing_entitlements row it wrote: for a subscription that is
-- the subscription's own id (Apple's originalTransactionId, Google's purchase token), the same
-- across renewals, so renewing moves one entitlement forward rather than stacking new ones.
--
-- `environment` is 'sandbox' for App Store sandbox and Google licence-tester purchases, 'live' for
-- real ones. A deployment honours only its own (config.storeEnvironment), so a test purchase can
-- never become capacity on the live service.
--
-- journey_id and moment_id carry no foreign key, for the reason migration 027 gives: a journey is
-- deleted with its last member, and the record of what was paid for has to outlive it.
--
-- Google refunds a purchase nobody acknowledged within three days. `acknowledgement` is 'pending'
-- from the moment the grant is written until Google confirms it, and the server retries what is
-- still pending (StorePurchaseService.acknowledgePending). Apple has no such step on the server.
CREATE TABLE IF NOT EXISTS billing_store_purchases (
  id uuid PRIMARY KEY,
  store text NOT NULL CHECK (store IN ('apple','google')),
  environment text NOT NULL CHECK (environment IN ('sandbox','live')),
  transaction_id text NOT NULL,
  original_transaction_id text NOT NULL,
  product_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('subscription','pass','extra')),
  payer_user_id uuid NOT NULL REFERENCES users(id),
  journey_id uuid NOT NULL,
  moment_id uuid,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10),
  purchased_at timestamptz NOT NULL,
  effective_at timestamptz,
  expires_at timestamptz,
  entitlement_record_id text,
  acknowledgement text NOT NULL CHECK (acknowledgement IN ('not-needed','pending','done')),
  acknowledge_by timestamptz,
  acknowledge_attempts integer NOT NULL DEFAULT 0,
  next_acknowledge_at timestamptz,
  acknowledged_at timestamptz,
  last_acknowledge_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (store, environment, transaction_id)
);
CREATE INDEX IF NOT EXISTS billing_store_purchases_journey_idx ON billing_store_purchases(journey_id, kind, expires_at);
CREATE INDEX IF NOT EXISTS billing_store_purchases_acknowledgement_idx ON billing_store_purchases(acknowledgement, next_acknowledge_at);

-- An extra photo or place bought in a store becomes the same slot a web payment makes, so a
-- moment holds it the same way whichever way it was paid for. The slots learn the sandbox
-- environment and which store purchase made them.
ALTER TABLE moment_image_slots DROP CONSTRAINT IF EXISTS moment_image_slots_environment_check;
ALTER TABLE moment_image_slots ADD CONSTRAINT moment_image_slots_environment_check CHECK (environment IN ('test','live','sandbox'));
ALTER TABLE moment_image_slots ADD COLUMN IF NOT EXISTS store_purchase_id uuid REFERENCES billing_store_purchases(id);

ALTER TABLE moment_location_slots DROP CONSTRAINT IF EXISTS moment_location_slots_environment_check;
ALTER TABLE moment_location_slots ADD CONSTRAINT moment_location_slots_environment_check CHECK (environment IN ('test','live','sandbox'));
ALTER TABLE moment_location_slots ADD COLUMN IF NOT EXISTS store_purchase_id uuid REFERENCES billing_store_purchases(id);
