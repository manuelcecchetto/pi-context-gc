# pi-context-gc

Agent-triggered semantic context garbage collection for Pi.

`pi-context-gc` gives the model `compact_context` for declaring a coherent phase complete. It records a bounded checkpoint, waits for the complete tool-result batch, and asks Pi to compact **between model turns without aborting the parent**. Background subagents keep running. Pi persists the canonical ledger before continuing the same parent run.

**This unreleased scheduler requires a Pi host implementing `ctx.requestCompaction`. Stock Pi 1.0.0 does not implement it.** Unsupported hosts reject the tool request rather than silently using the old abort/resume path. Updating this extension alone is not enough. The [companion runtime patch](patches/README.md) is included; see [compatibility and local changes](docs/COMPATIBILITY.md).

The package manifest loads the vendored `@lll9p/pi-better-compaction` 0.2.1 with a documented local patch extension before the semantic scheduler. Supported OpenAI Responses models therefore use `/responses/compact`; ChatGPT-authenticated Codex models fall back from the unavailable standalone route to Codex remote-compaction v2 (`compaction_trigger` on the regular Responses stream). Both paths persist opaque compacted state. If native handling cannot run, the backend fails open to Pi's normal text compaction. Pi's existing threshold and context-overflow compaction remain untouched, including their configured `keepRecentTokens` behavior.

## One observed run

