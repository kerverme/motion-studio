CREATE TABLE video_director_research (
  input_hash text PRIMARY KEY,
  result jsonb NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now()
);
