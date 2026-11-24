CREATE TABLE video_arena_snapshots (
  category text PRIMARY KEY CHECK (category IN ('text-to-video','image-to-video','video-editing')),
  source_updated_at date,
  dataset_revision text,
  models jsonb NOT NULL DEFAULT '[]',
  last_success_at timestamptz,
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  error text
);

CREATE TABLE video_arena_sync (
  id integer PRIMARY KEY CHECK (id=1),
  lease_token uuid,
  lease_until timestamptz,
  next_sync_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO video_arena_sync(id) VALUES(1);
