-- Additive, immutable source selections and Prompt A/B revisions.
CREATE TABLE reverse_prompt_selections (
 id text PRIMARY KEY, project_id uuid NOT NULL REFERENCES reverse_projects(id),
 source_sha256 text NOT NULL, request jsonb NOT NULL, evidence jsonb,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reverse_prompt_versions (
 id text PRIMARY KEY, project_id uuid NOT NULL REFERENCES reverse_projects(id),
 selection_id text NOT NULL REFERENCES reverse_prompt_selections(id),
 parent_id text REFERENCES reverse_prompt_versions(id),
 document jsonb NOT NULL, replacements jsonb NOT NULL,
 prompt_a text NOT NULL, prompt_b text NOT NULL, locks_hash text NOT NULL,
 provenance jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reverse_prompt_selection_project ON reverse_prompt_selections(project_id);
CREATE INDEX reverse_prompt_version_project ON reverse_prompt_versions(project_id,created_at);
