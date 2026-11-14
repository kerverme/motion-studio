-- Audio is additive evidence: never rewrite the visual evidence of an approved quote.
ALTER TABLE reverse_prompt_selections ADD COLUMN IF NOT EXISTS audio jsonb;
