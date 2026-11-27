# UGC AI in Motion Studio

Open **UGC AI** in the sidebar. Create a draft and upload a JPEG, PNG, WebP or MP4 up to 32 MB, or import a product from the configured Notion catalog. An uploaded MP4 must be at most 3 minutes. **เทรนด์สินค้า** remains a research view. **ใช้สินค้านี้ทำคลิป** copies the product name and evidence into a draft. Fill in the actual purchase link, THB price and any store-confirmed benefits before quoting.

UGC starts at 20 seconds. OpenAI proposes three Thai hooks and an editable sequence of cuts. The first and last cuts use the original product media, and the opening occupies 3–5 seconds. Select original media for any other cut where the model name, logo or packaging needs to be exact. A generated cut takes a portrait reference image or the first frame of the selected MP4. The local compositor places the price, subtitles and CTA. Change these fields from **เปิดฉบับแก้ไข** to re-export using saved provider assets. The built-in subtitle timing tracks ElevenLabs character alignment. An optional subtitle override uses the edited scene's timing.

Select the video model and its generation resolution separately from the OpenAI model. The final export is always 1080×1920. The model list checks Studio's fal catalog, exact API schema and pricing. Each generated cut quotes the supported generation duration and charged units, even if the edit uses fewer seconds. The quote records the time of each pricing check. The API checks the quote again on confirmation and before new paid dispatches. ElevenLabs voice is itemized separately. OpenAI planning happens earlier and has its own account usage. Local editing requires no separate paid provider request.

Click **ยืนยันราคาและเริ่มผลิต** after reviewing the estimate. Reload UGC AI to see the current revision, scene progress, previous exports and current estimate. A failed job can request a fresh quote. Existing fal request IDs are polled and finished cuts and voice assets are reused. If a provider outcome is ambiguous without a durable receipt, reconcile it in the provider's account before making another revision. For a replacement, **สร้างฉาก … ใหม่** prepares a draft with only the selected video cut marked to regenerate. Review the quote again before paying for it.

Use **ดาวน์โหลด MP4** and **คัดลอกแคปชันและลิงก์** on the finished clip. The purchase button opens the URL confirmed by the owner. Add the supplied link in the destination platform's product link control when posting.

## Environment

| Service | Configuration |
| --- | --- |
| motion-api | Existing Studio owner login and bucket configuration. `OPENAI_API_KEY` and optional `OPENAI_BASE_URL` for Hook and scene planning. `FAL_KEY` for live catalog pricing and dispatch verification. Existing `MOTION_INTERNAL_TOKEN` authenticates worker dispatch checks. |
| motion-worker | Existing Studio bucket settings, `FAL_KEY`, `ELEVENLABS_API_KEY`, `MOTION_DEFAULT_VOICE_ID`, `MOTION_INTERNAL_TOKEN` and `MOTION_API_INTERNAL_URL`. Configure ElevenLabs and enable a Thai voice supported by the existing Text to Video capability probe. Use the same fal account for API pricing and worker dispatch. |
| Notion product catalog | `UGC_NOTION_TOKEN` and `UGC_NOTION_DATABASE_IDS` on motion-api. The latter is a comma-separated allowlist of Notion database IDs. Give the integration read access to the selected single-source catalog and choose actual columns in UGC AI. This is independent of Motion Studio's episode sync. Internally hosted Notion media can be imported to Studio and unsupported external attachments can be uploaded directly. |
| Product trend research | Existing `OPENAI_API_KEY` and optional `FIRECRAWL_API_KEY` from Draft PR #8. |

Migration `045_ugc_ai.sql` creates UGC drafts, media and approvals and reuses the existing jobs and receipt ledger. Deploy the compatible motion-worker first, followed by motion-api, before enabling production tests. The UGC API requires the worker's UGC capability heartbeat to issue a quote. Credentials stay in the services.

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

The fixture uses mocked OpenAI responses, Notion product data, fal pricing and generation and ElevenLabs audio. It runs the real HTTP approval flow and private dispatch checks, PostgreSQL job claim and provider ledger, Thai subtitle compositor, FFmpeg, MP4 validation and Studio export responses. It checks quote invalidation, double-confirmation, reuse of accepted receipts, blocking unknown outcomes, single-scene regeneration and the 30-second limit. The mocked audio is a test tone. Check pronunciation, the product face/packaging in generated footage and signed delivery with a real account after staging and explicit approval of a live quote.
