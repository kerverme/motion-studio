-- Visual style chosen in the studio composer ('auto' = the brain picks one that suits the story and differs from recent episodes).
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS style text NOT NULL DEFAULT 'auto';
