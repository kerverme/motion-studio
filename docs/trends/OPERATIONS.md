# Jev Trend Research — Cloudbath Studio

This is an additive research adapter and an enhancement to the existing Thai topic
suggestion form. Classic Motion, Text to Video, Reverse, Lemo, ElevenLabs and Buffer
retain their existing providers, settings and approval gates.

## Deployment and rollback

- Branch: `feat/jev-trend-research` in `kerverme/motion-studio`.
- Baseline includes production commit `d9a61cdeef6bea4de02d0a4b670452a02257be10`
  (the newer Reverse prompt comparison work), in addition to main `4c0e9ed`.
- Dedicated Railway service: `jev-trend-research`, ID
  `5d5e1bc3-42f9-429c-b86c-84b983abaa2d`, existing motion-studio project and production environment.
- Build from repository root with `trend-worker/Dockerfile`; private CDP is loopback
  only. `/health` exposes readiness, a heartbeat and sanitized failures, never keys.
- `030_trend_research.sql` is additive and transactionally applied under the same
  migration lock as the API. Worker deployment precedes API feature enablement.
- Enable `MOTION_TREND_RESEARCH_ENABLED=1` on the API **only after live evidence,
  Notion synchronization and topic-generation acceptance pass**. Set
  `TREND_VERIFIED_PLATFORMS=tiktok` or `instagram` (comma-separated if both verified)
  on API and worker. Never label CLI capability detection as verified access.
- Roll back by disabling `MOTION_TREND_RESEARCH_ENABLED` on API and
  `TREND_RESEARCH_SCHEDULE_ENABLED` on worker. Preserve all research tables/history.
  If API rollback is needed, inspect the current deployment first and restore the
  latest compatible production commit, preserving any subsequent work. The inspected
  pre-feature API deployment was `99f54bf2-0b49-44cc-8c1c-ce05c0596d06` at `d9a61cd`.
  Do not reset main or redeploy an old Motion/Lemo worker.

## Dependency and access review

- Jev Social `v0.1.13`, immutable commit
  `2058ea22ad5d6586e1339029bc0cc2715637e0b9`, MIT license, no runtime npm dependencies.
  The npm lock includes the tarball integrity hash. No upstream onboarding installer
  or automatically updated latest binary is executed.
- Socai `v0.6.18`, immutable commit
  `340b9d7b65533a535bafded02659f76fb8b75cb3`, Apache-2.0. Upstream has no Linux release
  binary. Build `socai-cli` from its locked Rust dependency graph with Rust 1.95.0.
  The source tarball SHA-256 is
  `09cdc9d671a8841d778f2a7e616d0fb8d591c34649cfbc659e9dc2decf60fe74`.
- `socai-runtime.patch` enables ONNX dynamic loading and locks libloading 0.9.1.
  This avoids downloading an unused OCR runtime at build time. OCR, transcription,
  media downloading, posting and account interactions are not adapter capabilities.
  Socai's platform browser parsers and access-control behavior are unchanged.
- The Node 24 container runs as `node` under `tini`. Railway Chrome may require
  `TREND_CHROMIUM_NO_SANDBOX=1` because user namespaces are unavailable; this does not
  disable TLS validation or site access controls. Browser and CLI receive an explicit
  environment allowlist, no application/provider secrets. Each job has a fresh
  private directory, Chrome profile, socai socket and owned daemon process group.
  Cleanup never invokes the upstream machine-wide `socai stop` sweep.
- All telemetry and update checks are off. Jev decisions use the existing OpenAI
  Responses transport with GPT-6.1 Terra, not an additional OpenRouter account.
  A login, CAPTCHA or access gate must remain a visible failure; do not use stealth
  plugins or security bypasses. Phase 1 uses public guest access only. No persistent
  social account tokens or cookies are stored.

## Evidence and scoring

Canonical post URLs and `(platform, source_id)` have independent unique constraints.
Instagram reels/posts share their shortcode identity. TikTok video IDs remain stable
across username changes. SQL retains original discovery time and per-run snapshots.
Unavailable metrics are `null`; abbreviated or approximate view counts are not
silently promoted to exact counts. Missing publication timestamps stay unknown.

Eligibility requires a detail read, available source, recent observation, and either:

1. An observed original publication within the rolling previous seven days, with
   at least 10,000 observed views or 1,000 observed likes; or
2. Two real snapshots in that window separated by at least six hours, with at least
   1,000 additional views and 10% growth, or 100 additional likes and 10% growth.

An older post checked today remains Expired without actual growth evidence. A
missing date, missing popularity evidence or unopened detail remains Unverified.
The current observation does not invent historical growth. Notion must successfully
synchronize before an Active record is eligible for topic suggestions.

Default score, rounded to one decimal:

`0.35 × popularity + 0.25 × freshness + 0.25 × suitability + 0.15 × novelty`

