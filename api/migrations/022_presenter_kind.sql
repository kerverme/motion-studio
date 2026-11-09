ALTER TABLE drafts ADD COLUMN IF NOT EXISTS presenter_kind text NOT NULL DEFAULT 'legacy';
