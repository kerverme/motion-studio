-- A quote retains a knowledge_version even when the endpoint or guide changes.
CREATE TABLE video_prompt_knowledge (
  endpoint_id text NOT NULL,
  version text NOT NULL,
  schema_hash text NOT NULL,
  profile jsonb NOT NULL,
  researched_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(endpoint_id, version)
);
CREATE INDEX video_prompt_knowledge_lookup
 ON video_prompt_knowledge(endpoint_id, schema_hash, checked_at DESC);

-- One external research request per exact documentation revision and refresh window.
-- Keep accepted response IDs for recovery. Ambiguous creates are never submitted again.
CREATE TABLE video_model_guide_research (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id text NOT NULL,
  base_version text NOT NULL,
  refresh_month date NOT NULL,
  status text NOT NULL CHECK(status IN ('submitting','researching','ready','failed','unknown')),
  response_id text,
  model text NOT NULL,
  usage jsonb,
  enriched_profile jsonb,
  checked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(endpoint_id,base_version,refresh_month),
  FOREIGN KEY(endpoint_id,base_version) REFERENCES video_prompt_knowledge(endpoint_id,version)
);
