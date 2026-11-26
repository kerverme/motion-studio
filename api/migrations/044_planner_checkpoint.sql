-- The planner's input, turn boundary and paid request receipts survive service restarts.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS planner_checkpoint jsonb;
