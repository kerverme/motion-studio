CREATE TABLE IF NOT EXISTS product_trend_jobs (
  id uuid PRIMARY KEY,
  query text NOT NULL,
  model text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','researching','analyzing','web_search','done','failed','cancelled')),
  step integer NOT NULL DEFAULT 0,
  sources jsonb NOT NULL DEFAULT '[]',
  fallback_reason text,
  submitted boolean NOT NULL DEFAULT false,
  response_id text,
  next_check timestamptz NOT NULL DEFAULT now(),
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Motion Studio is a single-owner workspace. Other tabs and API replicas share its active search.
CREATE UNIQUE INDEX IF NOT EXISTS product_trend_one_active ON product_trend_jobs ((true))
  WHERE status NOT IN ('done','failed','cancelled');
CREATE TABLE IF NOT EXISTS product_trend_requests (
  request_id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES product_trend_jobs(id)
);
