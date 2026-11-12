-- Reference photos stay private; delivery packages contain only IDs and hashes.
CREATE TABLE creative_job_references (
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  reference_id uuid NOT NULL,
  name text NOT NULL, look jsonb NOT NULL, reference_image text NOT NULL,
  image_hash text NOT NULL,
  PRIMARY KEY(job_id,reference_id)
);
