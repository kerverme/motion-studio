-- Community: winning viewer stories received from the "นี่ถ้าเกิด" website after a closed vote round.
-- The website owns the form, Notion record, moderation, consent and vote ledger; this table keeps the snapshot we received
-- (exactly as sent, after cleaning) and links it to the draft / job / episode made from it. Status is derived in queries.
CREATE TABLE IF NOT EXISTS community_winners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL DEFAULT 'community',
  submission_id text NOT NULL,
  round_id text NOT NULL UNIQUE,               -- one winner per round, ever
  content_revision integer NOT NULL,
  notion_page_id text NOT NULL,
  verified_vote_count integer NOT NULL DEFAULT 0,
  payload jsonb NOT NULL,
  payload_sha text NOT NULL,
  draft_id uuid REFERENCES drafts(id) ON DELETE SET NULL,
  rejected_at timestamptz,
  reject_note text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_winners_submission_idx ON community_winners (submission_id);
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'studio';
ALTER TABLE drafts ADD COLUMN IF NOT EXISTS community_id uuid REFERENCES community_winners(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'studio';
