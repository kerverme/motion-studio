# Lemo Creative Motion

This integration is deployed and Lemo is enabled after the owner confirmed coordinator credential scope and real production testing. Current code is on `main` and `codex/lemo-production-validation`. [Live verification](LIVE-VERIFICATION.md) records exact deployed commits, actual test results and any remaining limitations. See [the audit](AUDIT.md) for the original production baseline and [the clarified private film permission](LICENSING-SCOPE.md) for the current licensing scope.

See [Railway recovery evidence](RAILWAY-RECOVERY-20261113.md) for the previous runtime verification and handoff.

## Implemented boundaries

The Create workflow selects Classic or Lemo; fal Text-to-Video keeps its existing sidebar. New UI projects carry a versioned creative contract, a sound decision for every scene, selectable narration models (v4 by default), and an explicit cost review. Existing drafts without that contract retain their old flow and caches.

Lemo reuses the existing research conversation and Firecrawl Research Job. Its `plan_story` call includes semantic analysis, six compatibility scores, a film identity and scene/sound direction. Ranking is deterministic with configurable weights (30/25/15/10/10/10). Only three verified Canvas2D styles are installed: `dataviz`, `firefly-pointillism`, `rubber-hose`. Unavailable styles fail validation. More styles require a capability and licensing review; this integration does not advertise all 99 upstream styles.

The selected brain reaches both the OpenAI planner and the separate coding worker. Auto selection is the default. Manual choice, alternatives, low-confidence notices, style locking, scene narration/direction/character/location edits and advanced SFX prompts are available. Editing a narration invalidates its semantic confidence. Explicit style regeneration uses the existing rewrite/research path, so it can incur planning cost; it is not a free local rerank. Story revision and settings determine cached decisions. Scene regeneration creates an immutable reviewable revision and requires another production approval; unchanged source/audio/render artifacts can be reused.

The API never executes the coding agent. `lemo-worker` has separate dependencies, workdir, claims and health endpoint. Classic claims exclude Lemo jobs. A separate authenticated executor receives HTML only, not provider keys, database credentials or R2 credentials. Its fixed gVisor command uses no network, a read-only root, non-root UID, no capabilities, bounded tmpfs, CPU/memory/pid/file/time/output limits and one concurrent render. The browser only accesses two allowlisted local routes. Tar responses accept five fixed regular files and reject links/traversal. A runtime limit probe must pass before arbitrary generated HTML can run. Before any paid audio or coding request, the coordinator checks the private licensed specification, provider configuration, authenticated TLS `/ready` response and exact approved renderer image. Failed readiness stops the job before spending.

The local development Docker runtime fails that probe because it starts runsc with `--ignore-cgroups`. Production instead restores the verified Railway Sandbox checkpoint and uses the tested `ptrace` platform, with host cgroup membership and quotas checked before rendering. The private executor receives a project-scoped Railway token; generated-code containers receive no service credentials. The local test-only exception accepts only exact hashes of three committed, hand-authored fixtures (maximum 10 seconds); the HTTP endpoint cannot opt into that exception. See the live verification record for the approved checkpoint and image digest.

## Audio, costs and delivery

v4 uses the official Text-to-Dialogue `/with-timestamps` contract, the selected/configured voice ID, Thai language and supported stability/similarity settings. Requests are split by narration segment within 2,000 characters. Character timing, speaker identity and voice segment indexes are validated. Normalized alignment is preferred only when it actually matches the script. Missing or mismatched timing is an error, not interpolated subtitles. Legacy models remain selectable. No paid model substitution or blind POST retry occurs. Expressive direction currently relies on story wording/punctuation and supported settings; unverified v4 audio tags and speed controls are not fabricated.

SFX defaults to `eleven_text_to_sound_v3` for new creative packages, with explicit model/prompt/duration/cache identity. v3 looping is rejected. Every scene explains effects, ambience or deliberate silence. Word anchors resolve against real alignment; unresolved new cues fail visibly. SFX duck under narration; existing mastering and QA remain active. A default music track may be reused; a missing default never triggers paid generation. Explicit AI music needs its own approved allocation.

`creative_approvals`, `creative_calls` and `creative_cache` implement revision-bound approval, atomic job/category reservations, duplicate protection and durable outcomes. PostgreSQL concurrency tests demonstrate one paid-call dispatch for concurrent identical submissions and no overspending of the reserved ledger. Ambiguous POST outcomes keep their reservation and block resubmission. Saved OpenAI response IDs resume GET polling. Successful assets are stored before calls are completed. Identical in-flight assets in another job are blocked until their outcome is known.

