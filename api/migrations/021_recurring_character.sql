ALTER TABLE drafts ADD COLUMN IF NOT EXISTS recurring_character boolean NOT NULL DEFAULT false;
