-- the composer asks the worker to compile and render preview frames of the scene art the model wrote (engine/artkit.py),
-- so the model can fix errors and look at its own drawings before the draft is shown to the owner
CREATE TABLE IF NOT EXISTS art_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid,
  payload jsonb NOT NULL,
  result jsonb,
  status text NOT NULL DEFAULT 'pending',   -- pending | running | done | error
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS art_checks_pending ON art_checks (created_at) WHERE status = 'pending';
