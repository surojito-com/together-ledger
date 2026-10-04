-- When Apple reports that someone deleted their Apple account, and Delete account refuses to
-- delete theirs (they still own a journey someone else is in), the account is kept exactly as
-- Delete account would keep it (#250, decided Sep 30, 2026: refuse for now, review after launch).
-- The owner then hands the journey over by hand and finishes the deletion, within 30 days.
--
-- A log line alone can't carry that follow-up: the app container's log goes when the container is
-- recreated, and every release recreates it. So the refusal is remembered here, on the Apple
-- identity itself, until the deletion is finished and the row goes with the account.
-- server/finish-apple-account-deletion.js lists these, oldest first, and finishes them.
ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS apple_account_deleted_at timestamptz;
