-- Content studio: topic -> Firecrawl research -> generated script + scene spec (draft) -> owner review -> job
CREATE TABLE IF NOT EXISTS drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL,
  note text,                                   -- owner's extra direction (angle, tone, things to include)
  parent_id uuid REFERENCES drafts(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued',       -- queued | researching | writing | ready | failed | submitted | discarded
  auto_produce boolean NOT NULL DEFAULT false, -- submit to the worker as soon as the draft passes every check
  log jsonb NOT NULL DEFAULT '[]'::jsonb,      -- progress lines shown in the UI
  research jsonb NOT NULL DEFAULT '[]'::jsonb, -- every Firecrawl search / page read: query, url, title, collected
  draft jsonb,                                 -- generated content: title, script, scenes, sources, claims, captions, sfx, music
  problems jsonb,                              -- last validation problems
  error text,
  model text,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,    -- tokens and Firecrawl calls
  estimated_credits integer,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  episode_id uuid REFERENCES episodes(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS drafts_status_idx ON drafts (status, created_at DESC);
