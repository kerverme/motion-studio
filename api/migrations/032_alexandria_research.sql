-- Additive migration; historical research and Notion IDs are retained.
CREATE TABLE trend_alexandria_catalog (
  provider text PRIMARY KEY, tools jsonb NOT NULL DEFAULT '[]',
  checked_at timestamptz NOT NULL DEFAULT now(), error text
);
CREATE TABLE trend_alexandria_jobs (
  run_id uuid PRIMARY KEY REFERENCES trend_research_runs(id),
  request_id uuid NOT NULL UNIQUE, request_hash text NOT NULL,
  budget_id uuid NOT NULL UNIQUE REFERENCES research_jobs(id),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','done','partial','blocked','failed')),
  checkpoint jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trend_alexandria_queue ON trend_alexandria_jobs(state,updated_at);
ALTER TABLE trend_sources DROP CONSTRAINT trend_sources_platform_check;
ALTER TABLE trend_sources ADD CONSTRAINT trend_sources_platform_check CHECK(platform IN ('tiktok','instagram','youtube'));
ALTER TABLE trend_sources ADD COLUMN provider_name text;
ALTER TABLE trend_sources ADD COLUMN research_model text;
ALTER TABLE trend_sources ADD COLUMN category text;
ALTER TABLE trend_sources ADD COLUMN confidence double precision;
ALTER TABLE trend_sources ADD COLUMN supporting_sources jsonb NOT NULL DEFAULT '[]';
ALTER TABLE trend_sources ADD COLUMN verification_status text NOT NULL DEFAULT 'legacy_unverified';
ALTER TABLE trend_sources ADD COLUMN estimated_credits integer;
ALTER TABLE trend_sources ADD COLUMN actual_credits integer;
ALTER TABLE trend_sources ADD COLUMN research_job_id uuid REFERENCES research_jobs(id);
-- A hard cap for these jobs, independent of optional approvals in older research flows.
CREATE FUNCTION enforce_trend_credit_cap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.credit_limit > 25 AND EXISTS (SELECT 1 FROM trend_alexandria_jobs WHERE budget_id=NEW.id) THEN
    RAISE EXCEPTION 'Trend Research Jobs have a hard 25 credit limit';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trend_credit_cap BEFORE UPDATE ON research_jobs FOR EACH ROW EXECUTE FUNCTION enforce_trend_credit_cap();
