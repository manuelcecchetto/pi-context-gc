# pi-context-gc

Agent-triggered semantic context garbage collection for Pi.

`pi-context-gc` gives the model one explicit tool, `compact_context`, for declaring that a coherent phase is complete and its raw working set is no longer useful. It records a bounded task/search/completion checkpoint, waits for the complete tool-result batch, enters Pi's standard compaction lifecycle with a requested forced-preparation hint, and resumes the task from a hidden canonical ledger. The `force: true` hint requires host support; stock Pi 0.84.2 ignores it, so its usual `keepRecentTokens` eligibility gate still applies. The package does not patch the host. See [compatibility and local changes](docs/COMPATIBILITY.md).

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
          Pi `context` safe boundary
                    |
              ctx.compact()
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
- Pi `@earendil-works/pi-coding-agent >=0.84.0`
- a working OpenAI Responses/Codex model for opaque native compaction

Other providers can still use Pi's normal compaction fallback.

## Install

```bash
pi install git:github.com/manuelcecchetto/pi-context-gc
```

Or clone and install locally:

```bash
cd /absolute/path/to/pi-context-gc
npm install
pi install "$PWD"
```

Project-local evaluation from the repository where the agent will work:

```bash
cd /absolute/path/to/target-repository
pi install -l /absolute/path/to/pi-context-gc
```

Restart Pi or run:

```text
/reload
```

Do not separately load `@lll9p/pi-better-compaction` when installing the package directory: the package manifest already loads its vendored extension resource. To combine only the scheduler with another `session_before_compact` backend, load `scheduler-only.ts` directly instead of installing the whole package.

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

## Why compaction starts from `context`

Calling `ctx.compact()` inside the tool would abort the active run before Pi had necessarily persisted that result and any sibling results. The tool only records intent.

On the next `context` event, the extension verifies that the tail contains one complete assistant/tool-result batch and that the exact checkpoint call has one finalized result. An `agent_settled` fallback reads persisted context entries and applies the same invariant.

This is the nearest public Pi equivalent of a mid-run post-tool boundary.

## Resume behavior

Pi manual compaction aborts the low-level run and does not continue it. After success, the extension waits one event-loop turn, verifies session/generation/checkpoint identity, checks `ctx.isIdle()` and `ctx.hasPendingMessages()`, then injects one hidden canonical checkpoint with `triggerTurn: true`.

The resume message includes:

- completed phase and current focus;
- durable state;
- open loops;
- ruled-out paths;
- verification/completion evidence.

The opaque compaction item carries broader provider-native continuity. The explicit ledger helps preserve the next working state, but its accuracy depends on the model; compaction is not guaranteed lossless.

If another turn already owns continuation, no duplicate turn is created. With `autoResume=false`, state remains resumable via `/context-gc resume`.

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
