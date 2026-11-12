# Motion Studio

Topic in → narrated, subtitled, sound-designed 1080×1920 MP4 in Google Drive (`Motion Studio / Ready to Post`).
The original Create flow draws visuals by code (Pillow/NumPy, SVG and FFmpeg).
The separate **Text to Video** sidebar uses fal.ai video generation; ElevenLabs supplies narration.

## Text to Video

OpenAI plans a connected story with 4/6/8 shots of 15 seconds for a 60/90/120-second maximum.
Supported model pairs are H3 Max and Grok Imagine Video 1.5 (text-to-video first, image-to-video thereafter).
The worker extracts the previous normalised clip's final visible frame and passes it as the next input image.
Identity and smooth transitions remain generative quality limitations; the owner reviews the delivered clip.

Planning never submits media. The owner edits narration, shot prompts and handoffs, then requests an itemised
fal/ElevenLabs estimate and explicitly confirms it. The estimate records resolution-specific published fal
rates (verified 2026-11-12), live account base rates, and an explicit USD/1,000-character ElevenLabs API rate.
The initial voice estimate uses Eleven v3's published API rate of $0.08/1,000 characters (verified 2026-11-12
at https://elevenlabs.io/pricing/api), with a 10% character allowance. Owners can adjust the rate for their
account; included quota is never assumed free. UI amounts round upward to cents. Legacy credit-based quote
requests remain supported for older clients, but the new UI requires a fresh character-based quote before approval.
Unknown prices block production. Estimates are not provider billing guarantees. H3 uses conservative standard
rates and allows one extra billed second per shot; Grok includes each bridging image. No paid music or SFX
are silently added. OpenAI planning charges are separate and disclosed before planning.

Setup: set **FAL_KEY** on `motion-api`; set `FAL_KEY=${{motion-api.FAL_KEY}}` on `motion-worker`.
Keep existing `ELEVENLABS_API_KEY` and `MOTION_DEFAULT_VOICE_ID` on the worker. Never put keys in the UI.
Worker capabilities are refreshed every 30 seconds; production is blocked when unavailable/stale.
Migration 025 adds plans and a durable paid-call ledger. Deploy worker before API.

Approval is bound to the plan/revision and expires before first submission after 15 minutes. Once approved,
new paid calls are allowed for eight hours, with fal rates rechecked before each new shot. Changed rates stop
the job for a new estimate. Duplicate confirmation returns the same job. Each provider call is reserved in
Postgres BEFORE its POST: a missing response is held for reconciliation, never automatically resubmitted.
Known failed calls can be quoted again; completed/accepted calls are reused and excluded from repair costs.
The original job retry endpoint cannot bypass this approval flow. A provider request with unknown outcome
requires operator reconciliation using provider history; it cannot be retried via another approval.

The final clip is trimmed/padded to the selected duration, with word-aligned Thai Kanit subtitles and narration
fitted up to 1.2x. If narration is still too long, production stops before fal instead of cutting spoken words.
Deliveries appear in Ready with creator model provenance and use the existing Notion synchronisation.
Nothing is posted automatically. The source archive includes the shot/request and approval manifest.

Tests: `cd api && node --import tsx --test src/text-video.test.ts`; worker tests include an explicitly enabled
60-second FFmpeg integration using synthetic provider fixtures:
`TEXT_VIDEO_FULL_TEST=1 python -m unittest discover -s worker/tests -p test_text_video.py -v`.
These fixtures do not demonstrate real fal generation quality; paid production must be approved separately.

New Studio drafts use the classic motion presentation from EP004: the original Kanit headings, animated cards,
counters, stamps and iris cuts, combined with story-specific drawings. `storyboard.presentation_version: 1`
requires a `layout` per shot and matching `scene.graphic` data (see `api/src/presentation.ts`). The scene stays
`type: custom`; the engine draws its code and then the selected graphic, without adding a stock mascot.
Migration 024 keeps existing drafts at version 0. New drafts and intentional rewrites use version 1; an unchanged
failed-job retry preserves its version and saved artwork. Deploy the worker before enabling new API generation.

## How the work is split

| Step | Where | Notes |
|---|---|---|
| Research, fact-check, Thai script, storyboard, scene code | Claude (chat) | Produces an *episode package* (`episodes/<ep>/package.json`) |
| Job API, state, budgets, Drive OAuth | `motion-api` (Node + TS, Hono) | Authenticated; Postgres-backed |
| Audio, timeline, render, QA, delivery | `motion-worker` (Python, FFmpeg) | Durable; runs without a Claude session |
| Artifacts | `motion-assets` bucket | `jobs/<job-id>/…`, `cache/{tts,sfx,music}/…` |

