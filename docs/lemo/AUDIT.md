# Lemo development audit — 2026-11-12

Initial development baseline: branch `feat/lemo-creative-motion`, based on `3e43db1fbab64601b9c8417dc7410825623d5891`. Main and production were inspected before changes. API live deployment `ebc59f72-36d5-41f0-8485-89653828a1ca` serves this commit. Classic worker live deployment `531fd777-bedf-47cb-9965-c7f3f7e6fc0d` serves `40944be8f1d912c48ea1a1e0b0e4d47838a71dc1`; the subsequent commit changes only API/UI. Neither service had pending staged changes. Production migration/deployment was not authorized at this initial audit; the owner has since explicitly authorized it. See [current live verification](LIVE-VERIFICATION.md).

## Preserved boundaries

Studio currently researches with OpenAI first, bounds the shared Firecrawl Research Job at 25 credits, checkpoints drawings and stores retrieved URL evidence. The Classic worker uses Python/Pillow/NumPy and FFmpeg. fal Text-to-Video has a separate planner, approval ledger and resumable provider requests. Existing publication handoffs upload to R2, synchronize Notion and require owner action for Buffer. These routes, caches, packages and deliveries remain supported.

Lemo gets an additive job kind and its own coordinator. Classic claim excludes that kind. Generated JavaScript executes only in an external restricted renderer; it never runs in the API or credential-bearing coordinator. Rendering uses Lemo's deterministic `window.render(t)` contract, a pinned MIT helper library, and an allowlisted Canvas2D implementation. GPU/image-generation-dependent styles are not advertised as supported. Scene changes invalidate only the affected source/render cache; changing the film identity invalidates all scenes.

## Upstream and licensing

Lemo-Opuscar 2.0.0 is pinned at `3a7132b996be0241c1ea0ab180d519f06e6f10b6`. README, AGENTS, DIRECTOR, TECHNIQUE, plugin workflow, relevant STYLE specifications, renderer, dependency files, LICENSE and REUSE rules were inspected in a separate private checkout. `upstream.lock.json` records exact code and style-spec hashes. Only MIT code and registry identifiers are distributed here. Upstream Markdown style instructions, demo films, prompts, voices, trademark characters and other demo assets are not copied into this product.

The upstream LICENSE requires separate permission for commercial documentation use beyond its additional film permission. The owner has now clarified that this is a private Studio making their own social videos. The additional permission explicitly covers that owner/team film workflow, including commercial and client films; it does not require a separate commercial service licence. See [clarified scope](LICENSING-SCOPE.md). Keep the private style library outside the repository/container image, and keep unverified runtime release gates disabled. Contact details and full terms are preserved in `lemo-worker/vendor/lemo/LICENSE`.

## Provider contracts

Official ElevenLabs OpenAPI retrieved 2026-11-12: `https://api.elevenlabs.io/openapi.json`. v4 narration uses `/v1/text-to-dialogue/with-timestamps`, `inputs[{text,voice_id}]`, explicit `model_id`, `language_code`, and dialogue `settings` (stability/similarity). Each request stays within 2,000 text characters. The response supplies audio, character alignment, normalized alignment and voice segments. Missing/invalid alignment fails visibly. No silent v3 fallback. `/v1/sound-generation` accepts explicit `eleven_text_to_sound_v3`, duration and prompt influence; looping is restricted to v2. Real account compatibility and real Thai timing remain release gates: automated tests use mocks.

No verified account price for v4/SFX v3 was available. Rates must come from configured account pricing with provenance; absent rates remain unknown. A bounded, explicitly acknowledged allocation is necessary before an unknown-price call. A reservation is persisted before every paid request. Ambiguous network outcomes are held for reconciliation, never blindly resubmitted.

## Operational constraints

Railway hosts the coordinator, not a privileged Docker daemon. The renderer requires a separately operated gVisor executor with no egress, credentials, host mounts or Docker socket in the generated-code container. Docker/runsc is available in the development environment; bubblewrap/user namespaces alone are unavailable. Production activation additionally requires independently verified executor resource enforcement and an immutable renderer image digest.