![Context and estimated cost by active model](https://raw.githubusercontent.com/manuelcecchetto/pi-context-gc/main/assets/model-compaction.png)

In one sequential task, Astra called `compact_context` 50 times; Terra and Luna called it zero times. All had the same model-agnostic compaction tool available. This is an observation, not a controlled model benchmark. The backend also differed across phases. [Method and limitations](docs/OBSERVATION.md).

## Design

```text
long Pi agent run
  model -> read/bash/edit/test -> model -> ...
                    |
                    | model decides a coherent phase is complete
                    v
             compact_context(...)
                    |
        complete tool batch is persisted
                    |
        Pi `turn_end` request boundary
                    |
         ctx.requestCompaction()
                    |
       pre-provider compaction boundary
                    |
       session_before_compact lifecycle
          /                         \
 OpenAI opaque compact       Pi default fallback
          \                         /
            replacement history
                    |
 hidden task/search/completion checkpoint
                    v
              next agent phase
```

```text
scheduler owns WHEN
backend owns HOW
Pi owns persistence, threshold and overflow safety
```

## What it is

- **semantic scheduling:** the active model chooses a real phase boundary;
- **provider-native state:** OpenAI owns the opaque compacted representation;
- **task-scoped context:** decisions, invariants, open loops, ruled-out paths and completion evidence survive;
- **additive safety:** Pi's normal threshold/overflow route is not replaced;
- **completion pressure:** `verification` is required so compaction also records why the phase is done.

## What it is not

- a deterministic task-change classifier;
- a token threshold replacing Pi's threshold;
- a `context` hook that silently deletes messages;
- another textual summarizer;
- exact parity with Codex's internal inline remote-compaction-v2 path;
- a guarantee that native compaction is lossless or always produces 10–20k tokens.

## Requirements

- Node `>=22.19.0`
- Pi `@earendil-works/pi-coding-agent >=1.0.0` **with `ctx.requestCompaction` support** (unreleased host change)
- a working OpenAI Responses/Codex model for opaque native compaction

Other providers can still use Pi's normal compaction fallback.

## Try this feature branch

This branch is not a stock-Pi-compatible release. First build/install the [companion runtime change](patches/README.md), then load the scheduler separately:

```bash
git clone --branch fix/atomic-semantic-compaction https://github.com/manuelcecchetto/pi-context-gc.git
cd pi-context-gc
npm ci --ignore-scripts
pi -e "$PWD/scheduler-only.ts"
```

Use Pi's standard text compaction or a separately compatible native backend. Do not also load another copy of the semantic scheduler. The repository's older bundled backend was not upgraded here; the newer native backend used in local activation is separate. Do not replace an existing newer vendor directory with this one.

A runtime update requires a fresh Pi process, not merely `/reload`. Extension-only changes can use `/reload` after the capable runtime is running. The ordinary `main` branch remains unchanged by this experimental branch.

## `compact_context`

Example:

```json
{
  "completed_phase": "Auth failure isolated and fixed; refresh-token behavior preserved.",
  "next_focus": "Implement and validate the database migration.",
  "keep": [
    "src/auth/session.ts validates issuer before cache lookup",
    "Public API contract is unchanged",
    "Migration must preserve existing refresh-token rows"
  ],
  "open_loops": [
    "Migration rollback path is not implemented"
  ],
  "ruled_out": [
    "Redis expiry was verified and is not the root cause",
    "JWT decoder behavior is correct"
  ],
  "verification": [
    "Auth unit suite passes",
    "Refresh-token integration scenario passes"
  ]
}
```

Required:

- `completed_phase`
- `next_focus`
- at least one `keep` item
- at least one `verification` item

The schema is deliberately bounded so the checkpoint cannot become another transcript. Put exact paths, symbols, decisions and evidence in it—not full files or logs.

The model is instructed not to call the tool merely because context is large, while hypotheses are unresolved, or immediately before its final answer.

## Safe boundary and continuation

The tool records intent and returns normally. At `turn_end`, the extension verifies that every call in the completed batch has exactly one finalized result, including the exact checkpoint call. It then calls `ctx.requestCompaction`; Pi consumes that request before the next provider call, using the normal `session_before_compact` backend and persistence pipeline.

The parent stays logically active during compaction. Background workers are neither cancelled nor awaited. Their completion messages follow Pi's normal queue semantics; they cannot start a competing parent run during replacement-history installation. The host persists one hidden canonical task/search/completion ledger before continuing. The extension does not send a second automatic resume prompt or rely on event-loop timing.

The ledger includes the completed phase, next focus, durable decisions, open loops, ruled-out paths and verification evidence. It remains present even when notifications are queued. Native state supplies broader continuity; neither mechanism guarantees lossless compaction.

With `autoResume=false`, Pi ends the current loop after persisting the ledger; this is not a global lock against later user input or independent extension triggers. Total failure pauses by default; `resumeOnFailure=true` opts into host-owned continuation without successful compaction. `/context-gc resume` explicitly re-materializes the full checkpoint. Ledger text does not falsely claim compaction succeeded on a recovery path.

## Commands

```text
/context-gc status
/context-gc retry
/context-gc resume
/context-gc cancel
```

A total compaction failure pauses by default to avoid retry loops. `resume` always reinjects the complete checkpoint, even when compaction was skipped or failed.

## Configuration

Global:

```text
~/.pi/agent/context-gc.json
```

Project-local, only for a trusted project:

```text
.pi/context-gc.json
```

```json
{
  "enabled": true,
  "autoResume": true,
  "resumeOnFailure": false,
  "notify": false
}
```

Project settings override global settings. Environment overrides:

```text
PI_CONTEXT_GC_ENABLED
PI_CONTEXT_GC_AUTO_RESUME
PI_CONTEXT_GC_RESUME_ON_FAILURE
PI_CONTEXT_GC_NOTIFY
```

Accepted booleans: `1/0`, `true/false`, `yes/no`, `on/off`.

The vendored native backend has its own optional configuration at:

```text
~/.pi/agent/extensions/pi-better-compaction/config.json
```

## Persistence and privacy

- The normal tool call/result participates in the pre-compaction context.
- Diagnostic checkpoint entries are stored in Pi JSONL but do not enter model context.
- The hidden resume message does enter model context.
- Native compaction persists an opaque encrypted item in the Pi compaction entry.
- Conversation context is sent to the configured OpenAI endpoint during native compaction.

## Validation

```bash
npm run check
```

See [the validation record](docs/VALIDATION.md) for the publication checks and remaining live-provider limitations. This is an experimental package, not a guarantee of model behavior or lower bills.

## Documentation

- `docs/BRIEF-IT.md` — full product/research brief
- `docs/ARCHITECTURE.md` — lifecycle, state machine and ownership
- `docs/ENGINEERING.md` — implementation invariants
- `docs/RESEARCH.md` — inspected source map and design decision
- `docs/TESTPLAN.md` — offline, live, overflow and quality tests
- `docs/VALIDATION.md` — validation record and limitations

## Scheduler-only mode

When another extension already owns native compaction:

```bash
pi -e /absolute/path/to/pi-context-gc/scheduler-only.ts
```

The scheduler never calls OpenAI directly and does not own credentials.

## License and attribution

MIT. Complete trailing tool-batch validation is adapted from `pi-midrun-compact` under MIT. `@lll9p/pi-better-compaction` remains an independently licensed runtime dependency. See `NOTICE.md`.
