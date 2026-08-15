ALTER TABLE users ADD COLUMN username text;

-- Existing accounts keep their identity. Give each one a stable, private sign-in name
-- without exposing their email or changing the name journeyers see.
UPDATE users
SET username = 'journeyer-' || substring(id::text FROM 1 FOR 8)
WHERE username IS NULL;

ALTER TABLE users ALTER COLUMN username SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_username_length_check
  CHECK (char_length(username) BETWEEN 3 AND 30);
ALTER TABLE users ADD CONSTRAINT users_username_unique UNIQUE (username);
