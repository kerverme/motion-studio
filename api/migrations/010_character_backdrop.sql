-- the background of the photo a character was made from (the person erased, shrunk to a small JPEG data URL);
-- the worker flattens it into a poster-like backdrop for that character's scenes and cover
ALTER TABLE characters ADD COLUMN IF NOT EXISTS backdrop text;
