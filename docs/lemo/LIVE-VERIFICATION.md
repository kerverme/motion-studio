# Live verification — 2026-11-13

The owner explicitly authorized production deployment, the new coordinator's production credential references and one real film test. Lemo is enabled and the actual AI-authored EP025 is READY_TO_POST, delivered to R2, synchronized to Notion and played through on the production website. The earlier credential-scope block was resolved by the owner's explicit confirmation. The final results are below; earlier checkpoints and fixtures remain separate historical evidence.

Railway deployment `49874640-e3d1-4831-badf-2f06e356a6ac` reached `SUCCESS`. Its durable object-storage slots reserve each operation before dispatch and save the complete provider response. Restarting with the same input replays that response; a changed input or ambiguous earlier dispatch is blocked.

| Check | Actual result |
|---|---|
| OpenAI model list | Sol, Terra and Astra available |
| ElevenLabs model and selected voice | v4 and configured Thai voice available |
| Production v4 timestamp endpoint | HTTP 200, request `QlAypYNvYILiKPDEBnxo`, character-cost header 36 |
| Production SFX v3 endpoint | HTTP 200, one-second bowl tap, character-cost header 11 |
| Worker adapter against saved real responses | Passed model, speaker, alignment and audio validation; no extra provider calls |
| Real Thai timeline | 81 aligned characters, 23 tokens; decoded audio 7.471 seconds; last provider timestamp 7.52 seconds, within the existing 150 ms tolerance |
| Account billing endpoint | HTTP 401 with this key; exact account dollar rates remain unverified |
| Full AI-generated Lemo film in Railway Sandbox | Passed: EP025, four Sol-authored scenes, 9.68 seconds, H.264/AAC 1080×1920 at 30 fps |
| Main API/worker deployment and migration | Passed; deployment IDs and migrations below |
| New Lemo film R2/Notion handoff | Passed: all 15 deliverables verified; EP025 is Ready to post in Notion; no Buffer publication |

The character-cost headers are recorded as provider units, not invented USD amounts. These results prove provider contract compatibility and timeline parsing, not subjective narration quality or full video synchronization. The earlier connector-only voice test and synthetic development comparisons remain separate evidence.

The local development Docker runtime ignores cgroups and remains prohibited for generated HTML. Real Railway Sandbox verification passed on 2026-11-13: host-kernel cgroup v2 enforced two CPU quota, 2 GiB memory, zero swap and 1024 PIDs. The credential-free render container uses UID 65534, a read-only root, zero effective capabilities, a 384 MiB tmpfs and no network. A fixed probe observed root writes rejected and outbound networking returning ENETUNREACH. See [recovery evidence](RAILWAY-RECOVERY-20261113.md) for the first successful 3-second fixture.

The owner installed the production Project Token in lemo-render-executor, deployment 67d3d19c-a5ed-44c0-b8a1-ba9d30178a30 reached SUCCESS, and a private read-only Sandbox checkpoint listing succeeded using that token. No token was exported. A reproducible credential-free bootstrap produced image sha256:7e2044599bc000ecd92d6ff95abd505db6a2873248fee48c7644a7181aa48281 and repeated the kernel/isolation checks successfully. Subsequent checkpoint restore, fixture rendering and the final AI-authored film passed as detailed below.

After restoring all pending work onto the latest feature commit, TypeScript passed, 137 API tests passed, 22 isolated Lemo tests passed including real PostgreSQL concurrency, and 45 Classic/fal worker tests passed including real synthetic 60-second video assembly.

The owner's own social films are covered by [the upstream additional film permission](LICENSING-SCOPE.md). That licensing clarification is independent of the remaining runtime checks.


## Production progress at 2026-11-13 16:25 Asia/Bangkok

Main and the feature branch contain a49f98928d63fa640e45f2ad20173ca41a4a087b. API deployment a5060e4f-3b2a-42c6-b852-0d03b055bdca and Classic worker deployment ae1669da-906d-4ce6-9d6e-b3d4651ebc53 reached SUCCESS. Production logs confirm migrations 026_creative_motion.sql and 027_creative_references.sql, API startup, worker database/storage readiness and a successful Notion sync of 23 existing items. The public health endpoint returned HTTP 200. No production jobs were active before those deployments.

