# Engineering guide

## Invariants

- Never mutate/prune conversation messages or implement a second summarizer in the scheduler.
- Preserve Pi threshold/overflow safety and the standard `session_before_compact` pipeline.
- Validate the complete assistant/tool-result batch and exact checkpoint call at `turn_end`.
- Require `ctx.requestCompaction`; never fall back to aborting `ctx.compact`.
- The host owns history replacement, canonical ledger persistence and continuation.
- Never send an automatic resume message from completion/error callbacks.
- Background subagents must neither be cancelled nor awaited by parent compaction.
- Preserve canonical task/search/verification state even with pending notifications.
- Guard callbacks by generation, session ID, checkpoint ID and phase.

## Verified race and regression guidance

Manual compaction awaiting `abort()/waitForIdle()` is not an atomic ownership transfer. `agent_settled` listeners can schedule another prompt before idle resolves. Therefore a `setImmediate` plus `isIdle`/queue check cannot enforce exactly-once continuation and can drop the canonical checkpoint.

Test this at the runtime boundary with a gated compaction backend and a background completion arriving while the gate is closed. Assert no provider call uses old context, no artificial abort/settle, checkpoint persistence precedes continuation, and one notification remains deliverable. Mock scheduler tests alone cannot establish these properties.

## Host contract

`src/host.ts` declares the unreleased structural capability while package tests also verify loading through published Pi. `hasBoundaryCompaction` gates tool acceptance. Keep this contract aligned with Pi's public API; once published, import its types directly. A version range alone does not prove the capability exists.

`requestCompaction` accepts instructions, forced preparation, the hidden canonical custom message, automatic continuation/failure policy, and completion/error observers. It returns `{ accepted, cancel }`. Rejected requests stay recoverable and never invoke manual compaction. Cancellation removes unconsumed intent or aborts its in-flight compaction, not the parent. A settled request cannot be cancelled.

## Verification

Run `npm run check` for extension typechecking, build and offline tests. Runtime integration tests must use faux providers, never paid model calls. Keep source and installed artifacts distinct: do not claim a live fix until both runtime and scheduler have been installed and a new process started. Runtime updates are not activated by extension `/reload`.

## Recovery and privacy

Default failure pauses without a retry loop. `/retry`, `/resume`, `/cancel` are explicit recovery controls. `autoResume=false` keeps a resumable checkpoint. `resumeOnFailure=true` delegates continuation to the host, not another scheduler prompt. All ledgers are status-neutral or explicitly indicate recovery without successful compaction.

The scheduler never handles credentials. Checkpoints must omit secrets, private payloads, full files and unbounded logs. Backend fallback and privacy limitations remain documented in COMPATIBILITY.md.

## New user intent is not cancellation acknowledgement

A host request's `cancel():false` means it has already been consumed; it does not validate an obsolete scheduler checkpoint. Real user input invalidates scheduler generations before attempting host cancellation, including failed and manually paused checkpoints. Late host callbacks must not resurrect the old task or block future semantic checkpoints. Extension notifications do not invalidate task intent. Regression tests cover cancellation-too-late and failed/paused task replacement.
