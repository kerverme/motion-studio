-- Immutable narrative graphs, owner review revisions and generated-only inspection evidence.
CREATE TABLE reverse_scene_graphs (
 id text PRIMARY KEY, project_id uuid NOT NULL REFERENCES reverse_projects(id),
 version_id text NOT NULL REFERENCES reverse_prompt_versions(id), source_sha256 text NOT NULL,
 locks_hash text NOT NULL, input_hash text NOT NULL, graph jsonb NOT NULL,
 review jsonb NOT NULL DEFAULT '{}', parent_id text REFERENCES reverse_scene_graphs(id),
 provenance jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reverse_scene_graph_versions ON reverse_scene_graphs(project_id,version_id,created_at);
CREATE TABLE reverse_inspection_evidence (
 id text PRIMARY KEY, project_id uuid NOT NULL REFERENCES reverse_projects(id),
 graph_id text NOT NULL REFERENCES reverse_scene_graphs(id), asset_id uuid NOT NULL REFERENCES reverse_assets(id),
 asset_sha256 text NOT NULL, evidence jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reverse_video_inspections (
 id text PRIMARY KEY, project_id uuid NOT NULL REFERENCES reverse_projects(id),
 graph_id text NOT NULL REFERENCES reverse_scene_graphs(id), version_id text NOT NULL REFERENCES reverse_prompt_versions(id),
 asset_id uuid NOT NULL REFERENCES reverse_assets(id), asset_sha256 text NOT NULL,
 evidence_id text NOT NULL REFERENCES reverse_inspection_evidence(id), report jsonb NOT NULL,
 provenance jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