The private executor restored cloudbath-lemo-20261113-ptrace-v1 with the owner's Project Token and passed authenticated private TLS readiness with the exact approved image. A subsequent fresh sandbox rendered a 3-second 1080x1920 H.264 30 fps fixture, saved a 307200-byte archive, and completed in 65.543 render seconds. Rendering is CPU based and is not real time.

The downloaded fixture was composed locally with the saved real v4 voice and SFX v3, without additional paid audio calls. The existing mixer, subtitle builder and video QA passed all 14 checks on the 9.27-second H.264/AAC technical fixture: first audio onset 0.08 seconds versus first-word timestamp 0, peak -1.85 dBFS, no black frames, no unresolved SFX anchors and Thai subtitles visually inspected. This validates composition and synchronization; it is not a live AI-authored film.

Lemo is still disabled. The new trusted coordinator service a81515b3-b9d6-4215-8938-00b26e1c07cf has no production credentials. Automatic approval review rejected provisioning its required database/storage/provider references. A specific permission question is pending; do not bypass it with a different tool or service. The isolated generated-code executor never receives those credentials. The full live coding/planning film and new coordinator handoff remain unverified.


Live browser tests at https://studio.cloudbath.co/app passed: general mode by default, hero name hidden in general mode and visible in the name-series mode, reference-character checkbox off, Sol selectable, v4 default, visual styles loaded, Text to Video and Ready screens preserved, and no page JavaScript errors. Ready contained 17 items, Used 5 and Working 0. Screenshots are retained in /workspace/output/lemo-live/ui/. The Lemo option remains disabled while its coordinator is not authorized/configured. Browser HTTPS verification stayed enabled; the test profile trusted the managed environment's supplied CA.

## Coordinator deployment at 2026-11-13 16:46 Asia/Bangkok

The first two coordinator builds failed Dockerfile validation before producing build logs. Removing its unnecessary optional build-secret mount fixed the failure: local `docker build --check` passed without warnings, and Railway built and deployed the same Dockerfile successfully. Commit c06a44d671910ce3b977e013fcaaf2d0a47879c9 is on main and the feature branch; deployment 198dc547-8ce6-492b-9f2a-2d99412bb01f reached SUCCESS with the `/health` deployment check. The service has only `LEMO_ENABLED=false`, `PORT`, `TZ` and `RAILWAY_DOCKERFILE_PATH`. There are no staged changes on the API, Classic worker or new coordinator. API and Classic code are unchanged by c06a44d and remain on their successful a49f989 deployments.

Temporary provider/runtime/signing flags were disabled and temporary Railway/executor tokens cleared from the private verification function; cleanup deployment 461ad28d-f952-47f2-83b7-ca1428328946 reached SUCCESS. Saved paid responses remain in object storage for reuse.

## Explicit activation and real film — 2026-11-13

The owner confirmed that the new service may use production database, storage, OpenAI/ElevenLabs and internal renderer references, and requested a real film. Those references were provisioned on `lemo-worker`; it has no Railway Project Token. The renderer remains isolated from provider/database/storage credentials. Railway's 32768-character variable limit required separate hash-checked private STYLE variables; commit f7d809e2dd3be7376aabd682a647548c3994de8b fixes that, with five focused permission/style tests passing. Worker deployment eb6f5169-1ada-4517-bd09-1baff944dbf0 reached SUCCESS. Live browser checks confirm Lemo selectable, Classic preserved and no page errors.

The actual planner exposed two source-validation defects: fiction was forced to invent or retrieve an unnecessary citation, and Lemo dropped trusted `retrieved_via` metadata when preparing its package. Its opaque tool schema also allowed empty sound prompts and unsupported fields. Commit 442dea2da5bb56151ae195ddae1c7baa009871b6 fixes these defects, shares the complete Zod-derived schema with the planner and adds owner-authenticated recovery from an already-recorded completed OpenAI response using GET only. TypeScript and all 138 API tests passed, including recovery ownership/idempotency and source-less fiction. API deployment 32c2aa8a-baad-4b1e-87bb-4284e1cd3d59 reached SUCCESS and passed /health.

