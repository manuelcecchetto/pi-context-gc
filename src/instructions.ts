import type { ContextCheckpoint } from "./types.ts";

function section(title: string, values: readonly string[] | undefined): string {
  if (!values || values.length === 0) return `${title}: none recorded`;
  return `${title}:\n${values.map((value) => `- ${value}`).join("\n")}`;
}

/**
 * Guidance is intentionally a handoff contract, not a replacement summary.
 * The native compactor still decides the opaque representation.
 */
export function buildCompactionInstructions(checkpoint: ContextCheckpoint): string {
  const { input } = checkpoint;
  return [
    "This compaction was requested at a semantic phase boundary by the active agent.",
    "Preserve the task state needed to continue accurately after compaction, including user intent, acceptance criteria, exact identifiers and paths, decisions, invariants, edits already made, unresolved dependencies, verification state, and negative search state.",
    "Raw tool logs, superseded file snapshots, repeated reads, completed exploration, and resolved hypotheses may be discarded unless they are required to support a retained decision or an unresolved issue.",
    "Do not reinterpret the task as complete and do not reopen completed work without new evidence.",
    "",
    `Completed phase: ${input.completed_phase}`,
    `Next focus: ${input.next_focus}`,
    section("Durable state to retain", input.keep),
    section("Open loops", input.open_loops),
    section("Investigated or ruled out", input.ruled_out),
    section("Verification already performed", input.verification),
  ].join("\n");
}

export function buildResumeMessage(checkpoint: ContextCheckpoint, compacted?: boolean): string {
  const { input } = checkpoint;
  return [
    "[pi-context-gc/task-state-v1]",
    compacted === false
      ? "Continuing without successful compaction. This is the canonical live task/search checkpoint for the next phase."
      : "This is the canonical live task/search checkpoint for the next phase.",
    `Completed phase: ${input.completed_phase}`,
    `Current focus: ${input.next_focus}`,
    section("Durable state", input.keep),
    section("Open loops", input.open_loops),
    section("Investigated or ruled out", input.ruled_out),
    section("Verification state", input.verification),
    "Treat the completed phase as closed unless new evidence requires reopening it. Do not redo prior exploration merely because its raw artifacts are no longer visible.",
  ].join("\n");
}
