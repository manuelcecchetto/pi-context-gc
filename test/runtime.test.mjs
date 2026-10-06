import test from "node:test";
import assert from "node:assert/strict";
import {
  cancelPending,
  invalidateRuntime,
  supersedeCheckpoint,
  createRuntimeState,
  maybeStartAtTurnBoundary,
  resumeWithoutCompaction,
  scheduleCheckpoint,
  startCompaction,
} from "../dist/src/runtime.js";

const config = {
  enabled: true,
  autoResume: true,
  resumeOnFailure: false,
  notify: false,
};

function assistant(toolCallId) {
  return {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: toolCallId,
      name: "compact_context",
      arguments: {},
    }],
  };
}

function result(toolCallId) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "compact_context",
    isError: false,
    content: [{ type: "text", text: "queued" }],
  };
}

function fixture({ idle = true, pendingMessages = false } = {}) {
  const entries = [];
  const messages = [];
  const calls = { compact: 0, send: 0, cancel: 0 };
  let compactCallbacks;
  const pi = {
    appendEntry(type, data) { entries.push({ type, data }); },
    sendMessage(message, options) {
      calls.send += 1;
      messages.push({ message, options });
    },
  };
  const ctx = {
    cwd: "/tmp",
    hasUI: false,
    sessionManager: { getSessionId: () => "session-1" },
    getContextUsage: () => ({ tokens: 100_000, contextWindow: 350_000, percent: 28.57 }),
    compact() { throw new Error("manual abort path must never be called"); },
    requestCompaction(options) {
      calls.compact += 1;
      compactCallbacks = options;
      return { accepted: true, cancel() { calls.cancel++; return true; } };
    },
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
  };
  return {
    pi,
    ctx,
    entries,
    messages,
    calls,
    get callbacks() { return compactCallbacks; },
  };
}

const input = {
  completed_phase: "phase A",
  next_focus: "phase B",
  keep: ["decision 1"],
  ruled_out: ["old path"],
  verification: ["phase A acceptance criteria pass"],
};

test("schedules once and rejects a second pending checkpoint", () => {
  const f = fixture();
  const runtime = createRuntimeState();
  const first = scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  assert.equal(first.ok, true);
  assert.equal(runtime.phase, "pending");
  const second = scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-2", input);
  assert.equal(second.ok, false);
  assert.match(second.reason, /already pending/);
});

test("starts only at the complete batch containing the exact checkpoint call", () => {
  const f = fixture();
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);

  assert.equal(
    maybeStartAtTurnBoundary(f.pi, f.ctx, runtime, config, [assistant("other"), result("other")]),
    false,
  );
  assert.equal(f.calls.compact, 0);

  assert.equal(
    maybeStartAtTurnBoundary(f.pi, f.ctx, runtime, config, [assistant("tool-1"), result("tool-1")]),
    true,
  );
  assert.equal(f.calls.compact, 1);
  assert.equal(f.callbacks.force, true);
  assert.equal(runtime.phase, "compacting");
  assert.match(f.callbacks.customInstructions, /phase A/);
  assert.match(f.callbacks.customInstructions, /phase B/);
});

test("successful compaction delegates exactly one continuation and the full ledger to the host", async () => {
  const f = fixture({ idle: true });
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, config);

  f.callbacks.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
  f.callbacks.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(f.calls.send, 0);
  assert.equal(f.calls.compact, 1);
  assert.equal(f.callbacks.autoResume, true);
  assert.equal(runtime.phase, "idle");
  assert.match(f.callbacks.continuation.content, /phase B/);
  assert.match(f.callbacks.continuation.content, /old path/);
  assert.match(f.callbacks.continuation.content, /acceptance criteria pass/);
});


test("autoResume false keeps the completed checkpoint resumable", async () => {
  const f = fixture({ idle: true });
  const runtime = createRuntimeState();
  const manualConfig = { ...config, autoResume: false };
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, manualConfig);

  f.callbacks.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(f.calls.send, 0);
  assert.equal(runtime.phase, "resume-pending");
  assert.equal(f.callbacks.autoResume, false);
  assert.match(f.callbacks.continuation.content, /old path/);
  assert.equal(resumeWithoutCompaction(
    f.pi,
    f.ctx,
    runtime,
    manualConfig,
    "manual continuation after completed compaction",
  ), true);
  assert.equal(f.calls.send, 1);
  assert.match(f.messages[0].message.content, /old path/);
});

