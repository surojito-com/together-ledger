-- A store purchase happens between a person and Apple or Google. What comes back is a signed
-- transaction naming an Apple or Google account, never a Together Ledger one (#269). Each store
-- carries exactly one value of ours through the purchase and back, set when the purchase starts:
-- Apple's appAccountToken (a UUID) and Google's obfuscatedAccountId, with obfuscatedProfileId
-- beside it. Without them a verified purchase cannot be honoured, because nobody can say whose
-- it is. These tables are what those values mean.
--
-- Neither table holds anything a person typed. The values are random UUIDs, travel to Apple and
-- Google, and come back in receipts and notifications, which is why the account id itself is
-- never sent.

-- Who paid. One value per account, the same on every device and after a reinstall, sent to Google
-- as obfuscatedAccountId.
CREATE TABLE IF NOT EXISTS billing_store_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  account_token uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL
);

-- Who paid, and for which journey. Capacity belongs to a journey, so a purchase has to name one.
-- Apple carries a single value, so this is what goes to Apple as appAccountToken, and to Google as
-- obfuscatedProfileId. It is the same for one person and one journey on every device.
--
-- journey_id has no foreign key on purpose. A journey is deleted with its last member, and a
-- refund or revocation from a store can arrive after that; the record of what the value meant
-- has to outlive the journey, and must never be the reason a journey cannot be deleted.
CREATE TABLE IF NOT EXISTS billing_store_journeys (
  journey_token uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  journey_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (user_id, journey_id)
);
