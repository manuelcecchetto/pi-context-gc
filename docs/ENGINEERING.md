# Engineering guide

## Non-negotiable invariants

- Never prune, mutate, or drop conversation messages directly.
- Never implement a second textual summarizer in the scheduler.
- Never disable Pi threshold/overflow compaction.
- Never compact before the complete assistant/tool-result batch is present.
- Never auto-resume twice.
- Never let a stale session callback modify the active session.
- Preserve task, decision, negative-search, completion, and open-loop state.

## Boundary model

`compact_context` is an intent-recording tool. It must return normally so Pi can persist its result and any sibling result.

The preferred execution boundary is the next `context` event. An idle fallback may use persisted `buildContextEntries()`, but must pass the same complete-batch validator.

## Runtime state

```text
IDLE -> PENDING -> COMPACTING -> RESUME_PENDING -> IDLE
                    |                 |
                    v                 v
                  FAILED <------------
```

Every asynchronous callback is guarded by:

- runtime generation;
- active session ID;
- checkpoint ID;
- expected phase.

## Continuation

After successful compaction:

1. defer one event-loop turn;
2. check `ctx.isIdle()`;
3. check `ctx.hasPendingMessages()`;
4. if another turn owns continuation, do not create a second one;
5. otherwise send one hidden custom checkpoint with `triggerTurn: true`.

When `autoResume=false`, leave state at `resume-pending` so the operator can use `/context-gc resume`.

All resume paths must use the full canonical ledger. A failure recovery must never degrade to `next_focus` alone.

## Failure policy

Native backend failures may fail open to Pi's text compactor. If the complete Pi operation fails, leave the scheduler in `FAILED`. Do not retry automatically unless explicitly configured.

Recovery commands:

- `/context-gc retry`
- `/context-gc resume`
- `/context-gc cancel`

## Provider separation

Scheduler code never calls OpenAI and never handles credentials. It requests `ctx.compact({ force: true })` so Pi does not block the explicit semantic request on its text-compaction retention budget; the backend still owns native execution and fallback. The package manifest loads a bundled `session_before_compact` backend before the scheduler. `scheduler-only.ts` is available when a different backend already owns that hook.

## Data minimization

Do not put full files, logs, secrets, stack traces, or generated artifacts into the checkpoint. Use exact paths, symbols, concise decisions, failure reasons, verified facts, and acceptance evidence.

The schema bounds are part of the architecture, not cosmetic validation.

## Compatibility

Target:

- Pi `>=0.84.0`;
- Node `>=22.19.0`;
- OpenAI Responses or Codex Responses for native opaque compaction.

Other providers remain usable through Pi's normal compaction fallback.
