PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  username           TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  password_hash      TEXT NOT NULL,
  rating             INTEGER NOT NULL DEFAULT 1000,
  games_played       INTEGER NOT NULL DEFAULT 0,
  wins               INTEGER NOT NULL DEFAULT 0,
  draws              INTEGER NOT NULL DEFAULT 0,
  losses             INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS games (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code            TEXT NOT NULL,
  gold_user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  scarlet_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  gold_display_name    TEXT NOT NULL,
  scarlet_display_name TEXT NOT NULL,
  status               TEXT NOT NULL,  -- active | completed | abandoned
  rated                INTEGER NOT NULL DEFAULT 0,
  winner_colour        TEXT,  -- NULL = draw
  result_reason        TEXT,
  gold_rating_before   INTEGER,
  gold_rating_after    INTEGER,
  scarlet_rating_before INTEGER,
  scarlet_rating_after INTEGER,
  created_at           INTEGER NOT NULL,
  started_at           INTEGER,
  completed_at         INTEGER,
  final_state_json     TEXT,
  rating_applied_at    INTEGER
);

CREATE TABLE IF NOT EXISTS game_moves (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id       INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply           INTEGER NOT NULL,
  colour        TEXT NOT NULL,
  notation      TEXT,
  move_json     TEXT,
  state_version INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user         ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_games_gold            ON games(gold_user_id);
CREATE INDEX IF NOT EXISTS idx_games_scarlet         ON games(scarlet_user_id);
CREATE INDEX IF NOT EXISTS idx_games_completed       ON games(completed_at);
CREATE INDEX IF NOT EXISTS idx_game_moves_game_ply   ON game_moves(game_id, ply);
CREATE INDEX IF NOT EXISTS idx_users_username_norm   ON users(username_normalized);
