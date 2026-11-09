-- Removing a clip from the library keeps its episode and Notion audit record.
ALTER TABLE episodes ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
