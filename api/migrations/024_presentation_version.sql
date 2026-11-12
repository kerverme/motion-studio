-- Existing ready drafts and failed checkpoints retain their rendered presentation.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS presentation_version smallint NOT NULL DEFAULT 0;
