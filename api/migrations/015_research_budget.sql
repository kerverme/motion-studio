-- One durable budget for a research lineage, including rewrites/retries.
CREATE TABLE research_jobs (
  id uuid PRIMARY KEY,
  credit_limit integer NOT NULL DEFAULT 25 CHECK (credit_limit > 0),
  committed_credits integer NOT NULL DEFAULT 0 CHECK (committed_credits >= 0),
  blocked_reason text,
  approved_at timestamptz,
  CHECK (credit_limit <= 25 OR approved_at IS NOT NULL),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE drafts ADD COLUMN research_job_id uuid;
WITH RECURSIVE lineage AS (
  SELECT id, id AS root FROM drafts WHERE parent_id IS NULL
  UNION ALL
  SELECT d.id, l.root FROM drafts d JOIN lineage l ON d.parent_id=l.id
)
UPDATE drafts d SET research_job_id=l.root FROM lineage l WHERE l.id=d.id;
UPDATE drafts SET research_job_id=id WHERE research_job_id IS NULL;
INSERT INTO research_jobs (id, committed_credits, blocked_reason)
SELECT research_job_id,
  CASE WHEN bool_or(COALESCE((usage->>'firecrawl_calls')::integer,0)>0 OR
    EXISTS (SELECT 1 FROM jsonb_array_elements(research) e WHERE e->>'kind' IN ('read','search'))) THEN 25 ELSE 0 END,
  CASE WHEN bool_or(COALESCE((usage->>'firecrawl_calls')::integer,0)>0 OR
    EXISTS (SELECT 1 FROM jsonb_array_elements(research) e WHERE e->>'kind' IN ('read','search')))
    THEN 'legacy_usage_unknown' ELSE NULL END
FROM drafts GROUP BY research_job_id;
ALTER TABLE drafts ALTER COLUMN research_job_id SET DEFAULT gen_random_uuid();
ALTER TABLE drafts ALTER COLUMN research_job_id SET NOT NULL;
CREATE INDEX drafts_research_job_idx ON drafts(research_job_id);

CREATE TABLE firecrawl_requests (
  id uuid PRIMARY KEY,
  research_job_id uuid NOT NULL REFERENCES research_jobs(id),
  endpoint text NOT NULL,
  cache_key text NOT NULL,
  source_urls jsonb NOT NULL DEFAULT '[]',
  reserved_credits integer NOT NULL CHECK (reserved_credits > 0),
  reported_credits integer,
  state text NOT NULL CHECK (state IN ('reserved','completed','failed','uncertain')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX firecrawl_requests_job_idx ON firecrawl_requests(research_job_id);
CREATE TABLE firecrawl_cache (
  cache_key text PRIMARY KEY,
  payload jsonb NOT NULL,
  source_urls jsonb NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE TABLE research_web_reads (
  research_job_id uuid NOT NULL REFERENCES research_jobs(id),
  source_key text NOT NULL,
  result jsonb NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(research_job_id, source_key)
);
CREATE TABLE research_budget_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_job_id uuid NOT NULL REFERENCES research_jobs(id),
  previous_limit integer NOT NULL,
  new_limit integer NOT NULL,
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now()
);
