CREATE TABLE ugc_drafts (
  id uuid PRIMARY KEY,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  document jsonb NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]',
  regenerate_scene text,
  quote jsonb,
  approval jsonb,
  job_id uuid REFERENCES jobs(id),
  source_job_id uuid REFERENCES jobs(id),
  planning jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ugc_drafts_recent ON ugc_drafts(updated_at DESC);
CREATE UNIQUE INDEX ugc_current_job ON ugc_drafts(job_id) WHERE job_id IS NOT NULL;

CREATE TABLE ugc_media (
  id uuid PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES ugc_drafts(id),
  kind text NOT NULL CHECK(kind IN ('image','video')),
  content_type text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  bytes integer NOT NULL CHECK (bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ugc_media_draft ON ugc_media(draft_id);
CREATE INDEX ugc_jobs_draft ON jobs ((package->'ugc'->>'draft_id'), created_at DESC) WHERE package ? 'ugc';

CREATE TABLE ugc_approvals (
  id uuid PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES ugc_drafts(id),
  revision uuid NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id),
  approval jsonb NOT NULL
);
