# UGC AI in Motion Studio

Open **UGC AI** and upload a real product image or import one from the configured Notion catalog. JPEG, PNG, WebP and short MP4 are accepted up to 32 MB. MP4 can also be used for detail shots. Product Trends can open a draft with a product name and trend evidence. Store price, offers and a checkout URL are optional and supplied by the owner. The Studio purchase button appears when the owner confirms a URL.

Choose **คลิปคนจริงถือสินค้า**, **อัปโหลดรูปคนรีวิว**, or **สร้างพิธีกร AI**. For a clip, scrub to a frame that shows the person, hands and product and select that frame. The worker extracts it locally without provider charges. For a portrait or AI presenter, select an image editing model, review its current per-image estimate, and approve the image generation. Confirm the resulting opening reference before asking for a video quote. A product-only image is reserved for the detail shots.

OpenAI offers three Thai creative angles, each with a short spoken script. Pick one and review the editable storyboard. New drafts start at 18 seconds, 9:16 and 720p. The first three seconds and the close animate the same approved frame with the reviewer's image and the product. The middle uses real product imagery, with optional other inserts. The AI presenter script introduces or demonstrates the product and uses facts entered by the owner.

Choose a verified image-to-video endpoint supporting native audio for the speaking cuts. Each fal line item shows the generated duration, edited duration, billed units, model and current USD estimate. Thai speech on the speaking cuts is generated together with the video. The middle's voiceover is separately itemized from ElevenLabs. OpenAI script suggestions disclose token use when requested. Price, subtitles and CTA are applied in Studio. Models, prices, schema and references are bound to each approval. A change or a new paid attempt requires another quote. Provider receipts survive restarts and proof of uncertain submission blocks duplicates.

Open the rendered clip to inspect the actual first frames and jump to each scene. The worker checks file dimensions, duration and audio and flags large changes from the approved first frame. Use the scene checklist for product and logo fidelity, face and hands, actual spoken Thai and lip-sync, subtitles and CTA. Use **แก้เฉพาะฉาก** to open an edit and request a price for that scene while keeping completed assets for the others. Download the MP4 or copy the caption and confirmed checkout URL.

## Environment

| Service | Configuration |
| --- | --- |
| motion-api | Existing Studio owner login and bucket configuration. `OPENAI_API_KEY` and optional `OPENAI_BASE_URL` for Hook and scene planning. `FAL_KEY` for live catalog pricing and dispatch verification. Existing `MOTION_INTERNAL_TOKEN` authenticates worker dispatch checks. |
| motion-worker | Existing Studio bucket settings, `FAL_KEY`, `ELEVENLABS_API_KEY`, `MOTION_DEFAULT_VOICE_ID`, `MOTION_INTERNAL_TOKEN` and `MOTION_API_INTERNAL_URL`. Configure ElevenLabs and enable a Thai voice supported by the existing Text to Video capability probe. Use the same fal account for API pricing and worker dispatch. |
| Notion product catalog | `UGC_NOTION_TOKEN` and `UGC_NOTION_DATABASE_IDS` on motion-api. The latter is a comma-separated allowlist of Notion database IDs. Give the integration read access to the selected single-source catalog and choose actual columns in UGC AI. This is independent of Motion Studio's episode sync. Internally hosted Notion media can be imported to Studio and unsupported external attachments can be uploaded directly. |
| UGC product media | Set `UGC_R2_ENDPOINT`, `UGC_R2_ACCESS_KEY_ID`, `UGC_R2_SECRET_ACCESS_KEY` and `UGC_R2_BUCKET` on both services. Use credentials scoped to a private Cloudflare R2 bucket. Uploads and normalized frames go to that bucket, and the worker signs the stored frame for fal when dispatching a new request. The UGC settings fall back to the matching `R2_*` variables if unset. The Studio bucket stores job artifacts and exports. |
| Product trend research | Existing `OPENAI_API_KEY` and optional `FIRECRAWL_API_KEY` from Draft PR #8. |

Migration `045_ugc_ai.sql` creates UGC drafts, media and approvals. `046_ugc_presenter.sql` adds media roles, image-stage receipts and scene reviews. Both stages use the existing jobs and provider receipt ledger. When deploying from a version that already has UGC, apply the migration before starting the new worker and confirm its capability version 3 before deploying the API. Existing approved product-only jobs still use their legacy contract. The UGC API requires the worker's UGC capability heartbeat to issue a quote. Credentials stay in the services.

## Reproduce the mock end-to-end test

Run against a fresh local PostgreSQL database named `ugc_test` and the Studio worker's installed Python dependencies, FFmpeg and ffprobe. The test applies the migrations and closes connections after it finishes.

```sh
cd api
npm ci
npm run typecheck
UGC_TEST_DATABASE_URL=postgresql://localhost/ugc_test \
UGC_TEST_PYTHON=/path/to/worker/venv/bin/python \
npx tsx --test src/ugc.test.ts
```

To include the browser run, install Playwright in the test Python environment and Chromium. Set `UGC_TEST_BROWSER=1` and set `UGC_CHROMIUM` to its executable if needed. The optional `UGC_BROWSER_OUTPUT` path saves the fixture screenshot.

The fixture uses mocked OpenAI responses, Notion product data, fal pricing and generation, R2 media storage, and ElevenLabs audio. It runs the real HTTP approval flow and private dispatch checks, PostgreSQL job claim and provider ledger, Thai subtitle compositor, FFmpeg, MP4 validation and Studio export responses. It checks quote invalidation, double-confirmation, reuse of accepted receipts, blocking unknown outcomes, single-scene regeneration and the 30-second limit. The browser uploads only a fictional PS5 game box, selects an AI reviewer, checks both approvals and asserts that the saved frame shown in Studio becomes the input in the first and last fal payloads. It also checks single-scene replacement, extraction from an uploaded clip and the existing Text to Video tab. Audio fixtures use tones. Live pronunciation, lip-sync, rendering quality, signed delivery and actual billing require approved real-account tests.
