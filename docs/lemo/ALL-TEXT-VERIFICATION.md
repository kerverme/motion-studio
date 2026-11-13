# Complete lettering repair — 2026-11-13

The owner clarified that the unclear lettering included the upper headline and every label inside the scene. The earlier caption-only repair did not change these Canvas letters. The old helper used synthetic font weight, thick outlines, horizontally compressed glyphs and an offset duplicate headline.

Implementation commit `19578b3890e5e1ae96016238a1d8ca83686dacfa` embeds the bundled Kanit 700/800 fonts in every Lemo scene, waits for the real fonts before rendering, enforces readable Canvas text, and uses uniform font sizing instead of squeezing glyphs. New scene prompts use `MotionText.draw` for headlines, labels and numbers. The owner-authenticated `repair-typography` route deterministically repairs saved supported scene sources and renders them again in the verified Railway Sandbox. It keeps original sources and the previous delivery, checkpoints each completed scene, and reuses audio/timing without LLM or ElevenLabs calls. Unsupported sources stop visibly.

The deployment also preserves the independently deployed Reverse Video/Capsule work from `3080edb1d2a62617ec8d09d91cdbe08cf52c81ee`. Both production services reached SUCCESS at the merged commit **`4e71f076e9e33f0c6a50d960d65a4dc0908d9ced`**:

- API: `f730e522-3af4-467d-9877-1f76b53b648c`
- Lemo worker: `30e37837-26be-410f-9c6d-b87277cd9c57`

EP025, job `12559419-dfd5-4cb6-8fce-57dcc5fcba1f`, was repaired on production and returned to READY_TO_POST. All four scenes now use `all-text-kanit-v1`. Actual scene previews and the assembled video visibly show the solid Kanit headline “รักจนต้องกางร่ม”, the larger “เรื่องสมมติ” sign, and the “กางร่มเลย” label. Existing characters, actions, narration, SFX and timing remain. Every provider-call ledger entry and the audio/timeline checkpoints exactly match the pre-repair snapshot; there were zero new model/voice/SFX requests. Sandbox compute was used. Repeating the repair request returned `duplicate: true` without changing checkpoints or provider calls.

All 14 media QA checks and all 15 delivery checks passed. The actual downloaded MP4 is 2,221,439 bytes, 9.680 seconds, H.264 1080×1920 at 30 fps, square pixels, AAC 44.1 kHz; MD5 `27bb4d09f6bcfcebbd40ca6e9bf84329`. The four scene renders took 148.56, 52.89, 60.24 and 88.37 seconds, within the existing limits. The renderer image and isolation gate were unchanged.

The production browser played the new versioned video through to the end with zero JavaScript errors. Desktop and 390×844 mobile screenshots were captured; the mobile video is 346×615 pixels. The Reverse Video navigation remains present. `/health` reported database up and the reverse configuration endpoint remained available. Notion independently confirmed the updated video URL at 14:15:16 UTC: [EP025](https://www.notion.so/41775d42f42b81d3b0f2da435cf9fb88) is Ready to post, Used/Deleted unchecked. No social publication exists.

Validation on the merged code: TypeScript passed; API 146/146 passed; Lemo 31 passed and six unchanged PostgreSQL integration tests skipped; Classic/reverse worker 52 passed and three environment-dependent/opt-in tests skipped. A trusted hand-authored browser fixture also verified real offline font loading under the renderer's CSP. Generated film HTML was executed only in the verified Railway Sandbox, never in the local development browser. These skipped tests are not claimed as passed. This typography change requires no schema migration.

Actual evidence is saved under `/workspace/output/lemo-live/all-text/`: `production-all-text.mp4`, `production-audit.json`, `idempotency.json`, `episode-audit.json`, `all-text-before-after.png`, individual scene previews, and the `ui/` production screenshots/playback results. The comparison uses the same 5.3-second position in the previous subtitle-corrected delivery and this complete lettering repair. The repair was applied to EP025; other completed clips are not automatically regenerated.