The same draft b95688e3-9659-4054-9c36-151c5a8f7872 was recovered from saved response resp_0e833d3328196d9e006af6dfdfc8b487d2bcdd7885b71279d7; no new planning POST was needed for recovery. The earlier buggy planner consumed requests before being stopped; its recorded usage remains visible rather than being reset. Initial production approval created job f85c33bf-c764-4331-a546-7b5441fbed85, episode 5d9623c2-e005-4898-b9e2-b343d4d4ea4c, with auto-publishing disabled. The fictional robot/watering-can/plant/umbrella story uses Sol, automatic Rubber Hose selection, four short narration segments and two reviewed SFX prompts. No new music was requested.

Real Eleven v4 narration completed in four calls (character-cost headers 7+8+8+7), and SFX v3 in two calls (9+6): 45 reported ElevenLabs credits total. Narration lasts 7.836735 seconds; the derived video timeline ends at 9.68 seconds and has no missing sound anchors. The production ledger reserves a 5 USD allocation for this one test; provider dollar rates remain unknown, so this is not represented as a verified real-dollar ceiling. Actual USD stays null until pricing or receipts are verified.

The first coding response stopped at `max_output_tokens`: 12,000 output tokens, including 6,010 reasoning tokens. The incomplete response and provider ID were retained; it was not silently replaced. Commit 41ee89859443bba48a70e2bb686a5dfcfa2e1164 records incomplete usage/reasons, supports a bounded configurable output budget and requests compact drawing code. Production sets 24,000 tokens. It also requires actual audible-event descriptions in SFX prompts rather than workflow/cache instructions. Reading the original saved response again confirmed the failure without another model POST.

The owner-authorized test continues as one intended film with a targeted repair revision, job cd0594a3-5ce7-4c08-a2a6-222571f0c37d, episode 56cb24f5-29f8-4960-88ba-46c0c9cf435c. All four narration chunks and both SFX were confirmed cache hits: no additional ElevenLabs calls. The umbrella cue was anchored to the actual word “กางร่ม”. Original reservations total 1.375 USD; the repair approval is 3.6 USD, so combined reservation allowances remain 4.975 USD. These are ledger reservations, not verified provider charges. Sol/high and the existing voice remain selected. The repaired first coding response completed with 9,872 output tokens (4,515 reasoning), and entered the real isolated renderer.

API deployment de65487d-ac14-4380-9b46-cd354ca1a983 and coordinator deployment e0f2ee0e-6a30-4443-a980-b274f90d58ec both reached SUCCESS on 41ee898; the public API returned HTTP 200 with database up. The complete isolated Lemo suite now passes 25/25, including real PostgreSQL concurrency tests. Diagnostic-only response retrieval was removed from the private verification function; cleanup deployment e8225e4d-cbef-4d36-8459-9f3b51441c72 reached SUCCESS with paid/runtime test flags disabled.

The AI-authored scene rendering and complete R2/Notion handoff are still in progress at this checkpoint. Artifacts and sanitized job state are under `/workspace/output/lemo-live/production-film/`. Long-scene rendering performance remains unverified.

## Portrait and continuity repair

Visual inspection caught a defect that technical MP4 checks alone would miss: the first rendered scene placed a monochrome landscape panel inside the portrait output, contradicting the approved palette and composition. That revision was cancelled after one rendered scene; a second coding response was already submitted and may incur its own charge. Both requests remain in the ledger. Its reserved total is 0.77 USD.

Commit 4c47302c446b3423c93843b66b36b280a21f1b31 makes the approved full-bleed 1080×1920 delivery contract and color identity override style-document examples. The contract is part of the cache identity, so old landscape source cannot be reused accidentally. Later scenes receive the canonical first-scene drawing code to preserve returning characters. All 26 isolated Lemo tests passed, including this precedence/reference regression and PostgreSQL concurrency. Coordinator deployment 1de0885c-6ac0-4eba-b915-c325f53f636b reached SUCCESS.

The final repair uses draft 624b0efd-e227-4448-adf1-2c3f466eebcf, job 12559419-dfd5-4cb6-8fce-57dcc5fcba1f and episode 1ba03cfd-1c4e-405e-857c-c11c699537d9. The two earlier attempts reserved 2.145 USD; this approval permits 2.8 USD, keeping the combined reservation allowance at 4.945 USD. All six audio assets are again cache hits. The first two actual scenes show the approved mint robot, orange watering can, green plant and yellow umbrella in a full portrait environment. Their render times are 46.636 and 55.186 seconds. Sampling the first scene at 10 fps found motion in all 18 frame intervals; it is not a static illustration. The two remaining scenes and final handoff are pending at this checkpoint.