- Popularity: capped maximum of `16 × log10(views)`, `22 × log10(likes)`, or 80
  when actual growth qualifies; unknown metrics contribute nothing.
- Freshness: 100 decreasing linearly to 0 over seven days from publication or the
  timestamp of qualifying observed growth, never from a mere check.
- Suitability: Terra's 0–100 assessment of an original Thai animated explanation,
  with an explanation based only on observed content. Failure gives no eligibility.
- Novelty: 100 if this source has not been used in Studio; 0 after selection for a draft.

`TREND_SCORE_WEIGHTS` accepts JSON with the four named weights totaling one.
`TREND_MIN_SCORE` defaults to 70. The production window remains fixed at seven days.
Each source retains score components, reasons and its original observed metadata.
An idea can link multiple source IDs; all individual evidence remains available.

## Notion

Database: https://www.notion.so/41875d42f42b8193bfc0f9458b2f69fc

Data source: `41875d42-f42b-819c-82f4-000b53875e4c`.
The runtime uses database ID `41875d42-f42b-8193-bfc0-f9458b2f69fc` with the existing
`NOTION_TOKEN`. That integration must be explicitly connected to the new database.
MCP access alone does not establish runtime integration access.

The required 21 properties are present. UTC timestamps are stored separately in
SQL and sent as ISO timestamps; Studio displays Asia/Bangkok. History is permanent.
Notion writes are serialized under a distributed lock. Before create, search by
stable Source ID and canonical URL. An ambiguous create response is marked
`create_uncertain`: reconcile with a subsequent lookup, never blindly recreate.
Used-in-Studio and created-topic changes are synchronized through the same queue.

## Scheduling, cost and failure handling

The worker uses a PostgreSQL advisory lock across replicas; phase-one concurrency
is deliberately one. Six-hour slots have unique request keys. Manual requests share
a ten-minute platform slot to prevent duplicate clicks/tabs. `TREND_BOOTSTRAP_TESTS_JSON`
is an operator-only, bounded array (maximum four jobs, maximum six posts/job) for
controlled acceptance tests. `probe_only` jobs perform a bounded public read through
Jev with no paid LLM call and cannot assign an eligible trend score.

- `TREND_RESEARCH_SCHEDULE_ENABLED=1` enables six-hour scheduling, only for explicitly
  verified platforms. Default off until acceptance.
- `TREND_MAX_STEPS`: default 6, hard maximum 8 browser decisions.
- `TREND_TIMEOUT_MS`: bounded 30–600 seconds, including provider decisions.
- `TREND_DAILY_BUDGET_USD`: default $2, hard maximum $10 for this adapter. Each OpenAI
  call reserves $0.12 before dispatch; completed usage replaces the reservation with
  its estimate, while unknown charges retain the reservation. Provider billing may
  differ; this is an operational estimate limit, not a guaranteed invoice cap.
- OpenAI creates are checkpointed and not blindly retried after a disconnect.
  Existing background-response polling retries reads only (and explicit rejected 429s).
  Calls with unknown outcomes require reconciliation. Interrupted research jobs are
  marked failed rather than automatically recreating paid requests.
- Ledger: run/provider/model, response ID, token usage, API usage, estimated USD,
  nullable actual USD, failure, browser action count and duration. Terra estimates
  use standard $1/M input, $5/M output, $0.05/M cached input, $1.25/M cache write;
  hosted search adds an estimated $0.01/call. Actual billed cost stays null until
  billing reconciliation. Railway compute is additional and depends on measured use.
- This adapter does not call Firecrawl. Existing draft fact-checking retains its
  cumulative 25-credit per-Research-Job Firecrawl ceiling and OpenAI-first policy.
- Notion sync failures do not create fabricated eligibility. Trending returns an
  empty list and a Thai explanation when evidence is insufficient. Smart Mix clearly
  labels its Creative-only fallback. Creative does not depend on social availability.
- No video, voice, sound-effect generation or Buffer publication is triggered by research.

## Topic and script behavior

Smart Mix is default, topic count is 10 and topic brain remains GPT-6.1 Terra
independent of the script brain. The server joins generated trend IDs to verified
records; the model cannot supply source URLs or invent evidence. Expandable references
show source, publication, last verification, platform and score. Choosing an idea
saves its suggestion ID/index. Manual topic edits clear that association.

Draft creation validates selection against the saved suggestion. Evidence is stored
atomically on the draft and preserved on rewrite. Before script planning, exact
source URLs are rechecked using the existing source-verification implementation.
Only returned retrieval evidence enters the existing fetched-URL ledger. Missing
sources cause a visible warning and must not support time-sensitive claims.

## Validation commands

```
cd api
npm run typecheck
node --import tsx --test src/*.test.ts
cd ../trend-worker
npm run check
npm test
```

Live acceptance evidence and deployment hashes are recorded separately. Do not
equate mocked tests, a passing health endpoint, or CLI platform help with live trend
support. Keep the feature and scheduler gated until the full acceptance path passes.
