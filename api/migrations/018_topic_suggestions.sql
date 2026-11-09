-- Small, resumable OpenAI idea requests, separate from drafts and production jobs.
CREATE TABLE topic_suggestions (
  id uuid PRIMARY KEY,
  request_hash text NOT NULL,
  request jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  response_id text,
  ideas jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX topic_suggestions_queue_idx ON topic_suggestions (status, created_at);
