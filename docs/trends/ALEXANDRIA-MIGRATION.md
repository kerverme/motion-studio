# Alexandria migration — 2026-11-15

Base: production `ebbab0eb19bdf3c3c33865817178951f92259acf`, including the latest immutable A/B prompt exports. `main` is older (`4c0e9ed`) and is not a deployment source. Existing branches and worktrees are preserved.

1. Inspect official Firecrawl contracts and pricing; deploy a private browser-free research worker with free catalogue/model checks first.
2. Add a separate durable queue, evidence, checkpoints, and the existing PostgreSQL Firecrawl ledger. Every research job is capped at 25 credits; unknown/ambiguous charges stop execution. OpenAI Web Search precedes paid social calls.
3. Validate source identity, publication date, independent corroboration, and observed metrics. GPT interprets evidence; deterministic scoring records missing dimensions and confidence. Extend the existing Notion database, topic UI, and script context.
4. Run mocked regressions and one bounded production research → Notion → topic → draft workflow; preserve media and publishing settings.
5. Only after the replacement is operational, remove the Jev package/runtime/config and Railway service. Preserve historical evidence and reports. If a provider blocks access, retain the old service and report the blocker.

Official sources inspected:
- https://docs.firecrawl.dev/features/alexandria
- https://docs.firecrawl.dev/api-reference/v2-openapi.json
- https://alexandria.firecrawl.dev/scrapecreators
- https://alexandria.firecrawl.dev/oriane

The official contract defines free discovery as `POST /v2/scrape` with `alexandria.provider=firecrawl`, `capability=find-tools`. Tool execution uses the same endpoint with its discovered provider/capability. ScrapeCreators social tools reviewed here have a documented maximum of 2 credits per call. Oriane's minimum projection costs 35 credits, so it cannot fit this job budget. Prices must be revalidated against authenticated discovery before execution. No personal social login or browser automation is needed by the new runtime.

Existing assets retained: migrations 001–031; all trend, Notion, episode and draft history; the existing source-research ledger; background OpenAI responses; script/art checkpoints; every video pipeline. The legacy research service remains until the cutover gate passes. A separate queue prevents the legacy consumer from claiming new jobs during staging.
