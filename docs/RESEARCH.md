# Research notes and source map

Research date: 2026-08-20.

## Pi

Official repository: `earendil-works/pi`.

Current inspected package: `@earendil-works/pi-coding-agent` 0.84.2.

Relevant files:

- `packages/coding-agent/src/core/agent-session.ts`
  - manual `compact()` calls `abort()` first;
  - manual compaction does not retry or continue the interrupted turn;
  - `session_before_compact` can supply a custom compaction result;
  - threshold and overflow paths enter the same compaction lifecycle;
  - normal compaction checking is wired into post-run/pre-prompt handling.
- `packages/coding-agent/src/core/extensions/types.ts`
  - `context` fires before provider calls;
  - `ctx.compact()` is callback-based and non-awaiting;
  - `ctx.hasPendingMessages()` and `ctx.isIdle()` expose continuation state;
  - custom tools, custom entries and hidden custom messages are public APIs.
- `packages/coding-agent/src/core/session-manager.ts`
  - custom entries do not enter model context;
  - custom messages do;
  - `ReadonlySessionManager.buildContextEntries()` is available to extensions.
- `packages/coding-agent/docs/compaction.md`
  - Pi's default compactor is a structured textual summary;
  - default safety behavior uses reserve/keep-recent settings.
- `packages/coding-agent/docs/extensions.md`
  - TypeScript extensions load through jiti;
  - runtime dependencies must be declared in `dependencies`;
  - package manifests declare extension entrypoints.

Finding: Pi's public extension API can schedule compaction between tool batches, but cannot atomically replace history and continue the same low-level run.

## Codex

Official repository: `openai/codex`.

Relevant files:

- `codex-rs/core/src/session/turn.rs`
  - token status is checked inside the sampling loop;
  - when a follow-up is required, Codex can run inline auto-compaction and continue.
- `codex-rs/core/src/compact_remote.rs`
  - legacy remote compaction installs replacement history;
  - older behavior loses some harness metadata.
- `codex-rs/core/src/compact_remote_v2.rs`
  - remote compaction v2 emits exactly one compaction item;
  - builds a retained-message tail plus the opaque compaction item;
  - preserves selected harness metadata;
  - retains user/developer/system and bounded agent messages, not ordinary raw tool outputs;
  - installs compacted history and recomputes token usage before continuing.

Finding: Codex's compaction primitive is fundamentally stronger than Pi extension-level `ctx.compact()` because it is inline and atomic.

## OpenAI Responses

Official API and product documentation:

- `POST /responses/compact` returns compacted response items including an opaque encrypted compaction item;
- the request accepts `instructions`;
- the artifact is intended for repeated continuation of long tool-heavy workflows;
- `previous_response_id` provides continuity but is not itself compaction.

Finding: provider-native opaque compaction is preferable to a scheduler-owned textual summary when preserving latent task state is important. It remains loss-aware rather than guaranteed lossless.

## Existing Pi extensions evaluated

### `@lll9p/pi-better-compaction`

Selected default backend.

- supports current Pi versions (`>=0.80.0` in its package metadata);
- uses `/responses/compact` for `openai-responses` and `openai-codex-responses`;
- persists and replays the opaque compacted window;
- accepts Pi manual/threshold/overflow lifecycle events;
- fails open to Pi's default compactor.

### `algal/pi-openai-server-compaction`

Architecturally closer to Codex trigger behavior, but its inspected compatibility range was pinned to an older Pi 0.80.x window. It was not selected as the default for Pi 0.84.2.

### `leonfox28/pi-midrun-compact`

Demonstrates safe scheduling from `context` and complete trailing tool-batch validation. Its deterministic token threshold was deliberately not adopted. The batch validator was adapted under MIT with attribution.

## Implementation decision

Build a separate scheduler package that composes the proven native backend:

```text
pi-context-gc
  package manifest    bundled native backend + scheduler
  index.ts             scheduler entrypoint
  scheduler-only.ts    explicit scheduler-only alias
```

This isolates the research variable: **semantic scheduling**. It avoids rewriting native compaction or Pi overflow recovery while remaining replaceable when a more faithful Codex-v2 backend becomes compatible.
