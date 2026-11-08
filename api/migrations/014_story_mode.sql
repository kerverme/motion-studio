ALTER TABLE drafts ADD COLUMN IF NOT EXISTS story_mode text NOT NULL DEFAULT 'name_story';
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS source_text text;
