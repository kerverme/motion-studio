# Evidence and acceptance — 13 November 2026

This file distinguishes actual upstream/local execution from HTTP/provider fixtures. No new paid provider calls have been made in the development run at this checkpoint.

| Test | Evidence at checkpoint | Status |
|---|---|---|
| A real input/shot boundaries | Actual pinned rea-video analyzed public upstream `docs/cases/videos/dual_role.mp4`: 10 measured shots; VIDEO.md reference validator passes; exact decoded frame indices/PTS normalized; full-resolution frames and real vocals/music/effects stems retained | LOCAL PASS |
| B meaningful real Vision | Real Gemini adapter, quote, persisted approval, queue ledger, per-shot schema and English prompt implemented; transport fixtures tested | LIVE OWNER APPROVAL REQUIRED |
| C isolated scene editing | Real Chromium + local HTTP fixtures: change character/location in one shot; other shot byte-for-byte unchanged; UI persistence and version endpoint tested against PGlite | PASS (fixtures; not semantic quality) |
| D actual Capsule recipe/plan | Actual pinned Python APIs create, validate and build lifecycle/production plan; private-literal leakage rejected; no provider dispatched | LOCAL PASS |
| E routing | Strict code/generative/hybrid contract, real typed Motion render, verified Fal presets; 120 visible T2V endpoints / 61 maintained ready presets at snapshot | LOCAL/CONTRACT PASS; live generation not yet approved |
| F budgets | PGlite persisted quote/source/analysis/key/expiry checks, duplicate approval one job, existing Ledger accepted-ID vs unknown POST tests, single-POST disconnect and GET-only accepted resume | PASS (no paid calls) |
| G isolated repair | Queue/worker fixture executes only selected shot; unchanged completed assets reusable across revisions | PASS (fixture) |
| H assembly | Real FFmpeg/Pillow Code Motion assets, actual alignment validator/subtitle overlay path, local ordered assembly with audio track and technical decode/duration/resolution/fps checks | LOCAL PASS; no claim of real-provider full film |
| I regression | Motion API 143 passed; worker 52 passed / 1 skipped / 13 subtests at first integration checkpoint. Re:Video full regression rerun with writable model cache in progress | See final deployment evidence |

Baseline before edits: Re:Video test suite passed; Motion API 137 passed, worker 44 passed / 1 skipped / 13 subtests; latest rea-video 266 passed; Capsule default pytest collection 1 passed (not broad integration coverage).

Public source was analyzed locally, not redistributed into this repository or sent to a paid provider. UI screenshots use explicitly marked schema/HTTP fixtures; their text is not model-quality evidence. Original VIDEO.md package is immutable; derived model-observation package uses actual upstream `videomd.write/check`, labels model reading, never human review, and preserves prior method probabilities.

Pending: current production deployment smoke, actual representative Gemini video interpretation after a concrete current quote and owner approval, optional live image/video/audio/visual-QA tests after separate quote approval, long/complex source QA, owner assessment of identity/action fidelity. Do not label the entire system production acceptance complete while these are pending.
