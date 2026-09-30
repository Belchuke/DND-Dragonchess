ALTER TABLE games ADD COLUMN rematch_of INTEGER REFERENCES games(id);

ALTER TABLE game_moves ADD COLUMN last_move TEXT;
