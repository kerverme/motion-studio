ALTER TABLE ugc_media ADD COLUMN role text NOT NULL DEFAULT 'product'
  CHECK (role IN ('product','presenter','frame','opening'));
ALTER TABLE ugc_media ADD COLUMN details jsonb NOT NULL DEFAULT '{}';

ALTER TABLE ugc_drafts ADD COLUMN image_quote jsonb;
ALTER TABLE ugc_drafts ADD COLUMN image_job_id uuid REFERENCES jobs(id);

CREATE TABLE ugc_scene_reviews (
  job_id uuid NOT NULL REFERENCES jobs(id),
  scene_id text NOT NULL,
  checks jsonb NOT NULL,
  note text NOT NULL DEFAULT '',
  PRIMARY KEY (job_id, scene_id)
);
