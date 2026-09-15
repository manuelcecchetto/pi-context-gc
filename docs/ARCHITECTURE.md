# Architecture

## Ownership boundaries

`pi-context-gc` intentionally does not implement a compactor.

| Layer | Owner | Responsibility |
|---|---|---|
| Semantic phase decision | model via `compact_context` | Decide that the previous working set is dead and emit a bounded task/search/completion checkpoint |
| Safe scheduling | this extension | Wait for a complete tool batch, trigger once, guard session/race state, and resume |
| Compaction lifecycle | Pi | Abort the active run, prepare branch history, dispatch hooks, persist compaction, rebuild agent context |
| Native representation | OpenAI backend | Produce and replay the opaque encrypted compaction item |
| Safety fallback | Pi + backend | Keep threshold/overflow triggers and Pi text compaction available |

Core invariant:

```text
scheduler owns WHEN
backend owns HOW
Pi owns persistence and hard safety
```

## Pi lifecycle finding

Pi's low-level `agent.prompt()` owns repeated model/tool rounds. In the current coding-agent path, normal threshold/overflow checks are reached in post-run/pre-prompt handling rather than after every tool batch.

Extensions receive a `context` event before every provider call. The scheduler uses that event as the nearest public mid-run boundary.

## State machine

```text
IDLE
  | compact_context tool
  v
PENDING
  | context/idle boundary contains complete batch with exact toolCallId
  v
COMPACTING
  | onComplete                         | onError
  v                                    v
RESUME_PENDING                         FAILED
  | autoResume + idle                  | /retry -> COMPACTING
  |                                    | /resume -> continuation
  | /resume when autoResume=false      | /cancel -> IDLE
  v
IDLE + hidden continuation
```

A generation counter invalidates stale callbacks after cancellation, session replacement, or shutdown.

## Why the tool cannot call `ctx.compact()` directly

Pi manual compaction begins by aborting the current agent operation. Starting it inside custom-tool execution can race with persistence of that result and sibling results.

The tool therefore records intent and returns normally. The next `context` event verifies:

- the tail ends in tool-result messages;
- one assistant tool-call message directly precedes them;
- every call ID has exactly one finalized result;
- no result ID is duplicated;
- the exact `compact_context` call ID is present.

Only then is `ctx.compact({ force: true })` invoked. `force` is a compatibility hint for hosts that implement forced preparation. Stock Pi 0.84.2 ignores it and retains its normal eligibility gate; this package does not patch Pi. Automatic, overflow, and interactive `/compact` behavior remains unchanged.

An `agent_settled` fallback exists for an unusual early termination, but it applies the same validation against persisted `buildContextEntries()` data. It never bypasses the complete-batch invariant.

## Native backend composition

The package manifest loads the bundled `@lll9p/pi-better-compaction` extension before this scheduler. On supported Responses-family APIs, the backend intercepts `session_before_compact`, calls `/responses/compact`, stores the opaque window in the Pi compaction entry, and rewrites later provider requests to replay it. For ChatGPT-authenticated Codex, where the standalone compact route returns 404, the bundled backend uses Codex remote-compaction v2 by appending `compaction_trigger` to the regular Responses stream with `store: false`.

If native handling fails, the backend yields to Pi's normal text compaction. Since manual, threshold, and overflow compaction all enter Pi's standard lifecycle, they share the backend.

This is the best deployable route for current Pi 0.84.x, but it is not identical to Codex's current internal remote-compaction-v2 rollover.

## Bounded checkpoint

Required:

- `completed_phase` — max 2,000 characters;
- `next_focus` — max 2,000 characters;
- `keep` — 1–16 items, max 1,000 characters each;
- `verification` — 1–12 items, max 1,000 characters each.

Optional:

- `open_loops` — up to 12 items;
- `ruled_out` — up to 12 items.

The bounds prevent the checkpoint from becoming another transcript. `verification` is mandatory so a phase boundary carries evidence of completion.

## Compaction guidance

The extension passes concise `customInstructions` to Pi. They preserve:

- user intent and acceptance criteria;
- decisions, invariants, edits, identifiers and paths;
- unresolved dependencies;
- negative search state;
- verification state.

They mark raw logs, repeated reads, superseded snapshots and completed exploration as disposable unless needed to support retained state. They are a handoff contract, not a replacement summary.

## Resume path

Manual Pi compaction does not continue the interrupted run. On success, the extension waits one event-loop turn and checks:

- generation, session ID and checkpoint ID still match;
- Pi is idle;
- no queued continuation already exists.

It then injects one hidden custom message with `triggerTurn: true`. The message materializes the canonical task/search/completion ledger; the opaque provider item carries broader latent continuity.

If `autoResume=false`, state remains `RESUME_PENDING` until `/context-gc resume` or `/context-gc cancel`.

If another turn already owns continuation, the extension records that fact and does not create a duplicate turn.

## Persistence

Three artifacts are distinct:

1. normal tool call/result — participates in the pre-compaction conversation;
2. Pi compaction entry — authoritative replacement state, including native opaque details when supported;
3. custom checkpoint entries — diagnostic state outside model context.

The hidden resume message participates in model context and is persisted as a custom message.

## Failure semantics

- native backend failure may fall through to Pi text compaction;
- total compaction failure sets `FAILED` and does not auto-resume by default;
- `/context-gc retry` reruns compaction from current persisted history;
- `/context-gc resume` continues from the full checkpoint without another compaction;
- `/context-gc cancel` drops scheduler state;
- a new real input before compaction cancels pending semantic assumptions.

## Current limitation and ideal core change

`ctx.compact()` is an abort/manual-compact/resume shim. Codex can perform replacement-history installation inline within its sampling loop.

The ideal Pi core primitive would be approximately:

```text
compactInline({ instructions })
  -> atomically install replacement history
  -> continue current low-level run
```

The `compact_context` tool, checkpoint schema, and scheduling policy could remain unchanged when such an API exists.
