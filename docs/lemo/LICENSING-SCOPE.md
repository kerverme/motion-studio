# Permission for the owner's private film workflow

The owner clarified on 2026-11-13 (Asia/Bangkok) that this Studio makes their own videos for social posting. It is not being released as a general style-library service for other customers.

The pinned upstream LICENSE explicitly says: "Films you make with the library are yours, commercial films included, and need no credit". Its **ADDITIONAL PERMISSION FOR THE DOCS** permits the owner and people working with them on a film (staff, contractors and client) to read, follow, copy and adapt the documentation to make their own films, including commercial and client films. The separate commercial-service permission concerns use beyond that grant.

For that private film workflow, configure `LEMO_STYLE_LIBRARY=owner-films`, `LEMO_FILM_USE_APPROVED=true` and `LEMO_PRIVATE_OWNER_MODE=true`. This does **not** set or claim `LEMO_LICENSE_APPROVED=true`. Keep the application owner-authenticated and the exact pinned STYLE files private. Do not bundle them in a public repository, a container image, or the public asset archive. All security, audio, synchronization and cost release gates still apply.

Provision the pinned files through a private `LEMO_PRIVATE_LIBRARY` mount or `LEMO_PRIVATE_STYLES_JSON` on the trusted coordinator. The latter is a JSON object keyed by the three installed style IDs, with their exact STYLE.md contents as values. Each file must match the SHA-256 in `upstream.lock.json`. Neither document contents nor this environment value go to the renderer, public metadata, or API responses.

The `cloudbath-original-v1` option uses original directions and the MIT helper only. The `upstream-licensed` option remains gated by a separate commercial permission for a broader service. Reassess the licence scope before opening this Studio to unrelated users or selling/distributing the documentation.

The earlier development audit assumed a public commercial service and therefore applied a broader restriction than this clarified owner workflow. Social posting and monetization of the resulting films do not, by themselves, require that broader licence. Third-party assets retain their own terms.

Source: [Lemo LICENSE at the pinned commit](https://github.com/lemomo-ai/lemo-opuscar/blob/3a7132b996be0241c1ea0ab180d519f06e6f10b6/LICENSE).
