# Validation record

## Unreleased boundary migration

- `npm run check`: strict typecheck, build and 31/31 offline tests pass against published Pi 1.0.0.
- Both package entrypoints load through the real Pi extension loader; unsupported hosts reject semantic compaction explicitly.
- New regressions were first observed failing for unsupported-host acceptance and false success wording in failure recovery, then passed after the migration.
- `git diff --check` passes.
- Feature-branch distribution includes the companion runtime patch and upstream MIT notice. `npm pack --dry-run --ignore-scripts` includes all three patch assets; applying the patch to the exact v1.0.0 base reproduces all 16 reviewed runtime files byte-for-byte. The patch checksum matches the installed build provenance.
- Matching Pi v1.0.0 source worktree (`fix/semantic-boundary-compaction`): 95 tests pass across `agent-session-boundaries`, `agent-session-compaction` (suite), `agent-session-auto-compaction-queue` and `agent-session-queue`; 37 low-level `agent-loop` tests pass. All use local/faux providers.
- Focused review found and then verified fixes for already-dequeued message loss, ignored forced preparation, cancellation observers, idle/shortcut support, cancellation after persistence hooks, and intents stranded by provider errors.
- Core `npm run check` passes formatting, dependency/import/entry-graph and lockfile checks, then fails at the unchanged `packages/ai/test/together-models.test.ts:61`: hydrated model metadata lacks the test's pinned `deepseek-ai/DeepSeek-V4-Pro`. No tests or model definitions were weakened to conceal this; later browser-smoke checks were not reached.
- The paired runtime/scheduler was subsequently built and installed locally; see the activation record below. No live provider request was exercised.
- `npm audit` reports one high-severity transitive **development** dependency finding under Pi 1.0.0 (`brace-expansion`, GHSA-qhr7-859c-m2p7 and related DoS advisories). No broad dependency auto-fix was applied as part of this lifecycle change.

## Local activation: 2026-10-06

- Rebuilt Pi v1.0.0 from `fix/semantic-boundary-compaction` with `npm run build:offline`; packed both changed packages (`pi-agent-core` and `pi-coding-agent`) and tested an isolated nested-dependency installation outside the repository.
- Replaced the existing global installation, not the CLI path or Pi settings. CLI and unbundled SDK startup checks pass; the CLI/RPC bundle exposes `AgentSession.requestCompaction`.
- Updated only scheduler source/tests and lifecycle documentation in the existing local extension. Preserved the separately maintained native backend `0.7.2-pi1.0.1`, its manifest, dependencies, and vendor sources byte-for-byte.
- Paired installed scheduler/backend: strict typechecks and **72/72 offline tests pass**, including the actual installed-host loader.
- Installed SDK + actual scheduler smoke passes with networking disabled: full tool batch, independent background completion during blocked compaction, queued follow-up delivered, one canonical checkpoint, and no synthetic aborted/error assistant.
- Current processes are not hot-upgraded. A new chat starts a fresh Pi RPC process; restarting/reopening a running chat is needed to use the new runtime there. `/reload` alone cannot replace core code.
- Rollback metadata and previous runtime/scheduler files are retained under `~/.pi/backups/semantic-compaction-20261006T031036Z`. The installed runtime and scheduler have `semantic-local-build.json` provenance markers.
- No live native-provider request was made. The earlier full-repository Together model-catalog type-check limitation remains; the offline package build and focused tests pass.

## Historical publication review: 2026-09-15


### Passed

- Fresh installation from the npm registry with lifecycle scripts disabled (235 packages; npm reported zero known vulnerabilities).
- Strict TypeScript typecheck and JavaScript build against real Pi 0.84.2 dependencies.
- 18/18 offline tests, including complete-batch races, exactly-once continuation, stale-session/failure handling, and loading both published entrypoints through Pi's real extension loader.
- Reinstalled the generated tarball in a separate directory and passed all 18 checks there.
- npm tarball inspection: the patched native backend is included; credentials, runtime settings, raw sessions, node_modules, and local audit artifacts are excluded.
- Source review for machine-specific paths, private task content, credentials, local-only dependencies, and third-party attribution.

### Findings addressed

- Vendored the MIT backend patch previously hidden in node_modules, so fresh installations preserve it.
- Replaced the unsupported guarantee about forced preparation with an explicit stock-host limitation.
- Replaced an old stub-only validation claim with the checks above.
- Included only an aggregate illustrative chart, not raw task transcripts.

### Limits

The September task logs provide observational evidence of live use, but this publication pass did not send fresh provider requests or rerun the live-provider/overflow scenarios in TESTPLAN.md. The package does not guarantee support for undocumented provider endpoints, lossless summaries, behavior parity across models, or cost savings. See COMPATIBILITY.md and OBSERVATION.md.
