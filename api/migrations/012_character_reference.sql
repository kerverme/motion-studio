ALTER TABLE characters ADD COLUMN IF NOT EXISTS reference_image text;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS storyboard jsonb;
