# Test plan

## Automated checks

```bash
npm install
npm run check
```

The current suite contains 17 tests covering:

1. extension/tool/command registration;
2. sequential execution declaration;
3. real-user-input cancellation;
4. `agent_settled` fallback with the same persisted complete-batch invariant;
5. complete and incomplete parallel tool batches;
6. duplicate, missing and unrelated tool result IDs;
7. exact checkpoint tool-call matching;
8. task/search/completion guidance content;
9. exactly-once resume after successful compaction;
10. full canonical ledger in the resume message;
11. no duplicate turn when Pi is not idle;
12. pending-message continuation ownership;
13. `autoResume=false` leaving a resumable `resume-pending` state;
14. failure pause and explicit full-ledger recovery;
15. stale-session callback rejection;
16. compact callback idempotence;
17. checkpoint scheduling busy rejection.

## Validation performed for this artifact

On 2026-08-20:

- strict TypeScript typecheck passed against a local compatibility surface modeled on Pi 0.84.2 APIs;
- build passed;
- all 17 unit tests passed;
- the source package file list was inspected; a final npm tarball with the real bundled backend was not built because registry access was unavailable.

A live Pi/OpenAI request was not executed in the build environment because npm registry/network access and user credentials were unavailable. The live smoke test below is therefore still required before treating the package as production-ready.

## Live Pi smoke test

Use a project-local install and a supported OpenAI model.

```bash
cd /absolute/path/to/pi-context-gc
npm install
pi install -l "$PWD"
pi --model openai-codex/<supported-model>
```

Run a task with at least two distinct phases:

1. inspect and repair one subsystem;
2. satisfy explicit tests/acceptance criteria;
3. transition to a separate subsystem;
4. let the agent call `compact_context` at the boundary.

Expected observations:

- `compact_context` is visible to the model;
- the tool includes non-empty `verification` evidence;
- compaction starts only after every result in the batch exists;
- a Pi compaction entry is appended;
- native details contain the backend strategy/opaque compacted window on supported APIs;
- a session below the configured `keepRecentTokens` budget still reaches native compaction through the forced extension request;
- ChatGPT-authenticated Codex uses the regular Responses stream with `compaction_trigger` when the standalone compact route returns 404;
- the next phase receives one hidden canonical checkpoint;
- prior raw exploration is not repeated without new evidence;
- exact current file details are re-read only when needed.

## Overflow regression

Prevent agentic use of `compact_context`, then generate enough tool traffic to cross Pi's normal threshold. Confirm Pi still auto-compacts.

In a disposable session, use a low threshold/reserve or force an overflow. Confirm Pi's existing compact-and-retry path still runs. This package never disables or rewrites those settings.

## Native-backend failure

Use a Responses-compatible endpoint without `/responses/compact`, or temporarily remove native-compaction credentials.

Expected:

- backend falls through to Pi text compaction where possible;
- if every compaction path fails, scheduler enters `FAILED`;
- no automatic continuation occurs unless `resumeOnFailure=true`;
- `/context-gc resume` reinjects the complete task/search/completion ledger.

## User steer race

While the model is about to call `compact_context`, send a real steering message before the next context boundary.

Expected: pending semantic GC is cancelled because the relevance graph changed.

## Parallel batch race

Have the model call `compact_context` with two deliberately slow sibling tools.

Expected: despite the prompt discouraging this pattern, compaction does not start until all call IDs have exactly one finalized result.

## Long-session recovery

Test:

- `/reload` after successful resume;
- reopening the session after native compaction;
- switching model/provider after native compaction;
- branching before and after a checkpoint.

The opaque backend and Pi session reconstruction must remain authoritative. Any crash between compaction completion and hidden resume should be treated as a recoverability test, not assumed safe without observation.

## Quality benchmark

Compare identical long tasks under:

1. Pi default threshold-only compaction;
2. semantic phase-boundary compaction plus normal fallback;
3. full context/no compaction where feasible.

Measure:

- task success and regression rate;
- repeated reads, tests and hypotheses;
- context tokens per provider call;
- compaction latency and output usage;
- TTFT, wall-clock and total cost;
- scope creep and overengineering;
- tool calls after acceptance criteria are met;
- recall of decisions, invariants, open loops, ruled-out paths and verification state.

Fewer tokens alone are not success. The central hypothesis is improved live-context quality without loss of task state.
