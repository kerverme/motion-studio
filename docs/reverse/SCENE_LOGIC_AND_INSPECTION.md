# Scene Logic Director and Video Quality Inspector

The director reviews causal meaning before rendering. The inspector compares
an actual generated shot against that plan afterward. Both use the configured
OpenAI vision/text model (currently `gpt-6.1-sol`) through the existing priced
quote, owner approval, durable request ledger and encrypted storage. Neither
page loads nor prompt copying start paid inference.

The model-specific prompt compiler remains deterministic. A GPT director
supplies a structured event graph; it does not replace the compiler with an
uncontrolled paraphrasing call.

## Evidence and story changes

Events refer to measured shots and the original timed action indices. They
retain actor and object IDs, accidental/deliberate/collision/reaction meaning,
dependencies, spatial observations, visibility and uncertainty. Every source
action must remain represented. Source observations, model inferences and
owner-authorized creative overrides have separate provenance.

Approximate gaze and field-of-view descriptions are hypotheses, not a physics
simulation. Cited frame timestamps must exist in the prepared evidence.
Insufficient temporal evidence cannot establish a collision, fall or event
ordering. Confidence is a model estimate, not a calibrated probability.

The six UI checks are Story Consistency, Cause & Effect, Character Awareness,
Object Continuity, Shot Continuity and Source Fidelity. Critical contradictions
block checked generation; uncertain issues remain warnings. Proposed changes
never silently overwrite source actions. Owner-approved changes form a new
review revision and require revalidation before rendering. Source Prompt A,
its measured timing and prior saved versions remain immutable.

Scene checks are bound to the exact saved prompt version, effective main
character/location replacements, selected protagonist and source hash. A
different B must be checked again. Internal generation quote, approval and
worker dispatch enforce the graph binding; a graph from a different scene
cannot authorize a request. For internal generation, select a complete measured
shot, use its current model-specific Prompt B in the advanced production prompt
field, and keep the same model. Copying a legacy unchecked prompt remains visibly
unchecked. The app cannot enforce its gates on a user manually submitting text
directly to an external fal page.

## Inspecting generated results

Existing generated assets can be inspected. A result made on fal outside the
app can be uploaded as a separate generated candidate (MP4, WebM or MOV, up to
64 MiB). Upload requires owner authentication and explicit rights confirmation,
binds to one graph shot and uses existing checksum-verified encrypted storage.
Known source and preview hashes cannot be relabelled as generated candidates.
Internal generated assets must match the graph and review approved for their
generation. Older output can be explicitly uploaded as a candidate for comparison
against a newer graph; it is then labelled owner-provided output.
An uploaded file is owner-provided output, not verified proof of fal provenance.

Free local preparation validates the actual media and samples ordered frames
around expected events. Only then can the owner request and approve an
inspection quote. Findings cite generated frame timestamps and distinguish
Passed, Failed and Uncertain. Still-image plausibility is insufficient evidence
of temporal correctness. Missing coverage, occlusion and ambiguous events must
remain uncertain. Reports bind to the exact output hash and event-graph revision.

Confirmed critical failures recommend targeted shot regeneration. No inspection
automatically submits a new fal generation or spends an additional budget.

## Validation limits

Automated tests use explicit model fixtures and real local media processing.
They verify causal graph contracts, source immutability, evidence/timing gates,
quote/approval isolation, upload boundaries, UI state and retry behavior. They
do not demonstrate that the model reliably detects every narrative mistake.
Paid semantic evaluation and video generation require a separately approved
run. The feature does not promise perfect physical simulation or reproduction.

## Incomplete provider output

Director and Inspector quotes allow up to 32,000 output tokens, including model
reasoning, and ask for concise evidence descriptions. The full allowance is
included in the quoted estimate and requires owner approval. A truncated response
is retained for accounting but cannot become a validated graph or inspection.
The error distinguishes output exhaustion, refusal and malformed JSON. The owner
can request a fresh quote with the updated payload; old approved limits are never
increased in place and failed cached results never trigger automatic paid retries.
