# Test plan

## Automated checks

```bash
npm install
npm run check
```

The offline scheduler suite covers capability rejection on stock hosts, whole-batch validation and exact checkpoint matching, runtime-owned continuation with queued notifications, canonical ledger handoff, duplicate/stale callbacks, manual pause/recovery, failure policy, cancellation and real extension loading. Run the current suite instead of relying on a historical test count.

## Runtime boundary regression (required)

Scheduler mocks cannot prove atomicity. In the matching Pi source tree, use a faux provider and a gated `session_before_compact` hook:

1. Model emits a checkpoint tool and a deliberately delayed sibling tool.
2. Confirm compaction cannot start until both results are persisted.
3. Hold the compaction backend open, complete independent background work and enqueue its notification.
4. Confirm no new parent provider call, abort assistant or artificial `agent_settled` occurs while compaction is blocked.
5. Release the backend; assert the first provider input contains replacement history plus exactly one canonical ledger, and the notification is retained.
6. Repeat with failure, real abort, session replacement, manual pause and explicit resume. Assert no hidden retry/duplicate continuation or stale checkpoint installation.

Use only deterministic local/faux providers for this regression. Live providers are a separate opt-in smoke test, not a prerequisite for offline tests.

## Live Pi smoke test

Use a host implementing `requestCompaction`, a project-local scheduler install, and a supported OpenAI model. Restart the runtime after installing core changes. Stock Pi 1.0.0 must reject the tool without entering the aborting manual path.

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
- the next phase receives one hidden canonical checkpoint before any resumed model call;
- a background subagent remains running during compaction and its eventual notification is delivered;
- there is no synthetic aborted assistant and no competing parent continuation;
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

While the model is about to call `compact_context`, send a real steering message before the next turn boundary.

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

## Built-package smoke details

Test the packed host outside its source tree, not only source aliases. For a credential-free SDK fixture, use temporary `authPath`/`modelsPath`, disable model networking, and use the faux provider. Explicitly activate `compact_context`: `tools: []` excludes extension tools too. Bind extensions with `session.bindExtensions({})`. A gated fake compaction backend lets the test assert that background work completes while the parent is blocked, then verify the persisted checkpoint and notification after release. Preserve installed native-backend fixes while overlaying scheduler changes; run that installation's complete suite against the candidate host.
