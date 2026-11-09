-- Narration samples are durable LLM requests, never production drafts/jobs.
CREATE TABLE narration_previews (
  id uuid PRIMARY KEY,
  request_hash text NOT NULL,
  request jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','paused')),
  response_id text,
  example jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX narration_previews_queue_idx ON narration_previews(status,created_at);
