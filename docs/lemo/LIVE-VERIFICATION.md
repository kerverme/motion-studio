# Live verification — 2026-11-13

The owner explicitly authorized production deployment and real tests. API, Classic worker, private render executor and the new Lemo coordinator have successful Railway deployments. Lemo remains disabled because automatic approval review rejected provisioning the new coordinator's production credential references; a specific credential-scope confirmation is pending. A separate private Railway verification function ran two bounded provider calls using production variable references; no credentials were exported and no public domain was created.

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
| Full AI-generated Lemo film in Railway Sandbox | Checkpoint restore/fixture render passed; actual AI planning/coding and coordinator end-to-end film pending |
| Main API/worker deployment and migration | Passed; deployment IDs and migrations below |
| New Lemo film R2/Notion handoff | Pending; existing 23-item Notion sync passed |

The character-cost headers are recorded as provider units, not invented USD amounts. These results prove provider contract compatibility and timeline parsing, not subjective narration quality or full video synchronization. The earlier connector-only voice test and synthetic development comparisons remain separate evidence.

The local development Docker runtime ignores cgroups and remains prohibited for generated HTML. Real Railway Sandbox verification passed on 2026-11-13: host-kernel cgroup v2 enforced two CPU quota, 2 GiB memory, zero swap and 1024 PIDs. The credential-free render container uses UID 65534, a read-only root, zero effective capabilities, a 384 MiB tmpfs and no network. A fixed probe observed root writes rejected and outbound networking returning ENETUNREACH. See [recovery evidence](RAILWAY-RECOVERY-20261113.md) for the first successful 3-second fixture.

The owner installed the production Project Token in lemo-render-executor, deployment 67d3d19c-a5ed-44c0-b8a1-ba9d30178a30 reached SUCCESS, and a private read-only Sandbox checkpoint listing succeeded using that token. No token was exported. A reproducible credential-free bootstrap produced image sha256:7e2044599bc000ecd92d6ff95abd505db6a2873248fee48c7644a7181aa48281 and repeated the kernel/isolation checks successfully. Subsequent checkpoint restore and a real fixture render passed as detailed below; the complete AI-authored film remains pending.

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

After explicit credential-scope confirmation: provision the minimal necessary references, private STYLE documents and CA trust; verify readiness; activate supported gates; run one short idempotent real film through planning, coding, rendering, audio, QA and R2/Notion delivery with auto-publishing disabled. Cost estimates must retain unknown prices honestly and follow the existing approval ledger. Subjective AI animation quality, complete production handoff and long-scene render performance remain unverified.
