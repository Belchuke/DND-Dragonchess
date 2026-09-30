ALTER TABLE users ADD COLUMN requires_reset INTEGER NOT NULL DEFAULT 0;

UPDATE users SET requires_reset = 1 WHERE password_hash IS NULL OR substr(password_hash, 1, 2) <> '$2';
