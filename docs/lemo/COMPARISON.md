# Technical fixture comparison — 2026-11-12

All AI semantic decisions, code and provider responses were fixtures. Both engines produced real 1080×1920, 30 fps H.264/AAC MP4s with rendered Thai subtitles. Audio is a synthetic test tone, not a real ElevenLabs voice. Each film is eight seconds; the script/identity/rationale/source evidence is stored alongside it. This comparison checks technical integration, not live AI creative quality.

| Story | Selected installed style | Rationale | Classic render + mux | Lemo sandbox wall time |
|---|---|---|---:|---:|
| ประเทศไทยมีคนชื่อ นิก กี่คน? | `dataviz` | Keep an unknown count visible; do not manufacture a statistic | 3.73 s | 60.09 s |
| ทำไมคนเราถึงฝันตอนนอน? | `firefly-pointillism` | Separate illustrative dream imagery from measured brain activity | 4.29 s | 56.96 s |
| ถ้าแมวทุกตัวในประเทศไทยพูดได้หนึ่งวันจะเกิดอะไรขึ้น? | `rubber-hose` | Original characters, a comic escalation and reversal | 3.92 s | 52.99 s |

These timings have different boundaries: Lemo includes container/browser startup and frame capture; Classic includes its render and mux. Lemo's subsequent subtitle burn/mux is additional. They are not billing rates or an optimized throughput benchmark.

All six outputs passed the existing technical QA checks for decoding, video/audio format, duration, peak level, narration presence, mock onset synchronization, SFX level, black frames and scene content. Thai glyphs were also inspected in an encoded final frame. Real alignment precision and intelligibility remain untested because the voices are mocked.

Provider requests: **0 real calls**, **0 real AI tokens**, **USD 0 provider charges from these tests**. Rendering infrastructure pricing is unknown. The runtime's Docker CPU/RAM samples reflect a broader host scope and are explicitly excluded from per-job cost or resource claims. Node process rusage is recorded in each renderer metadata file, but excludes Chromium/FFmpeg and does not prove limits. Production resource measurements must be repeated on the approved executor.

Source handling: NHLBI's sleep-stages page was retrieved successfully and supports the REM-related statements. The BORA main site was accessible, but its statistics subdomain could not be retrieved in this check; no verified nationwide nickname count was obtained. The Nick fixture explicitly says the number is not verified. It does not claim that no dataset exists. The cats story is labelled fictional.

Generated artifacts from this run:

```text
/workspace/output/lemo-comparison/report.json
/workspace/output/lemo-comparison/{nik,dream,cats}/classic-final.mp4
/workspace/output/lemo-comparison/{nik,dream,cats}/lemo-final.mp4
/workspace/output/lemo-comparison/{nik,dream,cats}/storyboard.json
/workspace/output/lemo-comparison/{nik,dream,cats}/lemo-preview-{0,1,2}.png
/workspace/output/lemo-ui/{create-engine,storyboard,cost-review}.png
```

`render_comparison.py` regenerates the comparison without paid providers. The UI screenshots are from the development build with API fixtures, not production screenshots. Production still serves the audited baseline.
