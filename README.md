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
motion-worker: `DATABASE_URL`, `ELEVENLABS_API_KEY`, `MOTION_INTERNAL_TOKEN` (reference), `MOTION_API_INTERNAL_URL`, `MOTION_RENDER_PROCS`, `MOTION_DEFAULT_VOICE_ID`, `BUCKET*`.

## Local development

`scripts/motion.py` talks to the API. The worker has a dev-only `MOTION_FAKE_ELEVEN=1` mode (tones + synthetic alignment) and a local storage backend (`MOTION_LOCAL_STORAGE`).
