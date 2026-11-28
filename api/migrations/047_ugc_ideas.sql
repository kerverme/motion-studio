ALTER TABLE ugc_drafts ADD COLUMN intake_hash text;

CREATE TABLE ugc_idea_searches (
  id uuid PRIMARY KEY,
  query text NOT NULL,
  model text NOT NULL,
  state text NOT NULL DEFAULT 'research' CHECK (state IN ('research','summarize','submitting','accepted','done','failed')),
  evidence jsonb NOT NULL DEFAULT '[]',
  cards jsonb NOT NULL DEFAULT '[]',
  notice text,
  response_id text,
  lease_id uuid,
  next_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ugc_idea_pending ON ugc_idea_searches(next_at) WHERE state NOT IN ('done','failed');
CREATE INDEX ugc_idea_history ON ugc_idea_searches(query,created_at DESC) WHERE state='done';
