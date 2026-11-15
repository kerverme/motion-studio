# Trend Research operations — Alexandria migration

Production UI: https://studio.cloudbath.co/app
Branch: `feat/alexandria-trend-research`. Preserve the latest production scene director and all existing rendering pipelines.

## Current rollout gate

The browser-free adapter, migrations, UI and mocked integration are deployed. Authenticated catalogue discovery succeeds, and the account can access the configured research model. The first live social job returned `insufficient_credits` on both TikTok and Instagram. **Social retrieval and the full Notion social-evidence workflow are not yet production-verified.** Do not remove the old `jev-trend-research` service or its package until a funded bounded smoke test passes. It remains disabled for scheduling and is not a dependency of the new queue.

## Runtime and configuration

- Railway `alexandria-trend-research`: service `1e357e16-5f6d-427c-813c-811d8739ddf6`, repository root `/api`, `Dockerfile.research`, Node 24, no browser, Socai or Jev imports.
- `DATABASE_URL`, `OPENAI_API_KEY`, `FIRECRAWL_API_KEY`, `NOTION_TOKEN` are backend references to the existing API service. Never expose values to the browser or logs.
- `TREND_RESEARCH_MODEL` is required and verified through the account's OpenAI models endpoint before research. The initial live-verified configuration is `gpt-6.1-terra`.
- `NOTION_TREND_DATABASE_ID=41875d42-f42b-8193-bfc0-f9458b2f69fc`. Existing records and fields remain. New metadata fields were added in place.
- `MOTION_TREND_RESEARCH_ENABLED=1` enables the manual UI. Automatic schedules are not enabled. `TREND_VERIFIED_PLATFORMS` must not be populated until live social retrieval succeeds.
- HTTP `/health` and the `alexandria_worker` integration heartbeat report model, catalogue/account/Notion checks. A running container alone does not establish data readiness.

## Research and billing

1. The owner submits topic, audience, platform and a requested result count. All times are stored in UTC and shown in Bangkok time. A requested count is a target, not a reason to invent results.
2. Durable request aliases and a content/time slot reuse one job across duplicate clicks, concurrent tabs and response loss. A separate queue protects jobs from the old consumer during migration. Advisory lock `424249` serializes research and Notion writes.
3. Free `firecrawl/find-tools` discovery validates options, per-call pricing and documented maximum. Read-only `/v2/team/credit-usage` checks the account balance. Reviewed ScrapeCreators tools cost at most 2 credits. Oriane starts at 35 and is excluded from the 25-credit budget.
4. OpenAI Web Search runs first. Thai and English social queries are selected from verified tool contracts, at most two per requested platform. There is no automatic pagination, provider agent or uncontrolled repair loop.
5. Every paid call first reserves its maximum in the existing PostgreSQL research ledger. Lock `731125` serializes Firecrawl calls across jobs. All operations sharing the Research Job count together, including later script research and rewrites. Database triggers forbid raising a trend job above 25. Credits do not transfer between jobs.
6. Cache hits retain collection timestamps. Timeout/unknown charge keeps the reservation and stops further work. Paid POSTs are never automatically repeated. Failed provider calls report actual zero only when the response explicitly reports zero; missing usage stays unknown. Reservations are conservative, not a claim of money spent.
7. Source IDs, canonical URLs, publication times and metric fields are mapped from provider data. Recent searches can contain old results; local seven-day filtering is mandatory. Null metrics remain null. Instagram play counts may be inaccurate and exclude Facebook views.
8. GPT groups specific matching topics and supplies verbatim supporting caption quotes. A pattern needs at least two distinct creators. Deterministic scoring reports recency, engagement, observed growth, platform diversity, AI relevance/novelty, evidence quality and missing fields. One snapshot cannot establish growth; one popular post cannot establish a trend.
9. Eligible patterns must also be synchronized to the existing Notion database. Exact stable IDs and canonical URLs reconcile creates, including uncertain create responses. Historical records are never removed.
10. Trending topics use only eligible evidence. Web Research ideas use saved web sources and are labelled separately. Smart Mix can combine creative and research-based ideas. The existing scriptwriter reopens original sources before asserting facts. A selected research topic carries its existing budget into the draft; it does not silently receive a fresh 25 credits.

## Notion field semantics

Provider metrics are observations, not independent fact verification. Confidence and two subjective score dimensions are AI-assisted judgments. `Estimated Credits` is the job's committed maximum, and `Actual Credits` is null if any request lacks a confirmed charge. These are **job totals repeated on evidence records; do not sum them across rows from one run**. `Verification=corroborated_pattern` means agreement within the retrieved sample, not a national ranking or a guarantee of virality. Health claims require primary-source checking during scriptwriting.

## Checks and cutover

Run `npm run typecheck` and `node --import tsx --test --test-concurrency=1 src/*.test.ts` in `api/`. Automated provider fixtures come from official contracts recorded on 2026-11-15; mocks are not proof of live social access.

After the owner resolves the actual Firecrawl credit rejection, run a bounded social job, inspect returned posts/dates/metrics, confirm Notion synchronization and select a corroborated topic into a draft with `auto_produce=false`. Check the shared ledger remains at or below 25 and duplicate request IDs reuse the same job. Only then confirm no active legacy jobs/dependents, remove the old service and `trend-worker/` package, retire its variables and verify production again. Do not reset `main` or overwrite a newly deployed commit. Historical validation reports are retained as historical evidence, not current operating instructions.