Statuses: `NEW → RESEARCHING → FACT_CHECKING → SCRIPTING → CODING_ANIMATION → GENERATING_AUDIO → BUILDING_TIMELINE → RENDERING → QUALITY_CHECK → UPLOADING_DRIVE → READY_TO_POST`.
The first five are completed by Claude before submission and recorded when the job is created.

## Engine (worker/engine)

* `core.py` – timeline access (`SEG`, `wt(seg, word, n)`), easing, text (Kanit, Thai shaping via raqm), word-highlight subtitles, jelly cat, icons, `svg_img()`.
* `characters.py` – parametric chibi person (`draw_person`, style dict: hair, skin, outfit, glasses…).
* `props.py` – sets and widgets (brick wall set, crowd, stamps, checks…).
* `render.py` – frame compositor (iris transitions, series tag, subtitles, progress bar) and per-scene encoder.

Episode scene code defines `SCENES = {segment_id: (draw_fn, (top_rgb, bottom_rgb))}` and keys every animation to
words in the real narration with `wt()`, so timing adapts to whatever audio ElevenLabs returns.

## Episode package (POST /jobs body: `{"kind":"episode","package":{…}}`)

`topic, title_th, series_tag, script[{id,text}], voice{voice_id,model_id,language_code,stability}, music{prompt,model_id,volume}|null,
sfx[{id,prompt,duration,cues[{seg,word|at,n,offset,gain}]}], scene_code, storyboard[], sources[{url,publisher,published,collected,methodology,confidence,limitations,claim}],
claims[{text,source_ids,kind: fact|assumption|opinion}], captions{facebook,instagram,tiktok,youtube}, thumbnail{seg,offset,title}, budget{max_credits}`

The API rejects factual claims without sources and packages whose estimated ElevenLabs credits exceed the budget.

## Worker pipeline

1. **GENERATING_AUDIO** – `POST /v1/text-to-speech/{voice}/with-timestamps` (base64 audio + character alignment), `POST /v1/sound-generation`, `POST /v1/music`. Every request is cached by content hash in the bucket; budget is checked before each paid call.
2. **BUILDING_TIMELINE** – Thai word segmentation (PyThaiNLP) on the real alignment → segments/phrases/words; SFX cues resolved to absolute times.
3. **RENDERING** – scenes rendered in parallel processes, concatenated; numpy mix of narration + SFX + music with speech-driven ducking, loudness-normalised to −14 LUFS.
4. **QUALITY_CHECK** – decode, spec (H.264/AAC/1080×1920/30), duration, clipping, narration present, A/V onset sync, SFX-vs-narration level (auto-repairs by lowering cues and remixing), black frames, per-scene content, cue resolution, claim sourcing.
5. **UPLOADING_DRIVE** – episode number from a DB counter, folder `EP{nnn}_{title}_{YYYY-MM-DD}` (Asia/Bangkok), resumable uploads, md5 + size verified for: MP4, thumbnail PNG (code-rendered), script, captions (4 platforms), SRT, sources manifest, storyboard, source archive.

Stages are resumable: outputs are stored in `jobs.stage_results` + the bucket; a crash or redeploy resumes at the first unfinished stage.

## API

`GET /health` · `POST /jobs` · `GET /jobs` · `GET /jobs/:id` · `GET /jobs/:id/status` · `GET /jobs/:id/assets` (presigned URLs) ·
`POST /jobs/:id/retry` · `POST /jobs/:id/cancel` · `GET /oauth/google/start?key=…` (one-time Drive connect).
Auth: `Authorization: Bearer $MOTION_API_TOKEN`. Test jobs: `{"kind":"test_tts"|"test_render"|"test_drive","force":true}`.

## Configuration (Railway variables)

motion-api: `DATABASE_URL`, `MOTION_API_TOKEN`, `MOTION_INTERNAL_TOKEN`, `MOTION_PUBLIC_URL`, `MOTION_MAX_CREDITS_PER_EPISODE`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `BUCKET*` (references to motion-assets).
motion-worker: `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BASE_URL` (when R2_BUCKET is set, final delivery goes to Cloudflare R2 with a permanent public URL instead of Google Drive), `DATABASE_URL`, `ELEVENLABS_API_KEY`, `MOTION_INTERNAL_TOKEN` (reference), `MOTION_API_INTERNAL_URL`, `MOTION_RENDER_PROCS`, `MOTION_DEFAULT_VOICE_ID`, `BUCKET*`.

