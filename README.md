# Motion Studio

Topic in → narrated, subtitled, sound-designed 1080×1920 MP4 in Google Drive (`Motion Studio / Ready to Post`).
All visuals are drawn by code (Pillow/NumPy procedural drawing, code-written SVG via CairoSVG, FFmpeg).
No image or video generation models are used anywhere. ElevenLabs is used for audio only.

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

Every fact behind a story is researched with **live Firecrawl searches**, preferring the most recent year available.
`POST /jobs` rejects a package (HTTP 422) unless every source has `retrieved_via: "firecrawl"`, a `collected` date within
`MOTION_SOURCE_MAX_AGE_DAYS` (default 30) and a `published` date/year (Gregorian or Thai Buddhist era). A source published more than
`MOTION_SOURCE_MAX_YEARS` (default 2) years ago needs `freshness_note` explaining why nothing newer exists (e.g. a survey run every 10 years).

### Content studio (v4): topic in, finished clip out

The **สร้าง** tab of `/app` is the production line: type a topic → motion-api researches it live with **Firecrawl**
(newest year first, Thai + English queries, key pages read in full) → Claude writes the Thai narration, a scene spec
and per-platform captions → every rule is checked → the draft waits for review (edit lines, title, captions, or ask
for a rewrite with a note) → **ผลิตคลิปนี้** queues a normal episode job → the worker renders it → the clip lands in **พร้อมใช้**.
Optional "produce immediately" skips the review step for that topic. Nothing is ever published automatically.

How it is built:

* `api/src/studio.ts` – agent loop over the Anthropic Messages API with three tools: `web_search` / `read_page` (Firecrawl
  `/v2/search`, `/v2/scrape`) and `submit_episode`. Prompt caching keeps each turn cheap. Limits: `MOTION_LLM_MAX_TURNS` (18),
  `MOTION_FIRECRAWL_MAX_CALLS` (16), `MOTION_LLM_MAX_INPUT_TOKENS` (1.2M incl. cache reads), `MOTION_MAX_DRAFTS_PER_DAY` (20),
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

New motion-api variables: `ANTHROPIC_API_KEY`, `FIRECRAWL_API_KEY` (required for the studio), optional `MOTION_LLM_MODEL`
(default `claude-opus-5-5`), `MOTION_SERIES_TAG`, and the limits above.
