/*
 * Complete-batch validation is adapted from pi-midrun-compact (MIT),
 * copyright 2026 pi-midrun-compact contributors.
 */
import type { CompleteToolBatch } from "./types.ts";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function roleOf(message: unknown): string | undefined {
  return nonEmptyString(asRecord(message)?.role);
}

function assistantCallIds(message: unknown): Set<string> | undefined {
  const assistant = asRecord(message);
  if (assistant?.role !== "assistant" || !Array.isArray(assistant.content)) return undefined;

  const ids = new Set<string>();
  for (const content of assistant.content) {
    const block = asRecord(content);
    if (block?.type !== "toolCall") continue;

    const id = nonEmptyString(block.id);
    const name = nonEmptyString(block.name);
    const args = block.arguments;
    const argsAreValid =
      typeof args === "string" ||
      (typeof args === "object" && args !== null && !Array.isArray(args));
    if (!id || !name || !argsAreValid || ids.has(id)) return undefined;
    ids.add(id);
  }

  return ids.size > 0 ? ids : undefined;
}

function resultCallId(message: unknown): string | undefined {
  const result = asRecord(message);
  if (result?.role !== "toolResult") return undefined;
  if (!nonEmptyString(result.toolName)) return undefined;
  if (!Array.isArray(result.content) || typeof result.isError !== "boolean") return undefined;
  return nonEmptyString(result.toolCallId);
}

/**
 * Return the trailing assistant/tool-result batch only when every call has one
 * finalized result and there are no duplicates. This is the safe point at
 * which the session history contains the complete batch.
 */
export function getTrailingCompleteToolResultBatch(
  messages: readonly unknown[],
): CompleteToolBatch | undefined {
  if (roleOf(messages.at(-1)) !== "toolResult") return undefined;

  const resultIds = new Set<string>();
  let index = messages.length - 1;
  while (index >= 0 && roleOf(messages[index]) === "toolResult") {
    const id = resultCallId(messages[index]);
    if (!id || resultIds.has(id)) return undefined;
    resultIds.add(id);
    index -= 1;
  }

  if (index < 0 || roleOf(messages[index]) !== "assistant") return undefined;
  const callIds = assistantCallIds(messages[index]);
  if (!callIds || callIds.size !== resultIds.size) return undefined;

  for (const id of callIds) {
    if (!resultIds.has(id)) return undefined;
  }

  return {
    assistantIndex: index,
    toolCallIds: callIds,
    resultIds,
  };
}