Commit 5ce9441bc5db43ee4b32fb00474d6f61d3fa52cd fixes the working-queue activity text for Lemo and exposes direct scene review/targeted repair. A real Firefox session on production opened the scene details successfully with zero JavaScript errors; screenshots are saved as `production-lemo-working.png` and `production-lemo-scene-review.png`. Commit f97d6eec918e0bd2be53c99c7e093fa98b271338 also preserves incurred planning usage when creating future scene-repair drafts. The live test's earlier planning usage remains on its original draft and must be included separately when auditing all attempts. TypeScript and the five focused creative API tests passed; API deployment 9fd758a9-bcb8-4e83-ba85-dc36d4fd7c06 reached SUCCESS on f97d6ee.

## Final production acceptance — 2026-11-13 18:00 Asia/Bangkok

EP025 “หุ่นยนต์รักต้นไม้มาก จนต้นไม้ต้องกางร่ม” completed as job 12559419-dfd5-4cb6-8fce-57dcc5fcba1f. It is a real fictional film using GPT-6.1 Sol/high, the automatic Rubber Hose selection, Eleven v4 narration and SFX v3. No reference character was required. Its four scenes visibly depict watering, continued watering, the plant opening an umbrella and the robot stopping. Full portrait color and character continuity were visually checked. All 93 sampled frame intervals across the four scene videos contain visible pixel changes at 10 fps; this measures movement, not subjective cinematic quality.

The final coding response briefly returned HTTP 503 during GET polling. Commit aa3fab82fcde4ddc5f36b1e0ec8e841f38693c07 retries only saved-response GETs, with five bounded attempts for transient status/network failures; authentication failures stop immediately and generation POSTs are never replayed. After deploying, the same job resumed the same fourth response ID, reused its three completed scenes and finished with exactly four coding calls in that final job. No new voice/SFX calls or duplicate coding request were created by that recovery.

| Production component | Deployed commit / image | Successful deployment |
|---|---|---|
| motion-api | f97d6eec918e0bd2be53c99c7e093fa98b271338 | 9fd758a9-bcb8-4e83-ba85-dc36d4fd7c06 |
| lemo-worker | aa3fab82fcde4ddc5f36b1e0ec8e841f38693c07 | c4c7b548-cbd5-4eb7-ac13-dc6c4bd574c9 |
| Classic/fal worker | a49f98928d63fa640e45f2ad20173ca41a4a087b; worker code unchanged by later commits | ae1669da-906d-4ce6-9d6e-b3d4651ebc53 |
| Private executor | sha256:7e2044599bc000ecd92d6ff95abd505db6a2873248fee48c7644a7181aa48281 | 4f7a8849-567e-4e37-a090-5565737d31de |

TypeScript passed. The final API suite passed 138/138; the final isolated Lemo suite passed 28/28, including PostgreSQL concurrency. The unchanged Classic/fal suite's earlier 45/45 result remains applicable. Production `/health` returned HTTP 200 with database up; creative capabilities report enabled, no blockers, auto style, v4 and SFX v3 defaults. Migrations 026/027 were already verified during the initial deployment.

The final MP4 is 9.680 seconds, 1,988,098 bytes, H.264 1080×1920 at 30 fps with AAC 44.1 kHz audio. All 14 QA checks passed without a mastering repair: peak −1.88 dBFS, first audio onset 0.07 seconds against first-word timestamp 0, no black frames, no missing SFX anchors and no unsourced factual claims. Thai subtitles were visually checked. Scene render times were 46.636, 55.186, 51.544 and 91.728 seconds; composition took 14.404 seconds. The displayed production time is 19 minutes 40 seconds, including model processing and recovery. Per-scene Node resource usage is saved, but it is not a total Chromium/VM peak-memory measurement.

All 15 final R2 deliverables passed object/public-URL verification. The source archive contains all four generated HTML sources and the pinned MIT helper, with no private STYLE documents. Live Firefox playback reached the end of the public MP4, then sought to the umbrella scene; reported duration/resolution and zero JavaScript errors are saved in `production-lemo-playback.json`. The Ready card shows `[GPT-6.1 Sol]`. Actual UI screenshots are `production-lemo-ready.png` and `production-lemo-final-preview.png` under `/workspace/output/lemo-live/ui/`.

