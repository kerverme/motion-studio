-- Persist every client id, including multiple tabs sharing the same content/time slot.
CREATE TABLE trend_alexandria_requests (
  request_id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES trend_research_runs(id),
  request_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO trend_alexandria_requests(request_id,run_id,request_hash)
SELECT request_id,run_id,request_hash FROM trend_alexandria_jobs ON CONFLICT DO NOTHING;
CREATE FUNCTION validate_trend_credit_cap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT credit_limit FROM research_jobs WHERE id=NEW.budget_id) <> 25 THEN
    RAISE EXCEPTION 'Trend Research Jobs require a hard 25 credit limit';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_trend_credit_cap BEFORE INSERT OR UPDATE OF budget_id ON trend_alexandria_jobs
FOR EACH ROW EXECUTE FUNCTION validate_trend_credit_cap();
