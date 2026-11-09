ALTER TABLE drafts ADD COLUMN IF NOT EXISTS narration_style text NOT NULL DEFAULT 'standard';
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS narration_custom text NOT NULL DEFAULT '';