Production configures `LEMO_CODE_MAX_OUTPUT_TOKENS=24000` (supported range 12000–32000, including reasoning). A response that reaches the limit records its actual usage and incomplete reason, then stops visibly. Retrying the job reads the saved response; it does not create a new paid response. Use the scene-regeneration action for an explicitly approved repair revision. Unchanged narration and sound effects remain reusable across revisions.

The approved portrait composition and palette override the style document's sample dimensions and colors. Later scenes receive the first scene's drawing code to preserve characters and props. Inspect previews as well as technical QA: correct encoding alone does not prove visual fidelity. The working queue links directly to scene review. Repair drafts retain already-incurred planning usage; original attempts and their reservations remain auditable.

Lemo captions use the bundled Classic Kanit ExtraBold font at native 1080×1920 ASS coordinates, with spoken-word highlighting and a translucent plate. Explicit portrait coordinates prevent the tall, compressed letters caused by burning an SRT with libass's default landscape script resolution. Captions wrap at Thai word boundaries into at most two lines per page; an oversized token fails visibly rather than being silently squeezed or clipped.

`POST /app/api/creative/jobs/:id/repair-captions` repairs completed, unpublished Lemo clips using their saved scene videos, audio and timing. The owner-authenticated operation queues the same job/episode once, preserves the previous delivery, and uses a versioned output URL. Its worker path only composes, checks and delivers; it cannot call OpenAI, ElevenLabs or the generated-code executor. Missing saved scenes stop the repair. Notion is marked for synchronization after verified delivery. A failed repair can resume through the existing job retry endpoint.

All in-scene titles, labels and numbers also use a trusted, offline Kanit runtime. It bundles the actual 700/800 font files and OFL notice, waits for font loading before `READY`, normalizes Canvas text, limits outlines to 3px, and fits text by font size rather than horizontal squeezing. New coding requests use `MotionText.draw` with at least 48px labels and 108px headlines; duplicate offset lettering and blurred shadows are prohibited. The runtime is included in the render cache identity. Source archives include the exact rendered HTML with its fonts, while canonical source sent to the coding model stays free of font payloads.

`POST /app/api/creative/jobs/:id/repair-typography` fixes the whole scene, including its upper headline. It reuses saved source/audio, removes the known legacy duplicate headline and replaces its text helper, then renders every affected scene in the existing verified Railway Sandbox. It makes no LLM or voice-generation calls, but does use sandbox compute. Every completed scene is checkpointed, and old deliveries remain available. Missing or unsupported source fails visibly. This operation is distinct from subtitle-only recomposition, and is idempotent on the same job/episode.

Rates come only from `MOTION_CREATIVE_RATES_JSON`; empty configuration means **unknown**, never a made-up price. Each category's configured rate must name the exact model, `usd_per_unit`, a source and a checked date; an optional `valid_until` expires it. Units are characters for narration, seconds for SFX, bounded attempts for code, tracks for music and jobs for compute. Account credits are not silently converted into dollars. Planning already incurred is shown as token usage; style analysis is included in that planning call. The production approval covers subsequent work.

Unknown categories require an explicit positive allocation and acknowledgement. The ledger bounds authorized requests and reservations; **an unknown provider price cannot be guaranteed as a real dollar ceiling**. Verify account rates before release. Actual amounts remain null until verified usage or an owner receipt is reconciled. `POST /app/api/creative/jobs/:id/reconcile` records a completed call's `call_key`, `actual_usd` and receipt, labelled `owner_receipt`; it does not pretend a missing response succeeded. An ambiguous ElevenLabs request with no durable assets requires operator investigation and recovery before retry.

Delivery reuses the existing R2 upload verification and Notion publication handoff. It does not auto-publish to Buffer. Final H.264/AAC video, thumbnail, script, subtitles, sources, storyboard, narration metadata, SFX manifest, style/rationale, model provenance, costs, render metadata and source archive are saved. The archive includes the pinned MIT helper and licenses, not private STYLE documentation. Reference photos are snapshotted in a private job table; public artifacts contain provenance hashes rather than photos. Ready cards retain the actual brain label, and Lemo appears in the working queue.

On Railway, provision each private STYLE document in `LEMO_PRIVATE_STYLE_DATAVIZ`, `LEMO_PRIVATE_STYLE_FIREFLY_POINTILLISM` and `LEMO_PRIVATE_STYLE_RUBBER_HOSE`. Each fits the 32 KiB variable limit and is checked against the pinned SHA-256. The older combined `LEMO_PRIVATE_STYLES_JSON` and private-directory options remain supported elsewhere; never commit private documents to the repository.

## Initial development results (before live provider tests)

