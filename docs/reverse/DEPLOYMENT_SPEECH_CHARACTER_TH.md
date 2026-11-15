# Source dialogue and main-character design

This update adds two focused capabilities to the prompt workspace:

- Transcribe the selected audio separately from timestamped image analysis. Preserve original-language dialogue in both A and B. Add dialogue to an existing A without requesting visual analysis again.
- Expand a short replacement-character brief into appearance and story-appropriate clothing. Change only the selected character slot and explicitly edited locations while keeping other characters, shots, timing, actions and dialogue unchanged.

Manual slot edits remain free of LLM calls. Both AI operations require a current model/price quote and explicit approval. Typing does not submit inference. Changing inputs invalidates a displayed or in-flight quote. Credentials stay on the server.

Audio evidence is separate from visual evidence. Audio enrichment creates a new prompt version and preserves earlier versions. Audio offsets and the selected window come from media measurement; the transcript does not claim word timestamps or known speaker identity. Synchronous transcription with an unknown POST outcome is never automatically resubmitted. Reusing the same audio across different parent prompt versions shares the same cache claim.

## Code verification

- API typecheck and 163 tests passed on the combined implementation, including existing application features and financial approval/idempotency checks.
- 20 targeted worker tests passed, including real FFmpeg cuts with delayed audio and a nonzero video origin, audio/video duration alignment, audible preview, Python/JavaScript compiler and hash parity, unchanged supporting cast and dialogue, and duplicate/unknown POST protection. Four creative-audio tests also passed on the same worker implementation.
- The web bridge passed 12 tests covering access boundaries, CSRF and exact character-quote forwarding without approval.
- Chromium passed 41 checks across the speech/character flow, existing prompt pairs, progress and reconnection. These used explicit HTTP fixtures and included mobile layout, editable character descriptions, input preservation and late quote invalidation.

Development tests did not perform paid inference or video generation. Fixtures demonstrate program behavior, not ASR accuracy or model output quality. A prompt does not guarantee exact generated-video appearance, voice or lip sync.

Operational deployment details and private acceptance evidence are intentionally excluded from this public report.
