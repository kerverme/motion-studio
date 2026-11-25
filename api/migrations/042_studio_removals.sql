-- Keep production receipts and idempotency records while making removal terminal.
ALTER TABLE drafts ADD COLUMN removed_at timestamptz,
  ADD CONSTRAINT removed_draft_terminal CHECK (removed_at IS NULL OR status='discarded');
ALTER TABLE jobs ADD COLUMN removed_at timestamptz,
  ADD CONSTRAINT removed_job_terminal CHECK (removed_at IS NULL OR status='CANCELLED');

-- Delivery uses a separate transaction from the final job status. Serialize its handoff with removal.
CREATE FUNCTION guard_removed_job_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT removed_at FROM jobs WHERE id=NEW.job_id FOR UPDATE) IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot deliver a removed job';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_removed_job_handoff BEFORE INSERT ON publication_handoffs
  FOR EACH ROW WHEN (NEW.job_id IS NOT NULL) EXECUTE FUNCTION guard_removed_job_handoff();
