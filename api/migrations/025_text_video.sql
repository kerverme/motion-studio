CREATE TABLE IF NOT EXISTS text_video_plans (
  id uuid PRIMARY KEY,
  request_hash text NOT NULL,
  request jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  response_id text,
  plan jsonb,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  quote jsonb,
  approval jsonb,
  job_id uuid REFERENCES jobs(id),
  error text,
  progress text,
  usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS text_video_calls (
  job_id uuid NOT NULL REFERENCES jobs(id),
  slot text NOT NULL,
  approval_id uuid NOT NULL,
  provider text NOT NULL,
  input_hash text NOT NULL,
  status text NOT NULL DEFAULT 'submitting',
  request_id text,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id,slot,approval_id)
);
CREATE INDEX IF NOT EXISTS text_video_calls_latest ON text_video_calls(job_id,slot,created_at DESC);