## Local development

`scripts/motion.py` talks to the API. The worker has a dev-only `MOTION_FAKE_ELEVEN=1` mode (tones + synthetic alignment) and a local storage backend (`MOTION_LOCAL_STORAGE`).

## Personal web UI (`/app`)

Served by `motion-api` at `https://<api-domain>/app`. Password login (`MOTION_UI_PASSWORD`), signed HttpOnly/SameSite=Strict session cookie, login throttling.
Tabs: **พร้อมใช้** (ready) · **เสร็จแล้ว** (used) · **กำลังทำ** (running/failed jobs with a retry button).
Publish sends the clip's permanent R2 video URL to Buffer (one `createPost` per channel; Reels for Instagram/Facebook, video for TikTok/X),
with editable per-platform captions, a confirmation step, and modes: add to Buffer queue / share now / schedule.
A clip moves to **เสร็จแล้ว** automatically after at least one channel is sent (or manually). One live publication per clip+channel is enforced by a unique index, so double clicks and retries cannot double-post.
Channels are read live from Buffer; a platform that is not connected in Buffer (e.g. X) is shown as not connected.

New motion-api variables: `MOTION_UI_PASSWORD`, `BUFFER_API_KEY` (Buffer → Settings → API), optional `BUFFER_ORGANIZATION_ID`, `MOTION_MEDIA_BASE` (default `https://media.cloudbath.co`),
`MOTION_AI_DISCLOSURE` (default true: marks posts as AI-generated where the platform has the flag, because the narration is synthetic),
`MOTION_ALERT_WEBHOOK_URL` (Slack/Discord-style incoming webhook: failed/stuck job alerts), `MOTION_RETENTION_DAYS` + `MOTION_RETENTION_APPLY=true` (delete re-creatable intermediates of delivered jobs; dry-run by default; never touches R2 deliverables or the audio cache).
Backups: `GET /app/api/export` (JSON of episodes, scripts, sources, handoffs, publish log) next to Railway's own Postgres backups.

### Analytics and Notion (v3)

