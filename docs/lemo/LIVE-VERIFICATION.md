# Live verification — 2026-11-13

The owner explicitly authorized production deployment and real tests. The feature has not yet been activated on the production API or worker. A separate private Railway verification function ran two bounded provider calls using production variable references; no credentials were exported and no public domain was created.

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
| Full AI-generated Lemo film in Railway Sandbox | Pending restored-checkpoint and coordinator end-to-end test |
| Main API/worker deployment, migration, R2/Notion end-to-end handoff | Not yet performed for this feature |

The character-cost headers are recorded as provider units, not invented USD amounts. These results prove provider contract compatibility and timeline parsing, not subjective narration quality or full video synchronization. The earlier connector-only voice test and synthetic development comparisons remain separate evidence.

The local development Docker runtime ignores cgroups and remains prohibited for generated HTML. Real Railway Sandbox verification passed on 2026-11-13: host-kernel cgroup v2 enforced two CPU quota, 2 GiB memory, zero swap and 1024 PIDs. The credential-free render container uses UID 65534, a read-only root, zero effective capabilities, a 384 MiB tmpfs and no network. A fixed probe observed root writes rejected and outbound networking returning ENETUNREACH. See [recovery evidence](RAILWAY-RECOVERY-20261113.md) for the first successful 3-second fixture.

The owner installed the production Project Token in lemo-render-executor, deployment 67d3d19c-a5ed-44c0-b8a1-ba9d30178a30 reached SUCCESS, and a private read-only Sandbox checkpoint listing succeeded using that token. No token was exported. A reproducible credential-free bootstrap produced image sha256:7e2044599bc000ecd92d6ff95abd505db6a2873248fee48c7644a7181aa48281 and repeated the kernel/isolation checks successfully. Checkpoint restore and complete film checks are still pending.

After restoring all pending work onto the latest feature commit, TypeScript passed, 137 API tests passed, 22 isolated Lemo tests passed including real PostgreSQL concurrency, and 45 Classic/fal worker tests passed including real synthetic 60-second video assembly.

The owner's own social films are covered by [the upstream additional film permission](LICENSING-SCOPE.md). That licensing clarification is independent of the remaining runtime checks.
