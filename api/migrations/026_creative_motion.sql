-- Additive: legacy drafts/packages and the fal ledger remain untouched.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS creative jsonb;
CREATE TABLE creative_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL REFERENCES drafts(id), revision text NOT NULL,
  quote jsonb NOT NULL, allocations jsonb NOT NULL,
  max_usd numeric NOT NULL CHECK(max_usd > 0 AND max_usd <= 1000),
  unknown_ack boolean NOT NULL DEFAULT false,
  job_id uuid UNIQUE REFERENCES jobs(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(draft_id, revision)
);
CREATE TABLE creative_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id), call_key text NOT NULL,
  provider text NOT NULL, model text NOT NULL, category text NOT NULL,
  request_hash text NOT NULL, reserved_usd numeric NOT NULL CHECK(reserved_usd >= 0),
  actual_usd numeric CHECK(actual_usd >= 0), usage jsonb,
  status text NOT NULL CHECK(status IN ('reserved','started','complete','uncertain','reconciled')),
  provider_id text, result jsonb, error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, call_key)
);
CREATE INDEX creative_calls_job ON creative_calls(job_id);
CREATE TABLE creative_cache (
  cache_key text PRIMARY KEY, category text NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
