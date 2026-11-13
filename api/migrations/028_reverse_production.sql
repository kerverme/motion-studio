-- Additive integration; no UPDATE/DELETE of existing drafts/jobs/media.
CREATE TABLE reverse_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), origin_key text NOT NULL UNIQUE,
  title text NOT NULL, source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  source jsonb NOT NULL, source_asset_id uuid,
  analysis jsonb, registry jsonb NOT NULL DEFAULT '{"characters":[],"locations":[]}',
  current_revision text, status text NOT NULL DEFAULT 'awaiting_source',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reverse_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES reverse_projects(id),
  shot_id text, role text NOT NULL, storage_key text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), bytes bigint NOT NULL CHECK(bytes>=0),
  content_type text NOT NULL, encryption jsonb, metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE reverse_projects ADD CONSTRAINT reverse_source_asset FOREIGN KEY(source_asset_id) REFERENCES reverse_assets(id);
CREATE TABLE reverse_versions (
  project_id uuid NOT NULL REFERENCES reverse_projects(id), revision text NOT NULL,
  parent_revision text, origin text NOT NULL CHECK(origin IN ('user','planner','repair','initial')),
  plan jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,revision)
);
CREATE TABLE reverse_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES reverse_projects(id),
  purpose text NOT NULL, revision text NOT NULL, quote jsonb NOT NULL, binding text NOT NULL,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reverse_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL REFERENCES reverse_projects(id),
  quote_id uuid NOT NULL UNIQUE REFERENCES reverse_quotes(id), binding text NOT NULL,
  accepted_usd numeric NOT NULL CHECK(accepted_usd>=0), source_confirmed boolean NOT NULL,
  rights_confirmed boolean NOT NULL, approval_origin text NOT NULL,
  job_id uuid UNIQUE REFERENCES jobs(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reverse_steps (
  job_id uuid NOT NULL REFERENCES jobs(id), slot text NOT NULL, project_id uuid NOT NULL REFERENCES reverse_projects(id),
  shot_id text, role text NOT NULL, input_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending', result jsonb, error text,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(job_id,slot)
);
CREATE TABLE reverse_recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
  version integer NOT NULL CHECK(version>0), definition_hash text NOT NULL,
  manifest jsonb NOT NULL, storage_key text NOT NULL, validated boolean NOT NULL DEFAULT false,
  source_project uuid REFERENCES reverse_projects(id), created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(name,version), UNIQUE(definition_hash)
);
CREATE INDEX reverse_jobs_project ON reverse_steps(project_id,shot_id);
CREATE INDEX reverse_assets_project ON reverse_assets(project_id,role);
