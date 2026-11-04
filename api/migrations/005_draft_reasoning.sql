-- per-draft AI settings chosen in the UI (model is already stored in drafts.model)
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS reasoning text;
