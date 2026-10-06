# Architecture

## Ownership

- The model chooses the semantic boundary and provides a bounded checkpoint.
- The scheduler validates the complete persisted tool batch at `turn_end` and requests compaction once.
- Pi owns the atomic pre-provider boundary, normal compaction backend, history installation, canonical message persistence and continuation.
- Native/backend extensions own how the summary or opaque representation is produced. Threshold and overflow safeguards remain intact.

`ctx.requestCompaction` is an explicit host capability, not an alias for `ctx.compact`. Stock Pi 1.0.0 lacks it; unsupported hosts reject the tool before scheduling. See COMPATIBILITY.md.

## Lifecycle

```text
IDLE -> PENDING (tool returns normally)
     -> COMPACTING (turn_end validates every result and exact checkpoint ID)
     -> host pre-provider boundary, standard backend, history + ledger persisted
     -> IDLE (host continues current parent run)
     or RESUME_PENDING (autoResume=false; explicit /resume)
     or FAILED (default failure policy; /retry, /resume or /cancel)
```

The scheduler passes the complete hidden `pi-context-gc-resume` custom message with the request. Runtime callbacks update diagnostic state only; they do not schedule model turns. Generation, session ID, checkpoint ID and phase guards reject stale/duplicate callbacks. New user input cancels an unconsumed request. Shutdown invalidates callbacks and cancels queued intent.

## Background subagents

The parent remains active while Pi awaits compaction. Independent workers continue; this boundary never waits for their completion or cancels them. Their notifications queue normally. No artificial `agent_settled` event is emitted to hand off compaction, so notifications cannot overtake it and launch a second parent run.

A configured pause or failure stops the current loop before another provider call. Messages already selected from a queue are persisted normally; messages arriving during compaction remain queued. This is not a global session lock: later independent user input or extension notifications may start a new run using the already-persisted checkpoint. The runtime contract, not a scheduler-side `isIdle()` check, owns this ordering.

## Why not `context` or manual compaction?

The former `context -> ctx.compact -> abort -> settled -> resume` path was racy. A settled listener could flush a subagent notification, starting a complete parent run while manual compaction still awaited idle. It also surfaced the intentional abort as a model error. Checking queues one event-loop tick later could suppress the canonical ledger without preventing the competing run.

`context` is also too late for a request consumed by the pre-provider preparation hook. `turn_end` supplies the completed assistant/tool-result batch after persistence and before that hook. No idle/settled fallback or legacy abort path is retained.

## Persistence and recovery

The tool call/result remains in the audit history. Pi's compaction entry defines replacement context. The hidden canonical checkpoint participates in model context, while diagnostic checkpoint entries do not. Pi must persist the canonical message before invoking completion callbacks and before any next model call, even when automatic continuation is disabled.

Manual recovery injects the full checkpoint, not only `next_focus`. Recovery text never asserts that failed compaction succeeded. `/retry` requests the same standard host pipeline from idle; `/cancel` clears scheduler state and, when still pending, cancels the host intent.

## Backend and data bounds

The bundled MIT `pi-better-compaction` backend remains unchanged: Responses native compaction, documented Codex remote-compaction fallback, then Pi text fallback. The scheduler never handles provider credentials or implements another summarizer.

Checkpoint bounds: completed phase/next focus up to 2,000 characters; 1–16 durable items; 1–12 verification items; up to 12 open loops and ruled-out paths; list items up to 1,000 characters. These are handoff facts, never raw logs or whole files.
