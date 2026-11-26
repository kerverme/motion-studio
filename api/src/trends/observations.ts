import type {SocialEvidence} from './evidence.js';
import type {Queryable} from './store.js';

export const GROWTH_INTERVAL_MS = 6 * 3600_000;
const observationsJSON = (entries:SocialEvidence[]) => JSON.stringify(entries.map(e=>({
  platform:e.platform, source_id:e.sourceId, observed_at:e.observedAt, evidence:e,
})));

export async function recordObservations(db:Queryable, entries:SocialEvidence[]) {
  if (!entries.length) return;
  await db.query(`INSERT INTO trend_post_observations (platform,source_id,observed_at,evidence)
    SELECT platform,source_id,observed_at,evidence
    FROM jsonb_to_recordset($1::jsonb) AS e(platform text,source_id text,observed_at timestamptz,evidence jsonb)
    ON CONFLICT DO NOTHING`,[observationsJSON(entries)]);
}

export async function previousObservations(db:Queryable, entries:SocialEvidence[]):Promise<SocialEvidence[]> {
  if (!entries.length) return [];
  const {rows} = await db.query(`WITH targets AS (
    SELECT DISTINCT ON (platform,source_id) platform,source_id,observed_at
    FROM jsonb_to_recordset($1::jsonb) AS e(platform text,source_id text,observed_at timestamptz)
    ORDER BY platform,source_id,observed_at DESC
  ), observations AS (
    SELECT e.evidence,e.observed_at,t.platform,t.source_id FROM targets t
      JOIN trend_post_observations e ON e.platform=t.platform AND e.source_id=t.source_id
      AND e.observed_at <= t.observed_at - interval '6 hours' AND e.observed_at >= now() - interval '7 days'
    UNION ALL
    SELECT e.evidence,e.observed_at,t.platform,t.source_id FROM targets t
      JOIN trend_sources s ON s.platform=t.platform AND s.source_id=t.source_id
      JOIN trend_evidence_snapshots e ON e.source_id=s.id
      AND e.observed_at <= t.observed_at - interval '6 hours' AND e.observed_at >= now() - interval '7 days'
  )
  SELECT DISTINCT ON (platform,source_id) evidence FROM observations
  WHERE evidence->>'views' IS NOT NULL
  ORDER BY platform,source_id,observed_at DESC`,[observationsJSON(entries)]);
  return rows.map(row=>row.evidence);
}
