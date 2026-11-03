-- Motion Studio schema v1
CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer UNIQUE,                       -- assigned when the episode is delivered
  topic text NOT NULL,
  title_th text NOT NULL,
  status text NOT NULL DEFAULT 'NEW',
  drive_folder_id text,
  drive_folder_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id uuid REFERENCES episodes(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'episode',        -- episode | test_tts | test_render | test_drive
  status text NOT NULL DEFAULT 'NEW',
  stage text,                                  -- current pipeline stage
  progress real NOT NULL DEFAULT 0,
  package jsonb NOT NULL DEFAULT '{}'::jsonb,
  package_sha256 text,
  idempotency_key text UNIQUE,
  stage_results jsonb NOT NULL DEFAULT '{}'::jsonb, -- per-stage outputs used to resume
  budget_credits integer NOT NULL DEFAULT 6000,
  estimated_credits integer,
  used_credits numeric NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  locked_by text,
  locked_until timestamptz,
  error text,
  qa_report jsonb,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (status, locked_until, created_at);
CREATE INDEX IF NOT EXISTS jobs_sha_idx ON jobs (package_sha256);

CREATE TABLE IF NOT EXISTS job_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status text,
  level text NOT NULL DEFAULT 'info',
  message text NOT NULL,
  data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events (job_id, id);

CREATE TABLE IF NOT EXISTS research_sources (
  id bigserial PRIMARY KEY,
  episode_id uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  claim text,
  url text NOT NULL,
  publisher text,
  published text,
  collected text,
  methodology text,
  confidence text,
  limitations text
);

CREATE TABLE IF NOT EXISTS scripts (
  id bigserial PRIMARY KEY,
  episode_id uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  segments jsonb NOT NULL,
  full_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scenes (
  id bigserial PRIMARY KEY,
  episode_id uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  seg_id text NOT NULL,
  position integer NOT NULL,
  storyboard jsonb,
  start_s real,
  end_s real
);

CREATE TABLE IF NOT EXISTS assets (
  id bigserial PRIMARY KEY,
  job_id uuid REFERENCES jobs(id) ON DELETE CASCADE,
  episode_id uuid REFERENCES episodes(id) ON DELETE CASCADE,
  kind text NOT NULL,           -- narration | alignment | sfx | music | timeline | scene_render | video | thumbnail | srt | script | captions | sources | storyboard | archive | mix
  storage_key text NOT NULL,
  bytes bigint,
  sha256 text,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, storage_key)
);

CREATE TABLE IF NOT EXISTS audio_cache (
  cache_key text PRIMARY KEY,   -- sha256 of request parameters
  kind text NOT NULL,
  storage_key text NOT NULL,
  credits numeric,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS render_attempts (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage text NOT NULL,
  attempt integer NOT NULL,
  status text NOT NULL,         -- running | succeeded | failed
  worker text,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS publication_handoffs (
  id bigserial PRIMARY KEY,
  episode_id uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  destination text NOT NULL DEFAULT 'google_drive',
  folder_id text,
  folder_url text,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{name, drive_id, bytes, md5, verified}]
  status text NOT NULL DEFAULT 'READY_TO_POST',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integrations (
  provider text PRIMARY KEY,    -- google_drive
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS counters (
  name text PRIMARY KEY,
  value integer NOT NULL
);
-- EP001 (jelly-cat high-rise) was produced before this system, so delivered numbering continues from 2.
INSERT INTO counters (name, value) VALUES ('episode_number', 1) ON CONFLICT (name) DO NOTHING;
