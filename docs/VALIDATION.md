# Validation record

Publication review: 2026-09-15.

## Passed

- Fresh installation from the npm registry with lifecycle scripts disabled (235 packages; npm reported zero known vulnerabilities).
- Strict TypeScript typecheck and JavaScript build against real Pi 0.84.2 dependencies.
- 18/18 offline tests, including complete-batch races, exactly-once continuation, stale-session/failure handling, and loading both published entrypoints through Pi's real extension loader.
- Reinstalled the generated tarball in a separate directory and passed all 18 checks there.
- npm tarball inspection: the patched native backend is included; credentials, runtime settings, raw sessions, node_modules, and local audit artifacts are excluded.
- Source review for machine-specific paths, private task content, credentials, local-only dependencies, and third-party attribution.

## Findings addressed

- Vendored the MIT backend patch previously hidden in node_modules, so fresh installations preserve it.
- Replaced the unsupported guarantee about forced preparation with an explicit stock-host limitation.
- Replaced an old stub-only validation claim with the checks above.
- Included only an aggregate illustrative chart, not raw task transcripts.

## Limits

The September task logs provide observational evidence of live use, but this publication pass did not send fresh provider requests or rerun the live-provider/overflow scenarios in TESTPLAN.md. The package does not guarantee support for undocumented provider endpoints, lossless summaries, behavior parity across models, or cost savings. See COMPATIBILITY.md and OBSERVATION.md.
