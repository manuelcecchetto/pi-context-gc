# Changelog

## 0.1.1

- Vendor the locally patched native backend so Git installs preserve the Codex fallback.
- Document the optional host force hint and remove unsupported portability claims.
- Add public installation instructions and a bounded observational example.


## Unreleased

- Require Pi's explicit `requestCompaction` host capability; reject unsupported hosts without an abort/resume fallback.
- Request compaction at `turn_end`, preserving whole batches and delegating atomic history/ledger installation and single continuation to Pi.
- Keep background subagents independent and retain canonical checkpoints with queued notifications.
- Remove event-loop-delayed automatic resumes; add cancellation, stale-callback, host-refusal and recovery-ledger regressions.

- Force explicit semantic compaction past Pi's `keepRecentTokens` eligibility gate without changing automatic or overflow retention behavior.
- Fall back to Codex remote-compaction v2 when the ChatGPT standalone compact endpoint returns 404.
- Preserve automatic checkpoint resume after native compaction.

## 0.1.0

- Add agent-callable `compact_context` semantic phase-boundary tool.
- Require concrete completion/verification evidence in every checkpoint.
- Bound task, search and completion ledgers to prevent checkpoint bloat.
- Defer compaction until the full trailing tool-result batch is persisted.
- Apply the same complete-batch invariant at the idle fallback boundary.
- Delegate compaction to Pi's standard lifecycle, preserving threshold and overflow safeguards.
- Bundle `@lll9p/pi-better-compaction` for OpenAI-native opaque Responses compaction with fail-open fallback.
- Persist task/search checkpoints outside model context for diagnostics.
- Add guarded automatic resume, resumable `autoResume=false` behavior, failure recovery commands and user-steer cancellation.
- Reinject the complete canonical ledger on every continuation path.
- Add 17 offline tests and a live/quality benchmark plan.
