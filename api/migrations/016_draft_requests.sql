-- Keep ambiguous browser retries on the original draft, including after a restart.
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS request_key text UNIQUE;
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS request_hash text;
