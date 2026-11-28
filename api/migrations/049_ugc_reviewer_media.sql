-- Keep completed job receipts readable after the owner removes a portrait from its draft.
ALTER TABLE ugc_media ADD COLUMN IF NOT EXISTS detached_at timestamptz;
