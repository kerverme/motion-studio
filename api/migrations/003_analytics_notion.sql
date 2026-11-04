-- Post status + analytics from Buffer, and Notion sync bookkeeping.
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS post_status text;            -- Buffer post status (lowercase), e.g. scheduled | sent | error
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS external_link text;          -- URL of the live post on the platform
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS sent_at timestamptz;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS post_error text;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS metrics jsonb;                -- {views: n, reactions: n, ...} latest known
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS metrics_updated_at timestamptz;
ALTER TABLE publish_log ADD COLUMN IF NOT EXISTS checked_at timestamptz;

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id bigserial PRIMARY KEY,
  publish_log_id bigint NOT NULL REFERENCES publish_log(id) ON DELETE CASCADE,
  metrics_updated_at timestamptz,
  metrics jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (publish_log_id, metrics_updated_at)
);

ALTER TABLE episodes ADD COLUMN IF NOT EXISTS notion_page_id text;
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS notion_synced_at timestamptz;
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS notion_error text;
