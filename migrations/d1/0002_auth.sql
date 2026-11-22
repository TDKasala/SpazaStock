-- Sign-in state for the Worker's own auth, replacing Supabase Auth (hand-written, not generated).
-- users itself is in 0001_initial.sql; ids, emails and bcrypt hashes are imported from Supabase.

-- One row per signed-in device. Only hashes of refresh tokens are stored. A refresh rotates the
-- token; the previous one stays valid for 10 seconds so two tabs refreshing at once both succeed.
CREATE TABLE sessions (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  refresh_hash TEXT NOT NULL,
  previous_refresh_hash TEXT,
  rotated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  -- Set after a password-reset code: the session may only change the password.
  recovery INTEGER NOT NULL DEFAULT 0 CHECK (recovery IN (0, 1)),
  user_agent TEXT,
  PRIMARY KEY (id),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX sessions_refresh_key ON sessions (refresh_hash);
CREATE INDEX sessions_previous_refresh_idx ON sessions (previous_refresh_hash) WHERE previous_refresh_hash IS NOT NULL;
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Six-digit email codes: sign-up confirmation, sign-in, password reset. Stored hashed, single use,
-- valid for an hour, at most 5 wrong guesses.
CREATE TABLE auth_codes (
  id TEXT NOT NULL,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'signin', 'recovery')),
  code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  PRIMARY KEY (id)
) STRICT;
CREATE INDEX auth_codes_email_idx ON auth_codes (email, purpose, created_at);
