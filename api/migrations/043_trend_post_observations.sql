-- Store provider measurements before any AI assessment or Notion publication.
CREATE TABLE trend_post_observations (
  platform text NOT NULL CHECK (platform IN ('tiktok','instagram','youtube')),
  source_id text NOT NULL,
  observed_at timestamptz NOT NULL,
  evidence jsonb NOT NULL,
  PRIMARY KEY (platform,source_id,observed_at)
);
