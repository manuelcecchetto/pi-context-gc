import test from "node:test";
import assert from "node:assert/strict";
import {
  createRuntimeState,
  maybeStartAtContextBoundary,
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
  const calls = { compact: 0, send: 0 };
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
    compact(options) {
      calls.compact += 1;
      compactCallbacks = options;
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
    maybeStartAtContextBoundary(f.pi, f.ctx, runtime, config, [assistant("other"), result("other")]),
    false,
  );
  assert.equal(f.calls.compact, 0);

  assert.equal(
    maybeStartAtContextBoundary(f.pi, f.ctx, runtime, config, [assistant("tool-1"), result("tool-1")]),
    true,
  );
  assert.equal(f.calls.compact, 1);
  assert.equal(f.callbacks.force, true);
  assert.equal(runtime.phase, "compacting");
  assert.match(f.callbacks.customInstructions, /phase A/);
  assert.match(f.callbacks.customInstructions, /phase B/);
});

test("successful compaction resumes exactly once when Pi is idle", async () => {
  const f = fixture({ idle: true });
  const runtime = createRuntimeState();
  scheduleCheckpoint(f.pi, f.ctx, runtime, "tool-1", input);
  startCompaction(f.pi, f.ctx, runtime, config);

  f.callbacks.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
  f.callbacks.onComplete({ tokensBefore: 100_000, estimatedTokensAfter: 20_000 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(f.calls.send, 1);
  assert.equal(runtime.phase, "idle");
  assert.match(f.messages[0].message.content, /phase B/);
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
