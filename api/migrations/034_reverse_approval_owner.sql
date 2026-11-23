-- Each spending approval belongs to either a Studio draft or a Reverse Video approval.
-- Older Reverse entries retain their original draft link for audit and replay.
ALTER TABLE creative_approvals
  ADD COLUMN reverse_approval_id uuid UNIQUE REFERENCES reverse_approvals(id),
  ALTER COLUMN draft_id DROP NOT NULL,
  ADD CONSTRAINT creative_approvals_one_owner
    CHECK ((draft_id IS NOT NULL) <> (reverse_approval_id IS NOT NULL));