Notion synchronization completed at 11:00:24 UTC. A direct Notion fetch independently confirmed [EP025](https://www.notion.so/41775d42f42b81d3b0f2da435cf9fb88), Status “Ready to post”, matching job/video URL and unchecked Used/Deleted. The website's publication list is empty: no social post or Buffer queue was created.

The film consumed 45 reported ElevenLabs credits in the original six audio calls; both repair revisions reused those artifacts. Final-job coding used 43,214 input and 38,681 output tokens. The audit retains earlier failed/cancelled attempts and the original planner's recorded nine turns (72,333 input, 195,619 cached input and 27,850 output tokens). Combined production reservations total 4.025 USD; actual provider USD remains unknown and is not claimed to equal that figure. The earlier discarded variant had an already-submitted second coding response whose final usage has not been reconciled. A later background planner response was also already submitted before the planner recovery; its usage is not included in the nine-turn checkpoint. These do not block the completed film, but provider billing reconciliation must include them rather than treating the recorded totals as a complete invoice.

The temporary verification service's provider, storage, probe, Railway and executor credentials were cleared after testing; all automatic test flags are false. Cleanup deployment 60bf5c37-fcca-4315-a458-1fefe24b0774 reached SUCCESS. Production coordinator/executor references remain configured.

Evidence: `/workspace/output/lemo-live/production-film/12559419-dfd5-4cb6-8fce-57dcc5fcba1f/live-test-audit.json`, the delivered MP4/source archive, frame previews and browser screenshots. Real one- or two-minute Lemo films and a complete paid three-story comparison were not tested; the prior three-story comparisons used mocked providers. Rendering is not real time, and verified dollar pricing still needs account rates or receipts.

## Caption readability correction — 2026-11-13

The owner reported unclear letters after the initial delivery. Comparing EP025 with the actual Classic EP004 revealed that Lemo's SRT burn used libass's default landscape coordinates on a portrait video: Thai letters were vertically stretched and had excessively thick outlines. The earlier technical QA/visual check did not catch this readability defect.

Commit 7010a6cbf315d0f95fc44b06ee4b04a316f09109 uses bundled Kanit ExtraBold, explicit 1080×1920 ASS coordinates, a three-pixel outline, a translucent plate and spoken-word highlighting. Width is measured before wrapping Thai tokens into two-line pages. A real FFmpeg regression checks glyph aspect and safe-area bounds. Owner-authenticated, idempotent caption repair reuses the original scene videos/audio, preserves the previous delivery and uses a new public URL on the same episode/job. The dedicated repair path cannot invoke OpenAI, ElevenLabs or the isolated generated-code executor.

Both deployments reached SUCCESS: API f30a015f-2d13-42b8-a261-d1b4a36c9203 and Lemo bc57531a-7c39-47a8-8b7a-1a206864ee62. EP025 was repaired on Railway, all 14 QA checks and all 15 delivery checks passed, and duplicate submission returned the same completed job without requeuing. Its complete provider-call ledger, audio checkpoint, timeline and four scene checkpoints match the pre-repair snapshot exactly. No new model/voice/SFX calls were made. Composition took 5.970 seconds; the new MP4 is 2,207,983 bytes, 9.680 seconds, 1080×1920 at 30 fps, square pixels, with MD5 ea32090b15adea6f3a279ddc95b1df80. It is still unpublished.

The production browser played the corrected clip to completion with zero JavaScript errors. A mobile viewport exposed a second readability issue: the old 52vh preview height reduced the actual portrait picture to about 246px wide at a 390px viewport. The preview now uses the available width on mobile and a larger height allowance on desktop. The non-root coordinator also gives Fontconfig an explicit writable cache under its job directory; this fixes the harmless cache warnings observed during the successful first repair.

Validation for this change: TypeScript and 139/139 API tests passed; five new caption/repair tests passed, including real FFmpeg rendering; the complete Lemo run passed 27 tests and skipped six unchanged PostgreSQL integration tests because this session has no isolated PostgreSQL instance. The Classic/fal run passed 44 tests and skipped its opt-in 60-second assembly test (that test passed in the earlier baseline). These skips are not represented as new successful runs. No migration was required. Saved evidence is under `/workspace/output/lemo-live/typography/`, including the production MP4, before/after frames, provider-reuse audit and actual browser screenshots.
