-- Additive only. Research evidence is permanent and separate from clip retention.
CREATE TABLE trend_research_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_key text NOT NULL UNIQUE,
  request jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','partial','blocked','failed')),
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  heartbeat_at timestamptz, worker_id text, error text,
  browser_actions integer NOT NULL DEFAULT 0, duration_ms integer,
  evidence_count integer NOT NULL DEFAULT 0, eligible_count integer NOT NULL DEFAULT 0,
  details jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX trend_runs_queue ON trend_research_runs(status, created_at);
CREATE TABLE trend_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), platform text NOT NULL CHECK(platform IN ('tiktok','instagram')),
  source_id text NOT NULL, source_url text NOT NULL UNIQUE, title text NOT NULL,
  published_at timestamptz, discovered_at timestamptz NOT NULL DEFAULT now(),
  last_checked timestamptz NOT NULL, last_trend_evidence_at timestamptz,
  views bigint, likes bigint, comments bigint, engagement_rate double precision,
  trend_score double precision NOT NULL DEFAULT 0, score_details jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'Unverified' CHECK(status IN ('Active','Expired','Unverified','Failed')),
  research_summary text NOT NULL DEFAULT '', evidence jsonb NOT NULL DEFAULT '{}', suggested_angles jsonb NOT NULL DEFAULT '[]',
  used_in_studio boolean NOT NULL DEFAULT false, created_topic text,
  research_run_id uuid REFERENCES trend_research_runs(id),
  notion_page_id text, notion_synced_at timestamptz, notion_sync_error text,
  UNIQUE(platform,source_id)
);
CREATE INDEX trend_sources_eligible ON trend_sources(status,last_trend_evidence_at DESC);
CREATE TABLE trend_evidence_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES trend_sources(id),
  research_run_id uuid NOT NULL REFERENCES trend_research_runs(id), observed_at timestamptz NOT NULL,
  evidence jsonb NOT NULL, UNIQUE(source_id,research_run_id)
);
CREATE TABLE trend_provider_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), research_run_id uuid REFERENCES trend_research_runs(id),
  topic_suggestion_id uuid REFERENCES topic_suggestions(id), call_key text NOT NULL UNIQUE,
  provider text NOT NULL DEFAULT 'openai', model text NOT NULL,
  status text NOT NULL DEFAULT 'started', response_id text, usage jsonb,
  estimated_usd numeric, actual_usd numeric, reserved_usd numeric NOT NULL DEFAULT 0,
  api_usage jsonb NOT NULL DEFAULT '{}', error text,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
ALTER TABLE topic_suggestions ADD COLUMN trend_context jsonb;
ALTER TABLE topic_suggestions ADD COLUMN idea_details jsonb;
ALTER TABLE topic_suggestions ADD COLUMN availability jsonb;
ALTER TABLE drafts ADD COLUMN trend_context jsonb;
