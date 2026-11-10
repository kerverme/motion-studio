ALTER TABLE drafts ADD COLUMN IF NOT EXISTS director_version smallint NOT NULL DEFAULT 0;
