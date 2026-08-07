CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email_normalized text NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  csrf_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS account_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('password_recovery','email_verification')),
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS journeys (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  location text NOT NULL CHECK (char_length(location) BETWEEN 1 AND 80),
  start_date date NOT NULL,
  end_date date NOT NULL CHECK (end_date >= start_date),
  budget_cents integer NOT NULL CHECK (budget_cents BETWEEN 0 AND 100000000),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS journey_members (
  journey_id uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (journey_id, user_id)
);
CREATE INDEX IF NOT EXISTS journey_members_user_idx ON journey_members(user_id);

CREATE TABLE IF NOT EXISTS invitations (
  id uuid PRIMARY KEY,
  journey_id uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  invited_by_user_id uuid NOT NULL REFERENCES users(id),
  email_normalized text NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invitations_journey_idx ON invitations(journey_id);

CREATE TABLE IF NOT EXISTS expenses (
  id uuid PRIMARY KEY,
  journey_id uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  merchant text NOT NULL CHECK (char_length(merchant) BETWEEN 1 AND 80),
  category text NOT NULL CHECK (category IN ('Flights','Hotel','Restaurants','Transportation','Activities','Shopping','Other')),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  occurred_on date NOT NULL,
  paid_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  payer_label text NOT NULL CHECK (char_length(payer_label) BETWEEN 1 AND 80),
  account text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('paid','due')),
  reference text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expenses_journey_idx ON expenses(journey_id, occurred_on);

CREATE TABLE IF NOT EXISTS concerns (
  id uuid PRIMARY KEY,
  journey_id uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  detail text NOT NULL DEFAULT '' CHECK (char_length(detail) <= 500),
  status text NOT NULL CHECK (status IN ('open','resolved')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS concerns_journey_idx ON concerns(journey_id);

CREATE TABLE IF NOT EXISTS journey_milestones (
  journey_id uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key IN ('reviewedPicture','chosePrompt','agreedNextAction')),
  completed boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (journey_id, key)
);

CREATE TABLE IF NOT EXISTS journey_events (
  id uuid NOT NULL UNIQUE,
  journey_id uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  actor_user_id uuid NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  summary text NOT NULL,
  before_value jsonb,
  after_value jsonb,
  previous_hash char(64) NOT NULL,
  event_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (journey_id, sequence)
);