| Check | Result |
|---|---|
| TypeScript | Passed |
| Existing + new API tests | 136/136 passed |
| Classic/fal worker suite, including synthetic 60-second fal assembly | 45/45 passed |
| Isolated Lemo suite | 17/17 passed, including real local PostgreSQL concurrency and pre-spend sandbox readiness |
| Local browser UI | Engine choice, v4 default, no stale characters, storyboard values, cost dialog; no page errors |
| Real FFmpeg/Canvas comparison | Six 8-second MP4s: three stories × Classic/Lemo; all technical QA passed |
| Coordinator image | Built; `/health` reports disabled and lists blocked gates |
| Runtime quota enforcement | **Blocked**, not verified in this environment |
| Real v4, SFX v3, coding quality, real Thai speech synchronization | **Not tested**; providers were mocked |
| Production deploy/upload/Notion/Buffer | **Not performed** |

Mock speech is an audible synthetic tone with explicit fixture timestamps, not natural Thai speech. The previews are small technical sketches, not a demonstration of live AI art quality or a guarantee of style fidelity. No provider token usage was incurred in the comparison. See [comparison results](COMPARISON.md) and [machine-readable evidence](verification.json).

## Reproduce the checks

Run from the repository root with Node 22+ and Python 3.12, FFmpeg/ffprobe, Docker, Chromium and the worker dependencies installed. Use an isolated test database, never production.

```sh
npm --prefix api ci
npm --prefix api run typecheck
(cd api && node --import tsx --test src/*.test.ts)
python -m pip install -r worker/requirements.txt
PYTHONPATH=worker:lemo-worker TEXT_VIDEO_FULL_TEST=1 python -m unittest discover -s worker/tests -v

docker run -d --name lemo-test-postgres -p 127.0.0.1:55432:5432 \
  -e POSTGRES_PASSWORD=local-test-only -e POSTGRES_DB=lemo_test postgres:17-alpine
LEMO_TEST_DATABASE_URL=postgresql://postgres:local-test-only@127.0.0.1:55432/lemo_test \
  PYTHONPATH=worker:lemo-worker python -m unittest discover -s lemo-worker/tests -v

npm --prefix lemo-worker/sandbox ci
NODE_PATH="$PWD/lemo-worker/sandbox/node_modules" node lemo-worker/tests/ui_smoke.cjs
docker build -f lemo-worker/sandbox/Dockerfile -t cloudbath-lemo-sandbox:dev lemo-worker
python lemo-worker/tests/render_comparison.py /tmp/lemo-comparison
docker build -f lemo-worker/Dockerfile -t cloudbath-lemo-worker:dev .
```

Renderer builds behind a corporate certificate proxy can supply `--secret id=build_ca,src=/path/to/approved-ca.crt`; the CA is only mounted during dependency installation. The coordinator uses public certificate authorities and no build-secret mounts, for Railway Dockerfile validation compatibility. Do not disable TLS verification. The renderer image must have an immutable digest in `LEMO_SANDBOX_IMAGE`. `sandbox/executor.py` runs on a dedicated hardened host behind authenticated TLS, not a Docker-in-Docker Railway container. Railway uses repository root as the build context and `lemo-worker/railway.toml` as its config path. Keep one coordinator replica and its separate workdir. Mount the licensed private library outside the image; every loaded STYLE file must match `upstream.lock.json`.

## Release checklist

- Confirm the applicable upstream permission and third-party assets/dependencies. This owner's private social-video workflow is covered by the upstream additional film permission; see [scope and configuration](LICENSING-SCOPE.md). A broader commercial style service requires separate permission. No upstream demo voices, trademark characters or films are bundled.
- Dedicated executor with verified CPU, memory, disk, pids, timeout, filesystem and network isolation. Investigate resource enforcement rather than setting a flag to bypass failure. Pin the approved renderer image digest.
- Owner approval for real-provider tests has been given. Model availability and two bounded production provider responses are recorded in [live verification](LIVE-VERIFICATION.md). Verify account rates before claiming a dollar ceiling.
- Real Thai v4 voice quality/alignment, SFX v3, mixing and subtitle review; retain the chosen voice and do not fall back silently.
- Real coding-agent evaluation on all three stories, identity continuity, per-scene repairs, cancellation and restart/reconciliation tests on the approved executor.
- Staging migration/health/R2/Notion handoff verification and Classic/fal regression checks at the release commit. No automatic publishing.
- Owner production deployment approval has been given. Keep unverified gates in `.env.example` false until their evidence is recorded.

Official references checked: [Lemo pinned license](https://github.com/lemomo-ai/lemo-opuscar/blob/3a7132b996be0241c1ea0ab180d519f06e6f10b6/LICENSE), [ElevenLabs OpenAPI](https://api.elevenlabs.io/openapi.json), [Text-to-Dialogue timestamps](https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert-with-timestamps), [NHLBI sleep stages](https://www.nhlbi.nih.gov/health/sleep/stages-of-sleep), [BORA](https://www.bora.dopa.go.th/).
