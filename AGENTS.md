# AGENTS.md

## Purpose

This package adds agent-triggered semantic context garbage collection to Pi without replacing Pi's normal threshold or overflow safeguards.

## Invariants

- The scheduler owns **when** compaction is requested; the installed `session_before_compact` backend owns **how** it is performed.
- Never prune or rewrite conversation messages directly.
- Never start compaction before the complete assistant/tool-result batch containing `compact_context` is present.
- Never automatically resume twice. The host owns continuation; callbacks only observe. Guard callbacks by generation, session ID, and checkpoint ID.
- Require `requestCompaction` at `turn_end`; never use the aborting manual-compaction or settled fallback path.
- Background subagents keep running; their queued notifications must not suppress the canonical ledger.
- A real user input invalidates a pending semantic checkpoint.
- Total compaction failure pauses by default; it must not create a retry loop.
- Preserve task, decision, search, and verification ledgers across the boundary.

## Validation

Run `npm run check`. Live changes also require the scenarios in `docs/TESTPLAN.md`.

## Key docs

- `docs/BRIEF-IT.md` — product and research brief
- `docs/ARCHITECTURE.md` — lifecycle and state machine
- `docs/ENGINEERING.md` — implementation rules
- `docs/TESTPLAN.md` — offline and live validation
