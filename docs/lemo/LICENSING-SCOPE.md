# Permission for the owner's private film workflow

The owner clarified on 2026-11-13 that this Studio makes their own social videos, rather than offering a style-library service to unrelated customers.

The pinned upstream LICENSE explicitly says: "Films you make with the library are yours, commercial films included, and need no credit". Its ADDITIONAL PERMISSION FOR THE DOCS permits the owner and people working with them on a film (staff, contractors and client) to read, follow, copy and adapt the documentation to make their own films, including commercial and client films.

That additional permission covers this private film workflow. Social posting and monetizing the resulting films do not, by themselves, require the separate commercial-service licence. Third-party assets retain their own terms. Selling or distributing the style documentation, or using it in a broader commercial service beyond that grant, needs a separate review.

The owner-film configuration implemented and tested in the interrupted working copy uses LEMO_STYLE_LIBRARY=owner-films, LEMO_FILM_USE_APPROVED=true and LEMO_PRIVATE_OWNER_MODE=true. It does not claim LEMO_LICENSE_APPROVED=true. That permission patch is not yet fully committed: recover the working copy and finish it before enabling the feature. Keep exact pinned STYLE files private on the trusted coordinator, never in the public repository or generated-code container. All runtime and production checks still apply.

The earlier audit assumed a public commercial service and applied a broader restriction than this clarified owner workflow.

Source: https://github.com/lemomo-ai/lemo-opuscar/blob/3a7132b996be0241c1ea0ab180d519f06e6f10b6/LICENSE
