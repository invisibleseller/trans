-- D1 schema for realtime interpreter accounts.

CREATE TABLE users (
  id              TEXT PRIMARY KEY,
  email           TEXT UNIQUE,
  google_sub      TEXT UNIQUE,
  wechat_unionid  TEXT UNIQUE,
  display_name    TEXT,
  balance_seconds REAL NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_users_email ON users(email);

CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE magic_links (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE INDEX idx_magic_email ON magic_links(email);

CREATE TABLE oauth_state (
  state      TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE redemption_codes (
  code         TEXT PRIMARY KEY,
  seconds      REAL NOT NULL,
  label        TEXT,
  batch        TEXT,
  created_at   INTEGER NOT NULL,
  redeemed_at  INTEGER,
  redeemed_by  TEXT REFERENCES users(id)
);

CREATE INDEX idx_codes_batch ON redemption_codes(batch);

CREATE TABLE usage_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(id),
  room_id      TEXT,
  seconds      REAL NOT NULL,  -- negative = credit (recharge), positive = consumption
  reason       TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_usage_user_time ON usage_ledger(user_id, created_at);
