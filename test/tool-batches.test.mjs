import test from "node:test";
import assert from "node:assert/strict";
import { getTrailingCompleteToolResultBatch } from "../dist/src/tool-batches.js";

function assistant(calls) {
  return {
    role: "assistant",
    content: calls.map(([id, name = "x"]) => ({
      type: "toolCall",
      id,
      name,
      arguments: {},
    })),
  };
}

function result(id, name = "x") {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    isError: false,
    content: [{ type: "text", text: "ok" }],
  };
}

test("accepts one complete tool batch", () => {
  const batch = getTrailingCompleteToolResultBatch([
    { role: "user", content: [] },
    assistant([["a", "compact_context"]]),
    result("a", "compact_context"),
  ]);
  assert.ok(batch);
  assert.equal(batch.assistantIndex, 1);
  assert.deepEqual([...batch.toolCallIds], ["a"]);
});

test("accepts a complete parallel batch independent of result order", () => {
  const batch = getTrailingCompleteToolResultBatch([
    assistant([["a"], ["b"], ["c", "compact_context"]]),
    result("b"),
    result("c", "compact_context"),
    result("a"),
  ]);
  assert.ok(batch);
  assert.deepEqual(new Set(batch.resultIds), new Set(["a", "b", "c"]));
});

test("rejects missing, duplicate, or unrelated results", () => {
  assert.equal(
    getTrailingCompleteToolResultBatch([assistant([["a"], ["b"]]), result("a")]),
    undefined,
  );
  assert.equal(
    getTrailingCompleteToolResultBatch([assistant([["a"], ["b"]]), result("a"), result("a")]),
    undefined,
  );
  assert.equal(
    getTrailingCompleteToolResultBatch([assistant([["a"]]), result("z")]),
    undefined,
  );
});

test("rejects a trailing non-tool message", () => {
  assert.equal(
    getTrailingCompleteToolResultBatch([
      assistant([["a"]]),
      result("a"),
      { role: "user", content: [{ type: "text", text: "steer" }] },
    ]),
    undefined,
  );
});