* Every 10 minutes motion-api asks Buffer for each post's status (`scheduled`/`sent`/`error`), its live link and metrics
  (views, reach, impressions, reactions, comments, shares, saves, engagement rate; Buffer refreshes them about daily and needs the
  API key's `insightsRead` scope). Snapshots go to `metric_snapshots`; the **สถิติ** tab shows totals per platform, per clip and cumulative views over time.
* `NOTION_TOKEN` (internal integration connected to the "Motion Studio Episodes" database; optional `NOTION_DATABASE_ID`) makes motion-api keep one row per
  episode up to date: Used checkbox, Status, Platforms, Published At, Post Links, Views/Reactions/Comments/Shares, Metrics Updated, Video URL.
  Rows are found by Episode number, created when missing, synced right after publishing or moving a clip, every 5 minutes for new rows and every 6 hours in full.

### Research rule (from 2026-11-04)

Every fact behind a story is researched with **OpenAI Web Search first**, preferring the most recent year available. Firecrawl is optional, budgeted deeper extraction only.
`POST /jobs` rejects a package (HTTP 422) unless every source has `retrieved_via: "firecrawl"` or `"openai_web_search"`, a `collected` date within
`MOTION_SOURCE_MAX_AGE_DAYS` (default 30) and a `published` date/year (Gregorian or Thai Buddhist era). A source published more than
`MOTION_SOURCE_MAX_YEARS` (default 2) years ago needs `freshness_note` explaining why nothing newer exists (e.g. a survey run every 10 years).

### Content studio (v4): topic in, finished clip out

The **สร้าง** tab of `/app` is the production line: type a topic → motion-api researches it live with **OpenAI Web Search first**
(newest year first, Thai + English queries, key pages read in full) → Claude writes the Thai narration, a scene spec
and per-platform captions → every rule is checked → the draft waits for review (edit lines, title, captions, or ask
for a rewrite with a note) → **ผลิตคลิปนี้** queues a normal episode job → the worker renders it → the clip lands in **พร้อมใช้**.
Optional "produce immediately" skips the review step for that topic. Nothing is ever published automatically.

How it is built:

* `api/src/studio.ts` – agent loop over the Anthropic Messages API with three tools: `web_search` / `read_page` (Firecrawl
  `/v2/search`, `/v2/scrape`) and `submit_episode`. Prompt caching keeps each turn cheap. Limits: `MOTION_LLM_MAX_TURNS` (18),
  a durable 25-credit Firecrawl budget per Research Job, `MOTION_LLM_MAX_INPUT_TOKENS` (1.2M incl. cache reads), `MOTION_MAX_DRAFTS_PER_DAY` (20),
  `MOTION_DRAFT_MAX_CREDITS` (4500 ElevenLabs credits). One draft is generated at a time.
* Checks on every submission (the model must fix them, up to 4 rounds): sources must be URLs fetched with Firecrawl in that
  session; each has a publication year, and anything older than `MOTION_SOURCE_MAX_YEARS` needs a freshness note; every
  fact cites a source; narration has no digits/symbols (Thai TTS); 350–1200 characters; every scene timing word exists in its
  segment; icons/templates/SFX exist; X caption ≤ 270; then the normal package validation, freshness rule and credit budget.
* Visuals: `worker/engine/templates.py` (13 code-drawn templates: hook, number, compare, bars, list, quiz, reveal, dots,
  timeline, truth, scenario, icons, outro) + `worker/engine/icons.py` (51 SVG icons written in code). The generated
  `scene_code` is only data (`SPEC`) passed to `build_scenes`, so a draft cannot run arbitrary code in the worker.
  Animation timing keys off narration words with a tolerant matcher, so owner edits never break a render.
* SFX use a fixed library of prompts, so they are served from the audio cache after first use.
* Preview without ElevenLabs: `cd worker && python -m motion_worker.preview out.png` (sample) or `... draft.json out.png`.

New motion-api variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (required for primary research), optional `FIRECRAWL_API_KEY` (deeper extraction fallback), optional `MOTION_LLM_MODEL`
(default `claude-opus-5-5`), `MOTION_SERIES_TAG`, and the limits above.

### Story variety and retention rules (v5)

* Every draft picks a **story format** (domino, countdown, versus, mystery, skit, myth_buster, quiz_show, day_in_life,
  by_the_numbers, then_now). The generator sees the last six drafts and must not reuse the last two formats or start with the
  same scene sequence; no layout twice in a row, at most two of a kind.
* **Retention rules, enforced:** segment 1 is the hook and lasts ≤ 5 s (≤ 60 Thai characters at ~12 chars/s); a `hook`/`rehook`
  beat at least every 15 s, and each one must put something new on screen within its first words; the last segment is a `cta`
  that asks viewers something to answer in the comments. The owner's own edits only produce warnings for these rules.
* **Cast:** each episode defines its characters (10 hairstyles, hair/skin/clothes colours, glasses, accessories); Tum keeps his look.
* **Sets:** city, room, classroom, park, beach, office, night, brick, kitchen. New layouts: chat (phone), versus (VS cards), scale.
* Text on screen drops characters the Kanit font cannot draw (emoji), so nothing renders as an empty box.

### AI provider

OpenAI calls use Responses background mode: create once, then poll the same response ID.
This avoids the Node fetch default ~5 minute response-header timeout during long reasoning/search.
Draft logs show the round, response ID and a heartbeat every minute. Transient GET failures retry
the same response; ambiguous creation failures are not automatically resubmitted. A round has a
15 minute deadline with best-effort cancellation. API restarts still require restarting the draft;
this change does not persist the whole model conversation for restart recovery.

Validate the transport with `cd api && npm run typecheck && node --import tsx --test src/openai-response.test.ts`.

The studio works with either provider: `ANTHROPIC_API_KEY` (default model `claude-opus-5-5`) or `OPENAI_API_KEY`
(Responses API, default model `gpt-6.1-sol`). With only one key set, that provider is used; force one with
`MOTION_LLM_PROVIDER=anthropic|openai`, pick a model with `MOTION_LLM_MODEL`. Firecrawl, the rule checks and the renderer are the same for both.

### Bespoke story art and reference characters

New studio drafts first call `plan_story` to persist narration and shot direction, then draw every shot as sandboxed custom code (including opener/outro). Each cast member has standalone `portrait_code` for the face and body, reused in scenes and the cover. Legacy drafts and template episodes remain supported.

Uploaded reference images are stored in `characters.reference_image` and sent to the configured vision LLM during story design; they are not included in downloadable episode packages or used as scene backgrounds. Older characters can refresh their original via **อัปเดตรูป**; otherwise only their saved thumbnail is available. Code-drawn likeness is stylised and must be reviewed, not treated as an exact face reproduction.

Every scene must compile/render and the model must receive preview frames in a prior turn before the draft becomes ready. Any changed art requires a new visual review. New bespoke renders fail on drawing errors instead of substituting a generic template. Change narration via Rewrite so its storyboard and visuals are rebuilt.

Validation: `cd api && npm run typecheck && node --import tsx --test src/*.test.ts`; `cd worker && python -m unittest discover -s tests -v`. Migration `012_character_reference.sql` adds nullable reference-image and storyboard fields. Deploy the worker before the API so the new portrait renderer is available when generation starts.

### Bounded composition and source repair

The composer saves one character or shot per model response (`draw_character`, `save_art`, `draw_scene`), then assembles saved artwork with metadata-only submissions. Artwork checkpoints and the storyboard survive a failed draft's Retry when the direction is unchanged. New direction deliberately starts a new design.

Hosted research records completed search sources, exact `open_page`/`find_in_page` URLs and citation annotations. Source comparison preserves URL path case and ignores tracking parameters. If a proposed source is missing, a separate small OpenAI lookup opens it and returns evidence for review; requested URLs are never accepted merely because the model supplied them. Exact-page reads stay available after Firecrawl depletion.

Broad hosted search is bounded to at most 3 tool calls per response and disabled during artwork generation. High reasoning is retained for research/planning; drawing individual assets uses medium reasoning and a 16000 token output ceiling. The existing model choice stays the same. Provider waits are configurable with `MOTION_OPENAI_TIMEOUT_MS` (default 30 minutes, range 5–45); per-asset checkpoints preserve completed work if a provider still times out. No ambiguous create request is retried automatically.

### General storytelling mode

The composer now offers **เล่าเรื่องทั่วไป** (default in the new UI) and **ซีรีส์คนชื่อ…**. General mode accepts a topic and optional source text/URLs up to 20,000 characters. Reference characters are opt-in; old selected characters are not silently attached. GPT-6.1 Sol and the existing model selector work for both modes.

General stories use a topical hook and custom object/diagram/environment scenes; cast and shot character lists may be empty. Covers use the topical frame/title. Name-series defaults remain enforced for old records and clients. Mode and source material persist through rewrites and retries. All new art, including character-free scenes, must render and receive visual review; drawing failures cannot substitute a generic mascot. User-provided factual or health material remains unverified input until sources are retrieved.

### Strict Firecrawl budget (2026-11-08)

`015_research_budget.sql` adds a persistent Research Job shared by every rewrite/retry. All Firecrawl traffic goes through `BudgetedFirecrawl` and `PgResearchBudget`; there is no call-count budget or automatic credit increase. Default total: **25 credits**. A PostgreSQL advisory lock serializes calls across jobs and API replicas. An atomic transaction commits the maximum reservation and request audit before dispatch. Reservations stay charged conservatively even when the provider omits attributable usage. `creditsUsed`, when returned, is recorded separately; a cache hit spends zero. Provider errors are not automatically retried; ambiguous transport failures retain the reservation and block further Firecrawl calls. A crash leaving an outstanding reservation also blocks new requests.

The model first reads an exact URL through OpenAI. Only a later `read_page` with `use_firecrawl: true` and a concrete `fallback_reason` may extract deeper text. The primary OpenAI reader is available to Anthropic writers via `openai_search`. Firecrawl search is not exposed to the writer; the shared transport's bounded search pricing supports no result scraping. All unknown endpoints/options, crawl, batch, agents, structured extraction, X/Twitter and LinkedIn enrichment are refused. Plain markdown extraction disables all parsers (including extensionless PDFs), actions, media and optional formats. Known PDF URLs are rejected. The plain scrape maximum reserves 3 credits (1 base + a conservative 2 for an account threat scan). Search, if invoked through the shared transport, reserves 12 for five results without scraping (2 search + conservative 2 per result for threat scans). These bounds use [official billing](https://docs.firecrawl.dev/billing) and [scrape options](https://docs.firecrawl.dev/api-reference/endpoint/scrape), checked 2026-11-08. Provider pricing changes must be reviewed before enabling new operations.

Successful extraction responses and exact source URLs are cached in Postgres for 24 hours. URL identity preserves path/query case. Failed, blocked, empty and raw binary responses are never promoted to source evidence. User-supplied material remains unverified until retrieved. Sources retain original/final URLs and collection times.

The draft UI shows cumulative used/reserved credits, remaining budget, requests, and any blocked state. The authenticated owner can explicitly approve a larger **total** via `POST /app/api/studio/drafts/:id/research-budget` with `{limit: 40, approved: true, confirmation: "APPROVE FIRECRAWL TOTAL 40"}`. This action is absent from model tools and is audited; a rewrite never replenishes the budget. Approval does not resolve uncertain charges. Historical lineages with untracked Firecrawl usage are conservatively marked `legacy_usage_unknown` and cannot silently receive a fresh 25 credits.

Validation: `cd api && npm run typecheck && node --import tsx --test src/*.test.ts`. Firecrawl budget tests use mocked HTTP; no paid requests are required.

### Opening-frame covers

New Studio-generated drafts carry `cover_mode: opening_frame`. Their first custom shot starts at video time zero, with the subject and Thai headline already visible and motion beginning immediately. Narration and subsequent scene timing are unchanged; no still intro or extra second is inserted. Visual review includes the exact opening frame in addition to early/late previews. An almost blank opening fails preflight.

Produced packages retain this choice in `thumbnail.mode`. The worker extracts the PNG directly from the first decoded frame of the final delivered MP4; it adds no separate cover layout. Buffer receives `thumbnailOffset: 0` for supported services (including Instagram and TikTok). Facebook/Twitter retain their existing API restrictions. Legacy drafts/packages keep their old cover behavior and 1500ms Buffer selection. Existing published posts are not modified. Deploy worker before API.

### Browser submission recovery

`016_draft_requests.sql` gives draft creation and rewrite requests a durable unique key and input hash. The UI stores the key before sending; a lost response or page reload reuses it for the same input. Concurrent requests and retries return the original draft ID, and reusing a key with different input returns HTTP 409. Older clients without a key remain compatible. Production submission still uses the existing `draft:<id>` job idempotency key. Normal pending work and artwork/source checkpoints are unchanged.

### Removing unused clips

Open a clip in **พร้อมใช้** and choose **ลบคลิป**, then confirm. `DELETE /app/api/episodes/:id` requires `{confirm:true}` and the normal UI authentication. It marks the episode `ui_status: deleted` with `deleted_at`; the clip disappears from ready/used lists. Media, episode history and the existing Notion page are retained. Used clips and clips already reserved/sent to Buffer cannot be removed here.

Notion mirrors `Status: deleted` and `Deleted: true` on the same page, without archiving or trashing it. The integration adds the checkbox and select option if absent, preserving other properties/options. A failed sync leaves the local deletion intact and records a retryable error; unsynced rows are retried every five minutes and on startup. All Notion sync entry points share one queue, and stale syncs cannot acknowledge a newer local status. Repeated deletes are safe. Publishing from stale tabs and background Buffer reconciliation cannot restore a deleted clip.

Migration: `017_deleted_episodes.sql`. Validation: TypeScript, API tests including real PostgreSQL deletion/publication reservations and mocked Notion failures, plus browser confirmation/cancel and sync-status checks. No media generation is needed to test this feature.

### AI topic suggestions

The **สร้าง** composer offers **AI สุ่มหัวข้อ** below **ลองหัวข้อ:**. Fresh suggestion requests use **GPT-6.1 Terra** by default, independently of the brain selected for script generation; the selected reasoning level still applies. The API also defaults to Terra when no model is supplied. Existing pending requests resume their original model without another paid create. The current mode, topic, directions and a bounded source excerpt provide context. Previously suggested topics (last 60) and recent drafts help avoid repeats. Click an idea to fill the topic; it persists across reloads. Changing story mode hides a set generated for another mode. Ideas are not verified claims; normal research begins only when the owner starts a draft.

`POST /app/api/studio/topic-suggestions` accepts a client-generated `request_id`; `GET .../:id` polls the saved result. Migration `018_topic_suggestions.sql` stores request hashes, status, response IDs and results separately from drafts/jobs. Duplicate clicks and browser reloads reuse the original request. Background OpenAI IDs survive API restarts and resume with GET only; ambiguous creates without a saved ID are marked failed and never automatically sent again. Failed generation is shown explicitly, without substituting canned ideas. Suggestions do not run web search, Firecrawl, artwork, audio or publishing.
