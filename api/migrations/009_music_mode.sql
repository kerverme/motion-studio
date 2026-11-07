-- Music per clip: 'default' = the channel's default track (reused from a finished episode, no new music generation),
-- 'ai' = new music generated for the story. The owner's default is the track of EP002 (the "คนชื่อตั้ม" clip).
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS music_mode text NOT NULL DEFAULT 'default';
INSERT INTO integrations (provider, data) VALUES ('default_music', '{"episode": 2}'::jsonb) ON CONFLICT (provider) DO NOTHING;
