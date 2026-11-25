// Older Reverse approvals used an empty draft carrying these two IDs to anchor the spending ledger.
export const IS_STUDIO_DRAFT = "(draft IS NOT NULL OR NOT COALESCE(creative ?& ARRAY['reverse_project', 'quote_id'], false))";
export const STUDIO_DRAFT_BY_ID = `SELECT * FROM drafts WHERE id=$1 AND ${IS_STUDIO_DRAFT} AND removed_at IS NULL`;
export const DAILY_STUDIO_DRAFT_COUNT = `SELECT count(*)::int AS n FROM drafts WHERE created_at > now() - interval '1 day' AND ${IS_STUDIO_DRAFT}`;
