-- Personal UI: used/unused tracking and the publish log (Buffer).
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS ui_status text NOT NULL DEFAULT 'ready';   -- ready | used
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS used_at timestamptz;

CREATE TABLE IF NOT EXISTS publish_log (
  id bigserial PRIMARY KEY,
  episode_id uuid NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  channel_name text,
  service text,
  mode text NOT NULL,                 -- shareNow | addToQueue | customScheduled
  due_at timestamptz,
  caption text,
  status text NOT NULL,               -- pending | sent | failed
  buffer_post_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS publish_log_episode_idx ON publish_log (episode_id, id DESC);
-- one live (pending/sent) publication per episode+channel: prevents double posting on double click or retry
CREATE UNIQUE INDEX IF NOT EXISTS publish_log_one_live ON publish_log (episode_id, channel_id) WHERE status IN ('pending', 'sent');

-- Alerts and retention bookkeeping
CREATE TABLE IF NOT EXISTS ops_log (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,                 -- alert | retention | backup_check
  message text NOT NULL,
  data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
