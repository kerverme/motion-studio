# Railway production work — 2026-11-13 recovery handoff

This is the historical interruption record. Activation, later deployments and real-film results are recorded in [live verification](LIVE-VERIFICATION.md); the pending items below describe the earlier handoff, not the current service state.

The owner explicitly authorized real tests and production deployment. Main API and Classic worker still run their previous healthy deployments. Lemo has NOT been activated, and its migrations have NOT been applied to production. No clip was automatically published.

## Permission

The owner's own social films, including commercial films, are covered by upstream's additional film permission. See [the exact scope](LICENSING-SCOPE.md). The owner-film permission patch was implemented and tested in the working copy, but its files have not all been committed. Do not set the broader commercial-service licence flag as a workaround.

## Real provider evidence

A private Railway verification function used production variable references, with no public domain and no exported provider credentials. Exclusive object-storage reservations prevent the same paid operation from being sent twice.

- Deployment 49874640-e3d1-4831-badf-2f06e356a6ac reached SUCCESS.
- OpenAI model listing returned Sol, Terra and Astra.
- ElevenLabs v4 and the configured Thai voice were available.
- v4 timestamp request QlAypYNvYILiKPDEBnxo returned HTTP 200 and character-cost 36.
- One one-second SFX v3 bowl tap returned HTTP 200 and character-cost 11.
- The saved real responses passed the existing worker's speaker, alignment and audio validation, without extra provider requests.
- Narration decoded to 7.471 seconds; 81 aligned characters produced 23 Thai tokens. The last provider timestamp was 7.52 seconds, within the existing 150 ms tolerance.
- Billing/subscription read returned HTTP 401. Character-cost units were NOT converted to invented dollar amounts.
- Automatic startup replay on the verification function was disabled after evidence was saved.

These checks do not prove subjective narration quality or complete production video synchronization.

## Real Railway rendering evidence

A Railway Sandbox was successfully created with two vCPUs, 4 GB memory and ISOLATED networking. Generated-code containers additionally use runsc, network=none, a read-only root, UID 65534, no capabilities, no-new-privileges, two CPU quota, 2 GiB memory, zero swap, a 384 MiB writable tmpfs and bounded execution/output.

A real host-kernel cgroup check confirmed memory.max=2147483648, memory.swap.max=0 and cpu.max=200000 100000. PID membership is verified against the running sentry; the code no longer assumes that gVisor's virtual /sys exposes host cgroup files. Local Docker configured with ignore-cgroups still fails closed.

A fixed isolation probe verified UID 65534, no Docker socket, no provider/database credential names in the container environment, root writes rejected, tmpfs 402653184 bytes, zero effective capabilities and network connection rejected with ENETUNREACH.

runsc release-20260413.0 was verified against its official checksum:
- Binary SHA-256: c97966a7bce00a6ce6de2f931b2b4cf0cbe979d5f47d9feda75f5bbbce0d93ad
- URL: https://storage.googleapis.com/gvisor/releases/release/20260413.0/x86_64/runsc
- Use platform=ptrace on the tested Railway kernel. Systrap failed at syscall-thread initialization.

Chromium/gVisor exceeded the initial 256/512 PID budgets. The final bounded PID limit is 1024. A real render then completed using the normal runtime gate, without the trusted-fixture bypass:
- Image: sha256:e9b88f392ece679382a653b377e10d1967507ee9de9a99777442124b569e39d0
- H.264, 1080x1920, 30 fps, 90 frames, 3.000 seconds.
- Rendering time reported by the harness: 65.623 seconds.
- Thai glyphs and the expected cat fixture were visually inspected.
- Sampled memory stayed below 1 GiB in this run. This is a technical fixture, not a film written/drawn by the live AI.

BuildKit was installed because the sandbox's initial Docker client lacked buildx:
- buildx v0.29.1 linux-amd64 SHA-256: 7d2d7d6d4680aa349614965aaa33ccec43f1a9a21e908a5ce4cb6adfa5ad5141
- URL: https://github.com/docker/buildx/releases/download/v0.29.1/buildx-v0.29.1.linux-amd64
- Build the existing lemo-worker/sandbox/Dockerfile with lemo-worker as context.

The successful sandbox ID was e5df9548-b273-479c-9a7c-688cdc34e368, with a 15-minute idle timeout. No reusable checkpoint was confirmed before the development environment became unavailable. Do not assume the sandbox still exists. Rebuild if it expired; do not deploy an unverified replacement image.

## Services and remaining deployment work

- Project: d8173477-9d20-43bf-b0a6-692fed643f0f
- Production environment: eb069d56-ef1e-4789-9137-bc26615ed28d
- Private lemo-render-executor function: 1ff0af1f-11b6-4b39-bf46-dcf0df8046c7
- Temporary provider verification function: 30bd2ed9-f304-4dc9-bedc-e00de5cd435c
- Main API stayed at 3e43db1fbab64601b9c8417dc7410825623d5891, deployment ebc59f72-36d5-41f0-8485-89653828a1ca.
- Classic worker stayed at 40944be8f1d912c48ea1a1e0b0e4d47838a71dc1, deployment 531fd777-bedf-47cb-9965-c7f3f7e6fc0d.

The controller is prepared with authenticated private TLS on port 8443 and a health-only HTTP listener; it has no public domain, provider keys or database credentials. The source is saved in sandbox/railway-controller.ts. It still needs an approved checkpoint/image, a project-scoped RAILWAY_TOKEN, coordinator CA trust and end-to-end verification. The OAuth login could create sandboxes but Railway denied projectTokenCreate. The owner was asked to create the production Project Token in Railway and place it directly in this service's variables, without sending it in chat. Do not persist the broad OAuth login as an application credential.

After runtime restoration: capture and restore-test the checkpoint, finish the private owner permission patch, provision the private pinned style documents on the coordinator, run final tests, check latest main and pending deployments, then merge/deploy API, Classic worker and the isolated Lemo coordinator. Verify migrations 026/027, worker claims, cost review, one short real Lemo job, artifact/Notion handoff and live UI screenshots. Keep auto-publishing off. Preserve the completed provider evidence and do not regenerate it merely because a connection was lost.

## Tests and interruption

The last confirmed working-copy checks were TypeScript, 137 API tests and 22 isolated Lemo tests (including four owner-permission tests and real local PostgreSQL concurrency). Existing worker code was unchanged from its earlier 45/45 passing suite. The final 1024-PID constant and compact statistics output need the final test run confirmed again; the environment disappeared before that rerun's output could be read. The live fixture itself already used a 1024 PID quota successfully.

The managed development environment became unavailable after exec-server reported a disconnected transport and a 45-second recovery timeout. Its status endpoint still reported running, but the explicit environment state was unavailable and no diagnostic history was retained. No production service failure was observed.

Preserve the interrupted working copy and its uncommitted changes. In particular, do not reset the permission changes in api/src/creative.ts, api/src/creative.test.ts, lemo_worker/catalog.py, coding.py, render.py, .env.example, style-directions.json and tests/test_permissions.py. The runtime files in this recovery commit were reconstructed from the exact patches and deployed controller source after filesystem access was lost. Reconcile them with the working copy and validate before production activation.
