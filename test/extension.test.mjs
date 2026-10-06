import test from "node:test";
import assert from "node:assert/strict";
import { createContextGcExtension } from "../dist/src/extension.js";

function harness() {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const entries = [];
  const sent = [];
  const callbacks = { value: undefined };
  const contextEntries = [];
  const pi = {
    on(name, handler) {
      const values = handlers.get(name) ?? [];
      values.push(handler);
      handlers.set(name, values);
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    appendEntry(type, data) { entries.push({ type, data }); return `entry-${entries.length}`; },
    sendMessage(message, options) { sent.push({ message, options }); },
  };
  const ctx = {
    cwd: "/tmp/project",
    hasUI: false,
    ui: { notify() {}, setStatus() {} },
    sessionManager: {
      getSessionId: () => "session-1",
      buildContextEntries: () => contextEntries,
    },
    isProjectTrusted: () => false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 100_000, contextWindow: 350_000, percent: 28.57 }),
    compact() { throw new Error("manual abort path must never be called"); },
    requestCompaction(options) {
      callbacks.value = options;
      return { accepted: true, cancel: () => true };
    },
  };
  createContextGcExtension()(pi);
  return { pi, ctx, handlers, tools, commands, entries, sent, callbacks, contextEntries };
}

async function emit(f, name, event) {
  for (const handler of f.handlers.get(name) ?? []) await handler(event, f.ctx);
}

const input = {
  completed_phase: "phase A complete",
  next_focus: "phase B",
  keep: ["decision one"],
  open_loops: ["finish migration"],
  ruled_out: ["old hypothesis"],
  verification: ["unit tests pass"],
};

function batch(id) {
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "compact_context", arguments: input }],
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "compact_context",
      isError: false,
      content: [{ type: "text", text: "queued" }],
    },
  ];
}

test("registers an agentic sequential tool and lifecycle handlers", async () => {
  const f = harness();
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  const tool = f.tools.get("compact_context");
  assert.ok(tool);
  assert.equal(tool.executionMode, "sequential");
  assert.ok(f.commands.has("context-gc"));
  assert.ok(f.handlers.has("turn_end"));
  assert.equal(f.handlers.has("context"), false);
  assert.equal(f.handlers.has("agent_settled"), false);
  assert.ok(f.handlers.has("input"));
});

test("real user input cancels a pending semantic checkpoint", async () => {
  const f = harness();
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  const tool = f.tools.get("compact_context");
  const first = await tool.execute("tool-1", input, undefined, undefined, f.ctx);
  assert.equal(first.details.accepted, true);

  await emit(f, "input", { type: "input", text: "change direction", source: "interactive" });
  assert.equal(f.entries.at(-1).data.status, "cancelled");

  const second = await tool.execute("tool-2", input, undefined, undefined, f.ctx);
  assert.equal(second.details.accepted, true);
});


test("partial tool batch cannot request compaction", async () => {
  const f = harness();
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
  await emit(f, "turn_end", { type: "turn_end", message: batch("tool-1")[0], toolResults: [] });
  assert.equal(f.callbacks.value, undefined);
});

test("complete batch compacts and resumes with the canonical ledger", async () => {
  const f = harness();
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  const tool = f.tools.get("compact_context");
  await tool.execute("tool-1", input, undefined, undefined, f.ctx);
  await emit(f, "turn_end", { type: "turn_end", message: batch("tool-1")[0], toolResults: batch("tool-1").slice(1) });

  assert.ok(f.callbacks.value);
  f.callbacks.value.onComplete({
    summary: "opaque placeholder",
    firstKeptEntryId: "entry-1",
    tokensBefore: 100_000,
    estimatedTokensAfter: 20_000,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(f.sent.length, 0);
  assert.equal(f.callbacks.value.autoResume, true);
  assert.match(f.callbacks.value.continuation.content, /phase B/);
  assert.match(f.callbacks.value.continuation.content, /old hypothesis/);
  assert.match(f.callbacks.value.continuation.content, /unit tests pass/);
});


test("unsupported hosts reject semantic GC without entering the aborting manual path", async () => {
  const f = harness();
  delete f.ctx.requestCompaction;
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  const result = await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
  assert.equal(result.details.accepted, false);
  assert.match(result.details.reason, /requestCompaction/);
  assert.equal(f.callbacks.value, undefined);
  assert.equal(f.entries.length, 0);
});


test("real input invalidates consumed requests even when host cancellation is too late", async () => {
  const f = harness();
  f.ctx.requestCompaction = (options) => {
    f.callbacks.value = options;
    return { accepted: true, cancel: () => false };
  };
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
  await emit(f, "turn_end", { message: batch("tool-1")[0], toolResults: batch("tool-1").slice(1) });
  const stale = f.callbacks.value;
  await emit(f, "input", { text: "new task", source: "interactive" });
  stale.onError(new Error("late failure"));
  assert.equal(f.entries.at(-1).data.status, "cancelled");
  const next = await f.tools.get("compact_context").execute("tool-2", input, undefined, undefined, f.ctx);
  assert.equal(next.details.accepted, true);
});

test("real input clears failed checkpoints so a new task can compact", async () => {
  const f = harness();
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
  await emit(f, "turn_end", { message: batch("tool-1")[0], toolResults: batch("tool-1").slice(1) });
  f.callbacks.value.onError(new Error("failure"));
  await emit(f, "input", { text: "new task", source: "interactive" });
  const next = await f.tools.get("compact_context").execute("tool-2", input, undefined, undefined, f.ctx);
  assert.equal(next.details.accepted, true);
});


test("extension notifications do not supersede checkpoint intent", async () => {
  const f = harness();
  await emit(f, "session_start", { type: "session_start", reason: "startup" });
  await f.tools.get("compact_context").execute("tool-1", input, undefined, undefined, f.ctx);
  await emit(f, "input", { text: "background result", source: "extension" });
  await emit(f, "turn_end", { message: batch("tool-1")[0], toolResults: batch("tool-1").slice(1) });
  assert.ok(f.callbacks.value);
});