test("successful compaction does not create a second turn when Pi is not idle", async () => {
  const f = fixture({ idle: false });
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, config);
  f.callbacks.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.send, 0);
  assert.equal(runtime.phase, "idle");
});

test("failure pauses by default and explicit resume continues without compaction", () => {
  const f = fixture();
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, config);
  f.callbacks.onError(new Error("remote unavailable"));

  assert.equal(runtime.phase, "failed");
  assert.equal(f.calls.send, 0);
  assert.equal(resumeWithoutCompaction(f.pi, f.ctx, runtime, config, "test recovery"), true);
  assert.equal(f.calls.send, 1);
  assert.equal(runtime.phase, "idle");
  assert.match(f.messages[0].message.content, /old path/);
});

test("stale session prevents compaction", () => {
  const f = fixture();
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  f.ctx.sessionManager.getSessionId = () => "session-2";
  assert.equal(startCompaction(f.pi, f.ctx, runtime, config), false);
  assert.equal(f.calls.compact, 0);
  assert.equal(runtime.phase, "failed");
});


test("queued background notifications never suppress the canonical ledger or add a resume turn", () => {
  const f = fixture({ idle: false, pendingMessages: true });
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, config);
  f.callbacks.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
  assert.equal(f.calls.send, 0);
  assert.match(f.callbacks.continuation.content, /old path/);
  assert.equal(runtime.phase, "idle");
});

test("resumeOnFailure delegates recovery to host instead of creating a competing prompt", () => {
  const f = fixture();
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, { ...config, resumeOnFailure: true });
  assert.equal(f.callbacks.resumeOnFailure, true);
  f.callbacks.onError(new Error("remote unavailable"));
  assert.equal(f.calls.send, 0);
  assert.equal(runtime.phase, "idle");
  assert.doesNotMatch(f.callbacks.continuation.content, /compaction completed/);
});

test("cancel clears queued intent and rejects late callbacks", () => {
  const f = fixture();
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, config);
  assert.equal(cancelPending(f.pi, f.ctx, runtime, config, "new input"), true);
  f.callbacks.onComplete({ tokensBefore: 100_000 });
  assert.equal(f.calls.cancel, 1);
  assert.equal(runtime.phase, "idle");
  assert.equal(runtime.lastCompletedCheckpointId, undefined);
  assert.equal(f.entries.at(-1).data.status, "cancelled");
});

test("shutdown cancels queued host request and invalidates callbacks", () => {
  const f = fixture();
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, config);
  invalidateRuntime(runtime);
  f.callbacks.onError(new Error("late failure"));
  assert.equal(f.calls.cancel, 1);
  assert.equal(runtime.phase, "idle");
  assert.equal(runtime.lastError, undefined);
});

test("host refusal leaves a recoverable checkpoint without a legacy fallback", () => {
  const f = fixture();
  f.ctx.requestCompaction = () => ({ accepted: false, cancel: () => false });
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  assert.equal(startCompaction(f.pi, f.ctx, runtime, config), false);
  assert.equal(runtime.phase, "failed");
  assert.equal(f.calls.send, 0);
});


test("new user intent supersedes a paused checkpoint", () => {
  const f = fixture();
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, { ...config, autoResume: false });
  f.callbacks.onComplete({ tokensBefore: 100_000 });
  assert.equal(runtime.phase, "resume-pending");
  supersedeCheckpoint(f.pi, f.ctx, runtime, config);
  assert.equal(runtime.phase, "idle");
  assert.equal(runtime.checkpoint, undefined);
  assert.equal(f.entries.at(-1).data.status, "cancelled");
});


test("cancellation remains recoverable and never invokes failure auto-resume", () => {
  const f = fixture();
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, { ...config, resumeOnFailure: true });
  f.callbacks.onError(new DOMException("Compaction cancelled", "AbortError"));
  assert.equal(runtime.phase, "failed");
  assert.equal(f.calls.send, 0);
  assert.equal(runtime.checkpoint.toolCallId, "tool-1");
});
