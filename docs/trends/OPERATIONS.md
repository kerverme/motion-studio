# Trend Research operations — Alexandria migration

Production UI: https://studio.cloudbath.co/app
Railway builds the web API from `codex/prompt-ab-sol-20261114` and the research worker from `feat/alexandria-trend-research`.

## Current rollout gate

On 2026-11-23 the production picker received 19 supported models from OpenAI. In run `0ad50a8b-8e25-471c-a249-2be8f32edf05`, the owner UI submitted GPT-6.2 Sol, and the worker recorded the same model. After a catalogue price change, the same run resumed from its web plan. Two TikTok searches returned 60 recent posts and cost 2 confirmed Firecrawl credits. The run retained two web sources and zero eligible social patterns. Production verification of an eligible pattern reaching Notion and a draft is still pending. The legacy Jev service has scheduling disabled.

On the same day, run `ccc279b2-3d98-4090-9a11-80a1f150d21c` recovered from the former five-minute scoring timeout. The worker reused the original web plan, 55 recent social posts and 4 Firecrawl credits. GPT-6.2 Sol completed one replacement scoring request. Five web sources and zero eligible trends were recorded.

## Runtime and configuration

- Railway `alexandria-trend-research`: service `1e357e16-5f6d-427c-813c-811d8739ddf6`, repository root `/api`, `Dockerfile.research`, Node 24, no browser, Socai or Jev imports.
- `DATABASE_URL`, `OPENAI_API_KEY`, `FIRECRAWL_API_KEY`, `NOTION_TOKEN` are backend references to the existing API service. Never expose values to the browser or logs.
- `TREND_RESEARCH_MODEL` sets the research picker's default and the worker's startup model check. Owners can select another model from the account's OpenAI catalog before a search. The run records that model for planning, evidence analysis and retries. The writing and research pickers save independent preferences.
- `NOTION_TREND_DATABASE_ID=41875d42-f42b-8193-bfc0-f9458b2f69fc`. Existing records and fields remain. New metadata fields were added in place.
- `MOTION_TREND_RESEARCH_ENABLED=1` enables the manual UI. Automatic schedules are not enabled. `TREND_VERIFIED_PLATFORMS` lists platforms with verified social data. This run confirmed TikTok retrieval. Qualification of an eligible pattern and its downstream synchronization remain separate checks.
- HTTP `/health` and the `alexandria_worker` integration heartbeat report model, catalogue/account/Notion checks. A running container alone does not establish data readiness.

## Research and billing

1. The owner submits topic, audience, platform and a requested result count. All times are stored in UTC and shown in Bangkok time. A requested count is a target, not a reason to invent results.
2. Durable request aliases and a content/time slot reuse one job across duplicate clicks, concurrent tabs and response loss. A separate queue protects jobs from the old consumer during migration. Advisory lock `424249` serializes research and Notion writes.
3. Free `firecrawl/find-tools` discovery validates options, per-call pricing and documented maximum. Read-only `/v2/team/credit-usage` checks the account balance. Reviewed ScrapeCreators tools use a fixed price of 1 or 2 credits per call. The adapter requires the live base price and documented maximum to match, and reserves that amount. A recent job that stopped solely on price before any social request can recheck once using its existing web plan and budget. Oriane starts at 35 and is excluded from the 25-credit budget.
4. The research worker polls each accepted OpenAI response by its saved ID and releases the queue between reads. After 30 minutes of waiting it parks the run for a manual status check. A confirmed cancellation can receive one owner-requested replacement for the same stage. Both attempts keep their usage records, and scoring reuses the saved social evidence and original Firecrawl budget. OpenAI Web Search runs first. Thai and English social queries are selected from verified tool contracts, at most two per requested platform. There is no automatic pagination, provider agent or uncontrolled repair loop.
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

For cutover, verify a live eligible pattern reaches Notion and that selecting it into a draft with `auto_produce=false` carries the original research budget. The 2026-11-23 run covered paid TikTok retrieval, model selection, same-job recovery and spending 2 of the 25 available credits. Before retiring Jev, check for active legacy jobs and dependents. Historical validation reports retain their original dates and outcomes.
